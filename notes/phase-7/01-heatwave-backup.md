# HeatWave MySQL 백업 (Terraform)

## 1. Why — 왜 쓰는가

DB는 본 프로젝트의 가장 critical한 stateful 자원. 코드는 Git에 있고 인프라는 Terraform에 있지만 **DB 데이터는 한 번 잃으면 끝**. 백업 정책이 명시적이지 않으면 `terraform destroy` 한 번에 모든 사용자 데이터 소멸.

**기본 설정의 문제** (`SKIP_FINAL_BACKUP`):
- terraform destroy 시 DB 인스턴스 + 데이터 즉시 삭제
- 자동 백업도 함께 삭제 (`automatic_backup_retention`이 SKIP이면)
- 사고 인지 후 복구 불가

**Always Free HeatWave 백업 특성**:
- **데이터 50GB + 백업 50GB 별도 할당** (총 100GB)
- 자동 백업 retention 1-35일 설정 가능
- **Always Free final backup retention은 7일** (일반 365일 대비 단축)
- cross-region 백업 복제 가능하나 Always Free 외 비용 발생

## 2. Architecture — 어떻게 구성되는가

**OCI HeatWave 백업 종류**:
- **Automatic backup**: OCI가 일일 자동 백업. retention 1-35일.
- **Manual backup**: 사용자 명시적 백업. 별도 retention.
- **Final backup**: DB 삭제 시점에 마지막 백업. retention Always Free 7일.

**복원 방법**:
- 백업으로부터 **새 DB instance 생성** (in-place restore 아님)
- 새 instance에 새 IP 할당 → 앱 연결 설정 갱신 필요
- Point-in-time recovery (binlog 기반)도 가능

**Terraform 리소스**:
- `oci_mysql_mysql_db_system`: DB 인스턴스
  - `backup_policy`: 자동 백업 정책
  - `deletion_policy`: 삭제 시 동작

## 3. Mechanism — 어떻게 돌아가는가

**자동 백업 흐름**:
1. `backup_policy.is_enabled: true` + `retention_in_days: 35` 설정
2. 매일 정해진 시각(window_start_time)에 자동 백업
3. retention 기간 지난 백업 자동 삭제
4. 백업 storage는 Always Free 50GB 한도

**Final backup 흐름**:
1. `deletion_policy.final_backup: REQUIRE_FINAL_BACKUP` 설정
2. terraform destroy 또는 OCI Console에서 DB 삭제 시
3. OCI가 자동으로 final backup 수행 후 인스턴스 삭제
4. final backup은 OCI Object Storage에 저장, retention 7일 (Always Free)

**Restore 흐름**:
1. OCI Console → MySQL → Backups에서 백업 선택
2. "Restore" → 새 DB 인스턴스 생성 (이름 다르게)
3. 또는 Terraform `oci_mysql_mysql_db_system`의 `source.source_type: BACKUP` + `backup_id`
4. 새 IP 할당 → 앱 connection string 업데이트

## 4. Integration — 어떻게 연결하는가

- **Terraform** — `oci_mysql_mysql_db_system` 리소스
- **OCI IAM** — 백업 접근 권한 (운영자 user에게 부여)
- **앱 connection string** — 복원 후 새 IP/hostname 반영 필요 (k8s Secret 업데이트)
- **Velero** — k8s 매니페스트 백업, DB 데이터는 안 함 (HeatWave 자체 백업이 source of truth)

**RTO/RPO**:
- RPO 24시간 (일일 자동 백업)
- RTO 30분 (OCI Console restore 시간)
- Point-in-time recovery 사용 시 RPO 5분 가능 (binlog 기반)

## 5. Usage — 어떻게 쓰는가

**Terraform 설정** (백업 + 삭제 보호):

```hcl
resource "oci_mysql_mysql_db_system" "main" {
  compartment_id      = var.compartment_ocid
  shape_name          = "MySQL.Free"
  mysql_version       = "8.4.3"
  admin_username      = "admin"
  admin_password      = var.db_admin_password
  
  subnet_id           = oci_core_subnet.db.id
  data_storage_size_in_gb = 50
  display_name        = "fintech-mysql"
  
  # 자동 백업
  backup_policy {
    is_enabled              = true
    retention_in_days       = 35              # Always Free 최대
    window_start_time       = "03:00"         # KST 12:00 (UTC+9)
    
    pitr_policy {
      is_enabled = true                       # Point-in-time recovery
    }
  }
  
  # 삭제 보호 + final backup
  deletion_policy {
    automatic_backup_retention = "RETAIN"
    final_backup               = "REQUIRE_FINAL_BACKUP"
    is_delete_protected        = true         # 추가 보호
  }
  
  # Terraform destroy 차단 (이중 안전장치)
  lifecycle {
    prevent_destroy = true
  }
}
```

