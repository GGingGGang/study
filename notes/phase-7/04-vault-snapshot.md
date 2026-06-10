# Vault/OpenBao Raft Snapshot 자동화

## 1. Why — 왜 쓰는가

Vault/OpenBao의 Raft storage는 자체 snapshot 형식. **Velero로 커버 못 하는 영역** — Velero는 PV의 file system을 백업하지만 Vault Raft data는 active write 상태라 file-level backup이 corrupt 위험.

**Vault PV backup의 함정**:
- Raft data가 매 secret 접근마다 변경 — file system snapshot이 inconsistent
- Velero CSI snapshot도 같은 위험
- Vault 자체 snapshot API(`vault operator raft snapshot save`)가 atomic + consistent 보장

**OSS Vault / OpenBao 한계**:
- **Auto-snapshot 미지원** — Vault Enterprise 전용 (`/sys/storage/raft/snapshot-auto`)
- OSS는 CronJob 또는 외부 도구로 우회

**대체재**:
- **Vault Enterprise**: $200/node/month, auto-snapshot 내장
- **CronJob + `vault operator raft snapshot save`**: 가장 단순, 직접 작성
- **OpenBao Raft Snapshot Agent**: 전용 도구, Helm chart 제공. 본 프로젝트 권장.
- **adfinis/vault-raft-backup-agent**: Vault/OpenBao 공통 community tool

## 2. Architecture — 어떻게 구성되는가

**Snapshot 파일 구조**:
- 단일 binary file (`.snap`)
- Raft state + Vault data 모두 포함
- **Unseal key로 암호화** — snapshot만 있으면 복원 불가, unseal key도 필요
- 일반적으로 10-100MB 수준 (secret 수에 비례)

**OpenBao Raft Snapshot Agent**:
- Helm chart로 설치
- CronJob 또는 sidecar 모드
- 여러 backend 지원: local, S3, GCS, Azure Blob
- 본 프로젝트는 S3 호환(OCI Object Storage)

**보안 추가 layer** (권장):
- Snapshot 자체는 Vault unseal key로 암호화됨
- 추가로 OCI Vault Transit으로 한 번 더 암호화
- 이유: unseal key + snapshot 동시 유출 시 데이터 노출 → 추가 암호화로 압축

## 3. Mechanism — 어떻게 돌아가는가

**Snapshot 생성 흐름**:
1. CronJob 또는 Agent가 schedule에 트리거
2. SA token으로 Vault에 인증 (Kubernetes auth method)
3. `/sys/storage/raft/snapshot` API 호출
4. Vault가 atomic snapshot 생성 → binary stream 반환
5. Agent가 OCI Object Storage에 업로드 (S3 API)
6. retention 정책으로 오래된 snapshot 삭제

**Restore 흐름**:
1. Object Storage에서 snapshot 다운로드
2. `vault operator raft snapshot restore -force <snapshot.snap>`
3. Vault가 현재 Raft state를 snapshot의 state로 교체
4. unseal key 필요 (snapshot 시점의 키와 같아야 함)
5. 복원 후 모든 secret + policy + auth method 복원

**주의**: snapshot restore는 destructive — 현재 state 모두 덮어씀. 복원 전 추가 백업 권장.

## 4. Integration — 어떻게 연결하는가

- **Vault/OpenBao** — snapshot 대상
- **OCI Object Storage** — snapshot 저장. 2GB 할당 (20GB 중)
- **OCI Customer Secret Key** — S3 호환 인증 (Velero와 같은 패턴)
- **OCI Vault Transit** (선택) — snapshot 추가 암호화
- **Prometheus alert** — snapshot 실패 시 즉시 알림

**Velero와 역할 분리**:
- Velero: vault namespace의 매니페스트, ServiceAccount, RBAC 등 백업 (PV 제외)
- Vault snapshot: Vault 데이터 자체 백업
- 두 도구가 함께 작동해서 Vault 완전 복구 가능

## 5. Usage — 어떻게 쓰는가

**OpenBao Raft Snapshot Agent 설치** (Helm):

```bash
helm install openbao-snapshot openbao/openbao-snapshot-agent \
  --namespace vault \
  --version 0.x \
  -f snapshot-values.yaml
```

snapshot-values.yaml:
```yaml
vault:
  address: "http://vault.vault.svc:8200"
  auth:
    method: kubernetes
    role: snapshot-agent
    serviceAccount: openbao-snapshot

snapshot:
  schedule: "0 18 * * *"            # UTC 18:00 = KST 03:00
  retention: 7                       # 7개 보관

storage:
  type: s3
  s3:
    endpoint: https://<namespace>.compat.objectstorage.ap-tokyo-1.oraclecloud.com
    bucket: vault-snapshots
    prefix: openbao/
    region: ap-tokyo-1
    forcePathStyle: true
    accessKey:
      secretName: oci-customer-secret
      key: access_key
    secretKey:
      secretName: oci-customer-secret
      key: secret_key
```

**Vault 측 설정** (snapshot agent용 role 생성):

