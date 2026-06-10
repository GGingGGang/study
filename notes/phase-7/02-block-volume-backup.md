# Block Volume Backup (Terraform)

## 1. Why — 왜 쓰는가

k8s의 PV(PersistentVolume) 데이터 보호. Vault secret, Jenkins job history, Prometheus 메트릭, Kafka 메시지, Redis AOF 등이 모두 Block Volume에 저장됨. 손실 시 운영 마비.

**Velero만으로 부족한 이유**:
- Velero는 k8s manifest + 옵션으로 PV 백업 (file system backup 또는 CSI snapshot)
- Velero file system backup은 Object Storage 20GB 경합 + 느림
- CSI snapshot은 별도 quota — OCI Block Volume Backup의 5개 한도 사용
- 본 프로젝트는 **OCI native Block Volume Backup**을 Terraform으로 관리해서 명확한 정책 적용

**Always Free Block Volume Backup 한도**:
- **5개 backup** (volumes 합쳐서)
- Backup은 Object Storage 사용하지만 **별도 quota** — Always Free 20GB와 분리
- Volume 크기와 무관 (50GB 5개 = 250GB 백업 가능)

## 2. Architecture — 어떻게 구성되는가

**OCI Block Volume Backup 종류**:
- **Manual backup**: 사용자 명시적 생성
- **Policy-based backup**: 정해진 일정에 자동
- **Backup type**: 
  - `FULL`: 전체 snapshot
  - `INCREMENTAL`: 이전 백업과의 차이만

**Terraform 리소스**:
- `oci_core_volume_backup_policy`: 백업 정책 정의 (schedule + retention)
- `oci_core_volume_backup_policy_assignment`: 정책을 volume에 연결
- `oci_core_volume_backup`: 수동 백업 (선택)

**복원**:
- Backup으로부터 **새 Block Volume 생성**
- 새 volume을 PVC로 mount (manual k8s operation 필요)
- 또는 Velero가 자동 처리 (CSI snapshot 활용 시)

## 3. Mechanism — 어떻게 돌아가는가

**Policy-based backup 흐름**:
1. `oci_core_volume_backup_policy`에 schedule 정의 (예: 매일 03:00 UTC)
2. `oci_core_volume_backup_policy_assignment`로 volume에 연결
3. OCI가 정해진 시간에 자동 snapshot 생성
4. retention 기간 지난 백업 자동 삭제
5. 5개 한도 도달 시 가장 오래된 것 자동 삭제 (FIFO)

**Restore 흐름**:
1. OCI Console → Block Volume → Backups → "Create Volume" 클릭
2. 새 Block Volume 생성 (다른 이름)
3. k8s에서 새 PVC 생성, 새 PV를 binding (manual 또는 CSI driver)
4. Pod restart해서 새 PVC mount
5. 데이터 검증

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Block Volume Backup 의존 관계.

- **Terraform** — 정책 + assignment 관리
- **OCI Block Volume CSI driver** — k8s PV ↔ OCI volume 매핑
- **Velero** — CSI snapshot 활용 시 Velero가 트리거 (Volume Backup quota 공유)
- **Phase 4 PV 분배** — Vault/Prometheus/Jenkins/Kafka/Redis 5개 우선순위 PV에 적용

**5개 한도 우선순위** (Phase 4와 일관):
1. **Vault** — secret 손실 시 모든 앱 secret 재설정 필요
2. **Prometheus** — Thanos 업로드 전 직전 2시간 메트릭 버퍼
3. **Jenkins** — controller home, build history
4. **Strimzi Kafka** — 단일 broker, 손실 시 토픽 데이터 소멸
5. **Redis AOF** — 캐시 재구축 비용

**백업 제외**:
- Tempo (24h trace, 손실 OK)
- Loki index (Object Storage chunk가 source of truth)

## 5. Usage — 어떻게 쓰는가

**Backup policy 정의** (Terraform):

```hcl
resource "oci_core_volume_backup_policy" "daily" {
  compartment_id = var.compartment_ocid
  display_name   = "daily-backup-7d-retention"
  
  schedules {
    backup_type       = "INCREMENTAL"
    period            = "ONE_DAY"
    hour_of_day       = 3                # UTC 03:00
    retention_seconds = 604800           # 7 days (60*60*24*7)
    time_zone         = "UTC"
  }
  
  # 주 1회 FULL (선택)
  schedules {
    backup_type       = "FULL"
    period            = "ONE_WEEK"
    day_of_week       = "SUNDAY"
    hour_of_day       = 3
    retention_seconds = 2419200          # 28 days
    time_zone         = "UTC"
  }
  
  # Triggered backup도 가능 (이벤트 기반)
}
```

**Volume에 정책 연결**:

```hcl
resource "oci_core_volume_backup_policy_assignment" "vault_pv" {
  asset_id  = oci_core_volume.vault_pv.id   # 또는 PV에 연결된 volume의 OCID
  policy_id = oci_core_volume_backup_policy.daily.id
}
```