**Manual backup 생성** (terraform 또는 OCI CLI):

```hcl
resource "oci_mysql_mysql_backup" "manual" {
  db_system_id  = oci_mysql_mysql_db_system.main.id
  backup_type   = "FULL"                      # FULL / INCREMENTAL
  display_name  = "pre-major-upgrade-${formatdate("YYYYMMDD", timestamp())}"
  retention_in_days = 30
}
```

또는 CLI:

```bash
oci mysql backup create \
  --db-system-id <ocid> \
  --backup-type FULL \
  --display-name "pre-upgrade-$(date +%Y%m%d)" \
  --retention-in-days 30
```

**복원** (Terraform):

```hcl
resource "oci_mysql_mysql_db_system" "restored" {
  compartment_id      = var.compartment_ocid
  shape_name          = "MySQL.Free"
  subnet_id           = oci_core_subnet.db.id
  
  source {
    source_type = "BACKUP"
    backup_id   = "ocid1.mysqlbackup.oc1..."
  }
}
```

**Point-in-time recovery**:

```bash
oci mysql db-system create \
  --compartment-id <compartment> \
  --shape-name MySQL.Free \
  --subnet-id <subnet> \
  --source '{
    "sourceType": "PITR",
    "dbSystemId": "<source-db-ocid>",
    "recoveryPoint": "2026-05-15T10:30:00Z"
  }'
```

## 6. Configuration — 어떤 설정이 있는가

**backup_policy 옵션**:
- `is_enabled`: 자동 백업 활성화
- `retention_in_days`: 1-35 (본 프로젝트 35 — 최대)
- `window_start_time`: HH:MM (UTC)
- `pitr_policy.is_enabled`: Point-in-time recovery 활성화

**deletion_policy 옵션**:
- `automatic_backup_retention`:
  - `RETAIN`: DB 삭제 후에도 자동 백업 유지
  - `DELETE`: 자동 백업도 함께 삭제 (위험)
- `final_backup`:
  - `REQUIRE_FINAL_BACKUP`: 삭제 시 final backup 자동 생성 (본 프로젝트)
  - `SKIP_FINAL_BACKUP`: 백업 없이 즉시 삭제 (위험)
- `is_delete_protected`: true면 OCI Console에서도 삭제 차단

**lifecycle.prevent_destroy**:
- terraform destroy 시 오류 발생, 변경 불가
- DB 인스턴스 + Block Volume 같은 critical 리소스에 적용

**cross-region 복제** (선택, Always Free 외 비용):
- Phase 7에서는 명시적 비활성화 (cross-region traffic 비용)
- single region 한계 README 명시

## 7. Compatibility — 어떤 호환성이 요구되는가

- **OCI Terraform provider 5.x+**
- **HeatWave MySQL 8.x** (2026-05 권장)
- **Always Free shape: `MySQL.Free`** (다른 shape는 비용)
- **PITR**: MySQL 8.0+ 필수 (binlog 기반)
- **Restore destination**: 같은 compartment, 같은 region (cross-region은 추가 비용)

## 8. 면접 예상 질문 & 답변

**Q1. SKIP_FINAL_BACKUP의 위험은?**
> terraform destroy 또는 OCI Console에서 DB 삭제 시 백업 없이 즉시 데이터 소멸합니다. 사고 시 복구 불가 — production이면 회사 운영 자체가 위협. 본 프로젝트는 `REQUIRE_FINAL_BACKUP`으로 변경해서 삭제 시 OCI가 자동으로 final backup 수행 후 인스턴스 삭제하도록 강제. 추가로 `prevent_destroy = true` lifecycle로 terraform destroy 자체도 차단. 이중 안전장치.

**Q2. Always Free final backup retention 7일이 짧지 않나요?**
> 짧습니다. 일반 HeatWave는 365일이지만 Always Free는 7일. 사고 인지 + 복구 결정이 7일 안에 일어나야 합니다. 그래서 본 프로젝트는 (1) 자동 백업 retention 35일 (최대값)로 별도 백업 보관, (2) manual backup으로 major 변경 전 명시적 백업 (retention 30일), (3) `is_delete_protected = true`로 의도치 않은 삭제 차단 — 세 가지 방어선. README에 "Always Free 한계: final backup 7일, 운영 환경은 cross-region 복제 권장" 명시.