```bash
# Snapshot policy
cat > snapshot-policy.hcl <<EOF
path "sys/storage/raft/snapshot" {
  capabilities = ["read"]
}
EOF

vault policy write snapshot snapshot-policy.hcl

# Kubernetes auth role
vault write auth/kubernetes/role/snapshot-agent \
  bound_service_account_names=openbao-snapshot \
  bound_service_account_namespaces=vault \
  policies=snapshot \
  ttl=1h
```

**대안 — CronJob 직접 작성**:

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: vault-snapshot
  namespace: vault
spec:
  schedule: "0 18 * * *"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: openbao-snapshot
          containers:
          - name: snapshot
            image: openbao/openbao:2.5.0
            env:
            - name: VAULT_ADDR
              value: "http://vault.vault.svc:8200"
            - name: OCI_ENDPOINT
              value: "https://<namespace>.compat.objectstorage.ap-tokyo-1.oraclecloud.com"
            command:
            - /bin/sh
            - -c
            - |
              # Vault 인증
              vault login -method=kubernetes role=snapshot-agent
              
              # Snapshot 생성
              vault operator raft snapshot save /tmp/vault-$(date +%Y%m%d-%H%M%S).snap
              
              # OCI Object Storage 업로드 (aws CLI with S3 호환)
              aws s3 cp /tmp/vault-*.snap \
                s3://vault-snapshots/openbao/ \
                --endpoint-url=$OCI_ENDPOINT
              
              # 7일 지난 snapshot 삭제
              # ... (별도 cleanup 로직 또는 OCI lifecycle policy)
          restartPolicy: OnFailure
```

**Manual snapshot 생성** (큰 변경 전):

```bash
kubectl exec -it vault-0 -n vault -- \
  vault operator raft snapshot save /tmp/pre-upgrade.snap

kubectl cp vault/vault-0:/tmp/pre-upgrade.snap ./pre-upgrade.snap
```

**Restore**:

```bash
# 1. Object Storage에서 snapshot 다운로드
aws s3 cp s3://vault-snapshots/openbao/vault-20260520-180000.snap ./vault.snap \
  --endpoint-url=https://<namespace>.compat.objectstorage.ap-tokyo-1.oraclecloud.com

# 2. Pod에 복사
kubectl cp ./vault.snap vault/vault-0:/tmp/restore.snap

# 3. Restore (destructive!)
kubectl exec -it vault-0 -n vault -- \
  vault operator raft snapshot restore -force /tmp/restore.snap