**PVC로 생성된 OCI Block Volume의 OCID 조회**:

```bash
# k8s PV에서 volumeHandle 추출
kubectl get pv -o yaml | grep volumeHandle

# OCID가 volumeHandle에 있음 (ocid1.volume.oc1...)
```

**Terraform으로 정책 적용** (단점: PV가 dynamic 생성이라 OCID 사전 모름):
- 대안 1: Manual `oci_core_volume_backup_policy_assignment` apply (PV 생성 후)
- 대안 2: OCI CLI 자동화 script
- 대안 3: **OCI tag 기반 policy** — volume에 tag 붙이면 자동 연결

**Tag 기반 backup policy** (가장 깔끔):

```hcl
# Tag namespace + tag
resource "oci_identity_tag_namespace" "backup" {
  compartment_id = var.compartment_ocid
  name           = "backup"
  description    = "Backup policies"
}

resource "oci_identity_tag" "policy" {
  tag_namespace_id = oci_identity_tag_namespace.backup.id
  name             = "policy"
}

# OCI defined tag policy로 자동 연결
```

PVC manifest에 OCI tag annotation:
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: vault-data
  namespace: vault
  annotations:
    oci.oraclecloud.com/initial-defined-tags-override: |
      {
        "backup": {"policy": "daily"}
      }
```

**복원 (수동)**:

```bash
# 1. OCI Console에서 backup 선택 → "Create Volume" → 새 volume 생성
# 2. k8s PV manifest 새로 작성 (volumeHandle = 새 OCID)
apiVersion: v1
kind: PersistentVolume
metadata:
  name: vault-data-restored
spec:
  capacity: { storage: 10Gi }
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: oci-bv
  csi:
    driver: blockvolume.csi.oraclecloud.com
    volumeHandle: ocid1.volume.oc1.iad.<NEW-OCID>
    fsType: ext4