**Q3. Point-in-time recovery가 뭐고 왜 활성화해요?**
> Binlog 기반으로 임의 시점으로 복구 가능한 기능입니다. 일일 자동 백업만 있으면 RPO 24시간(어제 백업 시점으로만 복구), PITR로는 RPO 5분 수준. 사고 시나리오: 운영자가 실수로 `DELETE FROM users WHERE id > 1000` 실행 → 자동 백업으로는 24시간 전 상태로만 복구 (그 사이 신규 사용자 가입 데이터 손실), PITR로는 DELETE 직전 시점으로 복구 가능. 본 프로젝트는 `pitr_policy.is_enabled: true`로 활성화.

**Q4. 복원이 in-place 아니고 새 인스턴스 생성인 이유는?**
> OCI HeatWave의 설계 선택입니다. 기존 인스턴스에 덮어쓰기보다 새 인스턴스 생성이 (1) 원본 데이터 보호 — 복원 실패 시 원본 영향 없음, (2) test/verify 가능 — 복원본을 검증 후 traffic 전환, (3) cross-region 복원 시 자연스러움. 단점은 (1) 새 IP/hostname 할당 → 앱 connection string 갱신 필요, (2) 일시적으로 두 인스턴스 비용 (Always Free 1개 제약에서는 미묘 — staging 환경 대비 필요). 본 프로젝트는 복원 runbook에 connection string 갱신 step 명시.

**Q5. terraform destroy 차단 메커니즘 두 가지가 뭐예요?**
> (1) **OCI 레벨** `is_delete_protected = true`: OCI Console UI에서 삭제 버튼 자체가 비활성화. API/CLI도 거부. (2) **Terraform 레벨** `lifecycle { prevent_destroy = true }`: terraform destroy 또는 terraform apply 중 리소스 destroy 시도가 error로 fail. 둘 다 적용해서 어느 한쪽 우회되어도 다른 쪽이 차단. 실제 삭제 필요하면 명시적으로 둘 다 비활성화 후 destroy → 사람이 의도적으로 두 번 확인하는 효과.

**Q6. 일일 백업 RPO 24시간이 핀테크에 부족하지 않나요?**
> 본 프로젝트는 학습 목적이라 24시간 RPO + PITR 5분 RPO 조합으로 충분. Production 핀테크는 RPO 5분 미만이 표준이고, MySQL replica + binlog streaming + 여러 region 분산 같은 architecture 필요. 면접에서 "본 프로젝트는 Always Free 환경 한계상 single instance + PITR 조합으로 RPO 5분 보장, production은 read replica + cross-region 복제 + 짧은 RPO 추가 검토" narrative.

**Q7. backup_policy의 retention 35일과 final_backup 7일 차이는?**
> backup_policy는 **자동 일일 백업**의 retention, final_backup은 **DB 삭제 시 마지막 백업**의 retention. 자동 백업은 35일 유지하면서 매일 새 백업 생성. final backup은 DB 자체가 사라진 후의 마지막 보험. 본 프로젝트는 backup_policy retention 최대값 35일로 설정 + final backup은 Always Free 한계 7일 그대로. 사고 인지가 7일 넘으면 final backup도 사라지므로 backup_policy의 35일이 사실상 최후의 안전장치.

**Q8. Cross-region 복제 안 한 이유는?**
> Always Free에 cross-region 복제는 포함 안 됨 + cross-region data transfer 비용 발생. 본 프로젝트의 self-host 무료 컨셉 위반. 단점은 region-level 재해(OCI Tokyo region 자체 다운) 시 복구 불가 — single region 한계 명시. 면접 답변: "Production 환경에서 financial regulation이 cross-region DR 요구하면 추가 비용 감수하고 적용, 본 프로젝트는 학습/포트폴리오 한계 명시".

**Q9. HeatWave Free의 50GB 데이터 한도가 부족하지 않나요?**
> 본 프로젝트는 학습용이라 50GB 충분 — 사용자 1만명, 거래 100만건 수준까지 들어갑니다. 실제 핀테크 production은 TB 단위라 부족하고 별도 shape(`MySQL.HeatWave.VM.Standard.E3` 등 유료) 필요. 자원 증가 시점: 데이터 사용량 80% (40GB) 도달 시 alert, 단기는 데이터 archival(오래된 거래 삭제) + 장기는 instance upgrade.

**Q10. Backup 실행 자체가 production 영향 주나요?**
> 가벼운 영향. OCI HeatWave 자동 백업은 snapshot 기반이라 일시적 I/O spike 정도. window_start_time을 트래픽 적은 시간(예: KST 새벽 3시 = UTC 18:00)으로 설정하면 영향 미미. 본 프로젝트는 `window_start_time: "03:00"` UTC로 설정 (KST 정오) — Always Free 환경이라 트래픽 시간대 영향 작음. Production 환경은 진짜 트래픽 낮은 시간대 선택.