# 4. 검증
vault status
vault secrets list
```

## 6. Configuration — 어떤 설정이 있는가

**Schedule 권장**:
- Daily: `"0 18 * * *"` UTC 18:00 (KST 03:00)
- Critical secret 변경 후: manual snapshot 추가

**Retention**:
- 일반: 7일 (7개 snapshot)
- 중요 변경 시 manual snapshot은 30일 별도 보관

**Object Storage 보안**:
- IAM Policy로 vault pod의 Dynamic Group만 vault-snapshots bucket write
- 운영자는 read만 (audit 통해서만)
- Bucket versioning 활성화 (실수로 snapshot 삭제 보호)

**추가 암호화** (OCI Vault Transit, 권장):
- Snapshot upload 전 Vault Transit으로 암호화
- 복원 시 Transit으로 복호화
- 두 layer 암호화로 unseal key + snapshot 동시 유출 시에도 데이터 보호

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Vault 1.15+ / OpenBao 2.x+** (2026-05 권장)
- **Raft storage** 필수 (다른 storage backend는 다른 backup 방식)
- **OCI Object Storage**: S3 호환 + Customer Secret Key
- **Kubernetes auth method**: SA token 기반

## 8. 면접 예상 질문 & 답변

**Q1. Velero로 Vault PV 백업 안 하고 따로 snapshot 하는 이유는?**
> Vault Raft data는 매 secret 접근마다 변경되는 active state입니다. Velero의 file-system backup이나 CSI snapshot은 file system 단위라 백업 시점에 Raft state가 inconsistent할 수 있어서 복원 시 corrupt 위험. Vault 자체 snapshot API(`vault operator raft snapshot save`)는 atomic + consistent를 보장 — Raft 합의 알고리즘 수준에서 일관된 상태 캡처. 그래서 Vault 데이터는 Vault native snapshot, 매니페스트는 Velero로 역할 분리.

**Q2. Vault Enterprise auto-snapshot이 뭐고 왜 OSS는 안 돼요?**
> Vault Enterprise는 `/sys/storage/raft/snapshot-auto` endpoint를 제공해서 Vault 자체가 정기 snapshot을 S3/GCS/Azure에 업로드. 운영자 작업 0. OSS는 이 endpoint 없음 — HashiCorp가 Enterprise 차별화 기능으로 분리. OpenBao도 OSS라 동일 한계. 우회: (1) CronJob + `vault operator raft snapshot save` 직접 호출, (2) OpenBao Raft Snapshot Agent 같은 community tool. 본 프로젝트는 후자 권장 — 운영 검증된 도구.

**Q3. Snapshot restore가 destructive라 어떻게 안전하게 해요?**
> Restore 절차에 추가 백업 step 강제. (1) Restore 직전 현재 Vault state의 임시 snapshot 생성 — 복원 실패 시 원복용, (2) Restore는 별도 Vault instance에서 먼저 검증 (가능하면), (3) Production restore는 maintenance window 안에서, (4) Restore 후 즉시 `vault secrets list` + 핵심 secret read로 검증. 본 프로젝트의 restore runbook은 5단계 step + 검증 명령 명시.

**Q4. Snapshot은 unseal key로 암호화돼 있는데 추가 암호화 왜 필요해요?**
> 보안 압축. unseal key + snapshot 동시 유출 시나리오 방어. 예: Object Storage bucket이 misconfiguration으로 public 노출 + Vault 운영자 노트북 탈취. 두 정보 동시 확보 시 모든 secret 노출. OCI Vault Transit으로 한 번 더 암호화하면 Transit key까지 필요 → 3개 정보 동시 유출이 필요해 폭발 반경 축소. 본 프로젝트는 추가 암호화 적용 + Transit key는 OCI IAM으로 별도 보호.

**Q5. CronJob 직접 작성 vs OpenBao Snapshot Agent 어느 게 나아요?**
> OpenBao Snapshot Agent 권장. (1) 운영 검증 — error handling, retry 로직, cleanup 포함, (2) Helm chart로 단순 배포, (3) 다양한 backend 지원 (S3, GCS, Azure), (4) 메트릭 export (Prometheus 통합). CronJob 직접 작성은 단순하지만 (1) cleanup 로직 직접 구현, (2) 에러 처리 빈약, (3) 메트릭 없음. 본 프로젝트는 OpenBao Snapshot Agent로 운영 부담 최소화.

**Q6. Snapshot 실패 시 어떻게 감지해요?**
> CronJob 또는 Snapshot Agent의 메트릭/이벤트로 감지. (1) Snapshot Agent의 Prometheus 메트릭 `openbao_snapshot_success_total` 모니터링 — 실패 시 alert, (2) k8s CronJob `kube_cronjob_status_last_successful_time` 메트릭 — 24시간 이상 성공 없으면 alert, (3) Object Storage bucket에 새 snapshot 파일 안 올라오면 alert. 본 프로젝트는 세 가지 모두 Phase 6-B Alertmanager 룰에 박아둠.

**Q7. Snapshot file 크기는 어느 정도예요?**
> Secret 수에 비례. 본 프로젝트 예상: secret 100개 + policy 10개 + auth method 3개 = ~20MB 정도. 운영 환경의 수천 개 secret도 100MB 미만. OCI Object Storage 2GB 할당 + 7일 retention = 7개 × 20MB = 140MB로 매우 여유. snapshot이 작아서 storage 압박 없음.

**Q8. Restore 시 unseal key는 어떻게 관리해요?**
> 복원 후에도 같은 unseal key 사용 가능해야 합니다. 그래서 (1) unseal key는 snapshot과 분리 보관 — snapshot은 Object Storage, unseal key는 OCI Vault Transit (auto-unseal용) + 운영자 안전한 곳, (2) 본 프로젝트는 OCI Vault Transit auto-unseal이라 OCI 측에 unseal 자동화 — 복원된 Vault도 같은 Transit key로 자동 unseal, (3) 운영자도 recovery key 5개 중 3개를 별도 안전 저장 (분실 대비). 면접 답변: "unseal key는 1) Transit으로 자동, 2) recovery key 분리 보관 이중 안전장치".

**Q9. Vault 손상 시 RTO/RPO는?**
> Phase 7 표 기준. (1) **PV 정상**: RTO 5분 (pod 재기동 + auto-unseal), RPO 0. (2) **PV 손상, snapshot 있음**: RTO 15분 (Block Volume Backup으로 PV 복원 + auto-unseal + secret 검증), RPO 24시간 (일일 snapshot). (3) **Vault namespace 전체 손상**: RTO 30분 (Velero로 매니페스트 복원 + Block Volume Backup으로 PV 복원 + Vault snapshot으로 데이터 복원 + auto-unseal). 세 단계 시나리오별 runbook 명시.

**Q10. Snapshot agent가 SA token으로 Vault 인증하는데 SA가 탈취되면?**
> SA에는 `snapshot` policy만 부여 — `sys/storage/raft/snapshot` read만 가능. 다른 secret read 불가. 즉 SA 탈취 시 공격자가 snapshot은 생성 가능하지만 (1) snapshot 자체는 unseal key 없이 복호화 불가, (2) snapshot을 download해도 OCI Object Storage 권한 별도 필요 — 폭발 반경 제한. SA token은 projected token으로 1시간 만료. 본 프로젝트는 최소 권한 원칙 + token 만료 짧게 + Object Storage 권한 분리 3중 방어.