# 3. PVC가 새 PV 사용하도록 binding
# 4. Pod restart
```

## 6. Configuration — 어떤 설정이 있는가

**Schedule period 옵션**:
- `ONE_HOUR`: 시간 단위 (자주 변경되는 volume)
- `ONE_DAY`: 일 단위 (본 프로젝트 표준)
- `ONE_WEEK`: 주 단위
- `ONE_MONTH`, `ONE_YEAR`: 더 긴 주기

**Backup type**:
- `FULL`: 전체 snapshot (큼, 안전)
- `INCREMENTAL`: 이전 백업 대비 차이만 (작음, 빠름, 의존)
- 본 프로젝트는 일일 INCREMENTAL + 주간 FULL 조합 권장

**Retention**:
- `retention_seconds`: 보관 기간
- 5개 한도 도달 시 가장 오래된 것 자동 삭제

**Tag 기반 vs Assignment 기반**:
- Tag 기반: 새 volume 자동으로 정책 적용. Dynamic PV에 적합. 본 프로젝트 권장.
- Assignment 기반: 명시적 연결. Terraform으로 관리. 정적 volume에 적합.

**lifecycle prevent_destroy** (Block Volume에도 적용):

```hcl
resource "oci_core_volume" "vault_pv" {
  # ...
  lifecycle {
    prevent_destroy = true
  }
}
```

## 7. Compatibility — 어떤 호환성이 요구되는가

- **OCI Block Volume Backup**: 모든 region 지원
- **OCI Terraform provider 5.x+**
- **OCI Block Volume CSI driver**: PV → OCI volume 매핑
- **Backup 5개 한도**: volumes 합쳐서 (volume별 아님)
- **Cross-region copy**: 별도 비용

## 8. 면접 예상 질문 & 답변

**Q1. 5개 한도에서 PV가 7개 있는데 어떻게 처리해요?**
> 우선순위 결정. (1) Vault — secret 손실 = 모든 앱 secret 재설정, (2) Prometheus — 직전 2시간 메트릭 버퍼, (3) Jenkins — build history + controller home, (4) Strimzi Kafka — 단일 broker 토픽 데이터, (5) Redis AOF — 캐시 재구축 비용. 백업 제외: Tempo(24h trace 손실 OK), Loki index(Object Storage chunk가 source of truth). 면접 답변: "비즈니스 영향 + 복구 비용 기준 우선순위, production은 cross-region 복제로 한도 자체 회피".

**Q2. Block Volume Backup quota와 Object Storage quota 차이는?**
> 별도입니다. Block Volume Backup은 OCI 내부 별도 quota — Always Free 5개. Object Storage 20GB와 분리. 즉 Block Volume Backup 5개 × 50GB = 250GB까지 백업해도 Object Storage 20GB는 그대로 사용 가능. 본 프로젝트가 Thanos + Loki + Velero + Vault snapshot으로 Object Storage 20GB 경합하지만 Block Volume Backup은 그것과 무관. 이 분리 인지가 자원 계산의 핵심.

**Q3. Tag 기반 backup policy가 뭐예요?**
> OCI defined tag 기반 자동 연결입니다. Volume에 특정 tag(예: `backup.policy=daily`) 붙이면 OCI가 자동으로 매칭되는 backup policy 적용. 본 프로젝트의 k8s PVC는 dynamic 생성이라 OCID를 Terraform에서 사전 모름 — assignment 기반은 매번 PV 생성 후 수동 연결 필요. Tag 기반은 PVC annotation으로 OCI tag 자동 부여 → backup policy 자동 적용. GitOps와 정합.

**Q4. Incremental backup의 의존성 위험은?**
> Incremental은 이전 백업과의 차이만 저장 — 이전 백업이 사라지면 incremental도 복원 불가. 그래서 본 프로젝트는 (1) 일일 INCREMENTAL + (2) 주간 FULL 조합. FULL이 baseline 역할, INCREMENTAL이 daily snapshot. 7일 retention 안에 항상 FULL 1개 + INCREMENTAL 6개 존재. 어느 시점 복원이든 FULL + 해당 시점까지 INCREMENTAL 체인으로 가능.

**Q5. 복원이 새 volume 생성인데 PVC binding을 어떻게 해요?**
> 수동 작업입니다. (1) OCI Console에서 backup → "Create Volume"으로 새 volume 생성, (2) k8s PV manifest 새로 작성 (volumeHandle = 새 OCID), (3) 기존 PVC를 삭제 후 새 PV가 binding 되도록 다시 생성, 또는 PVC의 `volumeName` 명시. (4) Pod restart로 새 PV mount. 본 프로젝트 runbook에 step-by-step 절차 명시. Velero CSI snapshot 사용 시 이 과정이 자동화되지만 본 프로젝트는 OCI 직접 복원이 더 단순.

**Q6. Block Volume Backup vs Velero file-system backup 어느 게 나아요?**
> 보완 관계. Block Volume Backup은 (1) OCI native, snapshot 빠름, (2) PV 단위 통째로 백업, (3) Block Volume 5개 한도 사용. Velero file-system backup은 (1) Object Storage 사용 (별도 quota), (2) 파일 단위 복원 가능, (3) cross-region 복원 가능 (S3 호환), (4) 느림. 본 프로젝트는 PV는 Block Volume Backup (5개), k8s 매니페스트는 Velero Object Storage. 각자 강점 활용.

**Q7. Tempo PV를 backup 제외한 이유는?**
> Trace 데이터는 디버깅 용도 + 24h retention이라 손실 영향 작음. Block Volume Backup 5개 한도에서 더 critical한 데이터(Vault, Prometheus 등)에 우선 할당하는 게 우선순위 결정. Tempo 손실 시 영향: 24h 이내 trace 못 봄 → 디버깅 불편하지만 비즈니스 영향 0. 본 프로젝트는 의도적 trade-off로 명시. 면접에서 "모든 데이터를 똑같이 백업하지 않고 비즈니스 영향 기반 우선순위 결정" narrative.

**Q8. prevent_destroy를 Block Volume에도 적용하는 이유는?**
> `terraform destroy` 실수 방지 + 의도치 않은 volume 삭제 차단. Block Volume이 삭제되면 (1) 그 volume의 모든 데이터 즉시 소멸, (2) backup은 남아있지만 복원 절차 필요. prevent_destroy + OCI 자체 `is_hydrated` 같은 보호와 결합. 본 프로젝트는 production-critical volume(Vault, Kafka, Redis, Jenkins, Prometheus)에 모두 적용.

**Q9. 백업 실행이 production 영향 있나요?**
> Snapshot 방식이라 영향 매우 작음. OCI는 Copy-on-Write 기반 snapshot이라 백업 시작 시점에 instant snapshot 생성 + 백그라운드에서 데이터 복사. Production volume의 read/write에 영향 거의 없음 (microsecond 단위 lock). 본 프로젝트는 새벽 시간대(UTC 03:00 = KST 12:00) 백업으로 영향 최소화하지만 실제로는 다른 시간대도 무관.

**Q10. RTO/RPO 어떻게 정해요?**
> 컴포넌트별 다름. (1) Vault: RTO 5분(PV 정상) ~ 15분(PV 손상, backup 복원), RPO 24시간(일일 백업). (2) Prometheus: RTO 15분, RPO 2시간(Thanos sidecar 업로드 주기). (3) Jenkins: RTO 20분, RPO 24시간. (4) Kafka: RTO 15분, RPO는 손실 가능(단일 broker 한계). (5) Redis: RTO 5분(AOF 복원 자동), RPO 1초(AOF everysec). Phase 7 표에 정리. 면접에서 각 컴포넌트별 RTO/RPO 즉답할 수 있어야 합니다.
