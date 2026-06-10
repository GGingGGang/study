# Velero

## 1. Why — 왜 쓰는가

Kubernetes 클러스터 백업/복원 도구. k8s manifest + PV 데이터를 Object Storage에 백업. cluster 전체 또는 namespace 단위 복원.

**왜 필요한가**:
- k8s 매니페스트는 GitOps(ArgoCD)에 있지만 **etcd의 실제 상태 ≠ Git 상태**일 수 있음 (CR status, secret, dynamic 생성 리소스 등)
- 클러스터 자체 손상 시 ArgoCD 재배포만으로는 부족 (CRD instance 상태, PVC binding, secret 등 누락)
- DR test, migration, namespace 단위 복원 같은 시나리오

**Velero의 해결**:
- 클러스터의 모든 k8s 리소스를 Object Storage에 dump
- PV는 CSI snapshot 또는 file system backup으로 별도 백업
- Restore 시 namespace mapping, label selector 등 유연한 옵션
- 정기 schedule 자동화

**대체재**:
- **k8s native etcd backup**: control plane 백업이지만 RBAC + namespace mapping 어려움. self-managed cluster만.
- **Kasten K10**: 유료 SaaS-like
- **OCI Console snapshot**: managed cluster 전체 snapshot. OKE에 일부 제공
- **Velero**: 가장 광범위, vendor neutral

## 2. Architecture — 어떻게 구성되는가

**컴포넌트**:
- **velero server**: Deployment. velero CR(Backup, Restore, Schedule, BackupStorageLocation 등) watch
- **velero CLI**: `velero` 명령
- **node-agent** (구 restic): DaemonSet. file-system backup용 (optional)

**핵심 CRD**:
- `Backup`: 백업 작업
- `Restore`: 복원 작업
- `Schedule`: 정기 백업
- `BackupStorageLocation`: Object Storage 위치
- `VolumeSnapshotLocation`: PV snapshot 위치

**백업 방식 3가지**:
1. **Manifest only**: k8s 리소스만 JSON으로 dump
2. **CSI Snapshot**: PV를 CSI driver의 VolumeSnapshot으로 (본 프로젝트 권장)
3. **File-system backup (fs-backup, 구 restic)**: pod 안에서 파일을 Object Storage로 복사. 느림.

## 3. Mechanism — 어떻게 돌아가는가

**Backup 흐름**:
1. `Backup` CR 생성 (또는 Schedule이 자동)
2. velero server가 watch → 작업 시작
3. namespace/label selector로 백업 대상 리소스 추출
4. 각 리소스를 JSON으로 dump → Object Storage에 tarball
5. PV가 있으면:
   - CSI snapshot: VolumeSnapshot CR 생성 → CSI driver가 OCI Block Volume Backup 트리거
   - fs-backup: node-agent가 pod 내부에서 파일 read → Object Storage
6. Backup CR status 업데이트

**Restore 흐름**:
1. `Restore` CR 생성 (백업 이름 + 옵션)
2. velero server가 backup tarball 다운로드
3. 매니페스트 변환 (namespace mapping 등) → kube-apiserver apply
4. PV 복원:
   - CSI snapshot: VolumeSnapshot으로부터 새 PV 생성
   - fs-backup: 새 pod 띄우고 node-agent가 Object Storage에서 파일 복원
5. Pod 재시작 → 복원된 PV mount

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Velero 의존 관계.

- **OCI Object Storage** — backup tarball 저장. 20GB 경합 4번째 합류 (Thanos + Loki + Vault snapshot + Velero)
- **OCI Customer Secret Key** — S3 호환 인증 (Velero는 OCI native auth 미지원)
- **OCI Block Volume CSI driver** — CSI snapshot 사용 시
- **velero namespace** — Velero Pod 배포

**할당량**:
- Object Storage 4GB (20GB 중)
- Backup tarball에 prefix `velero/`로 격리

**RTO**:
- Velero 자체 재기동: 5분
- Cluster 전체 복원: 30-60분 (리소스 수에 따라)
- 단일 namespace 복원: 5-10분

## 5. Usage — 어떻게 쓰는가

**OCI Customer Secret Key 생성**:

```
OCI Console → Identity → Users → <your-user> → Customer Secret Keys
→ "Generate Secret Key" → Access Key + Secret Key 페어 발급
```

**Velero credentials Secret**:

```
[default]
aws_access_key_id=<oci-customer-secret-access-key>
aws_secret_access_key=<oci-customer-secret-key>
```

저장: `velero-credentials` 파일.

**Velero CLI 설치**:

```bash
curl -L https://github.com/vmware-tanzu/velero/releases/download/v1.16.0/velero-v1.16.0-linux-amd64.tar.gz -o velero.tar.gz
tar -xvf velero.tar.gz
sudo mv velero-v1.16.0-linux-amd64/velero /usr/local/bin
```

**Velero 설치** (S3 호환 OCI Object Storage):

```bash
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups \
  --prefix velero/ \
  --backup-location-config \
    region=ap-tokyo-1,\
    s3ForcePathStyle="true",\
    s3Url=https://<namespace>.compat.objectstorage.ap-tokyo-1.oraclecloud.com \
  --secret-file ./velero-credentials \
  --use-volume-snapshots=true \
  --features=EnableCSI \
  --default-backup-ttl=168h0m0s \
  --namespace velero
```

**VolumeSnapshotClass 정의** (CSI snapshot):

```yaml
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: oci-bv-snapclass
  labels:
    velero.io/csi-volumesnapshot-class: "true"
driver: blockvolume.csi.oraclecloud.com
deletionPolicy: Retain
```

**일일 자동 Schedule**:

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: daily-backup
  namespace: velero
spec:
  schedule: "0 18 * * *"            # UTC 18:00 = KST 03:00
  template:
    ttl: 168h                       # 7일 retention
    includedNamespaces:
    - app
    - vault
    - cicd
    - monitoring
    - istio-system
    excludedResources:
    - events                        # event는 백업 의미 없음
    snapshotVolumes: true
```

**Manual backup** (큰 변경 전):

```bash
velero backup create pre-istio-upgrade-$(date +%Y%m%d) \
  --include-namespaces app,istio-system \
  --snapshot-volumes \
  --wait
```

**Restore** (namespace mapping):

```bash
# 백업 목록
velero backup get

# 특정 namespace를 다른 이름으로 복원 (DR test)
velero restore create test-restore \
  --from-backup daily-backup-20260520180000 \
  --namespace-mappings app:app-dr-test \
  --wait

# 검증 후 cleanup
kubectl delete namespace app-dr-test
```

**검증**:

```bash
velero backup describe <backup-name>
velero backup logs <backup-name>
velero restore describe <restore-name>
```

## 6. Configuration — 어떤 설정이 있는가

**Backup 옵션**:
- `includedNamespaces` / `excludedNamespaces`
- `includedResources` / `excludedResources` (events는 제외 권장)
- `labelSelector`: 특정 label만
- `snapshotVolumes`: PV CSI snapshot 수행 여부
- `ttl`: 자동 삭제 시점

**Schedule cron 표현**:
- `"0 18 * * *"`: 매일 UTC 18:00
- `"0 */6 * * *"`: 6시간마다
- 본 프로젝트는 daily 1회로 단순화

**Restore 옵션**:
- `--namespace-mappings src:dst`: namespace 이름 변경
- `--restore-volumes`: PV도 복원
- `--include-namespaces`: 일부만 복원
- `--existing-resource-policy`: `none`(skip) vs `update`(덮어쓰기)

**CSI vs fs-backup 선택**:
- **CSI snapshot** (권장): 빠름, OCI Block Volume Backup quota 사용 (별도 5개 한도)
- **fs-backup**: Object Storage 사용 (20GB 경합), 모든 storage 호환, 느림
- 본 프로젝트는 CSI snapshot 우선

**Default backup TTL**:
- `--default-backup-ttl=168h`: 7일 후 자동 삭제 (Object Storage 폭주 방지)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Velero 1.16+** (2026-05 권장)
- **velero-plugin-for-aws 1.10+** (S3 호환)
- **OCI Object Storage**: S3 호환 모드 필수, Customer Secret Key 인증
- **CSI snapshot**: k8s 1.27+ stable, OCI Block Volume CSI driver 0.1+ 지원
- **k8s 리소스 호환**: 대부분 백업/복원 가능. 일부 (예: GitOps controller가 관리하는 resource) 충돌 가능

## 8. 면접 예상 질문 & 답변

**Q1. Velero가 OCI native 지원 없는데 어떻게 써요?**
> S3 호환 모드를 활용합니다. OCI Object Storage가 S3 호환 API를 제공해서 Velero의 `velero-plugin-for-aws`로 접근 가능. 단점은 (1) Instance Principal 같은 OCI native auth 안 됨 → Customer Secret Key 발급 필요, (2) 일부 OCI 특화 기능(예: storage tier 자동 전환) 활용 불가. 본 프로젝트는 단순성 우선이라 S3 호환 모드로 충분. 향후 Velero가 native OCI plugin 추가하면 마이그레이션 검토.

**Q2. CSI snapshot vs fs-backup 어느 게 나아요?**
> 본 프로젝트는 CSI snapshot 우선. (1) 빠름 — OCI Block Volume snapshot은 instant, fs-backup은 파일 read + 네트워크 전송으로 느림, (2) Object Storage 20GB 경합 회피 — CSI snapshot은 Block Volume Backup quota(5개) 사용. 단점: Block Volume Backup 5개 한도. 그래서 본 프로젝트는 CSI snapshot으로 5개 priority PV 백업, 나머지는 fs-backup 사용 안 함 (manifest만 백업).

**Q3. Velero 자체가 GitOps랑 충돌 안 해요?**
> 일부 가능. Velero가 ArgoCD-managed 리소스를 복원하면 ArgoCD가 drift로 감지해서 다시 sync 시도. 본 프로젝트는 (1) 정상 운영에서는 ArgoCD가 source of truth, (2) 사고 시 Velero는 ArgoCD가 모르는 동적 리소스(CR status, PV binding, secret 등) 복원에 집중, (3) 복원 후 ArgoCD sync로 매니페스트 일치. 두 도구의 역할 분리가 핵심. Restore 시 ArgoCD 일시 disable 후 진행하는 패턴도 있음.

**Q4. Schedule 작성 시 어떤 namespace 백업해야 해요?**
> 본 프로젝트의 백업 대상: app, vault, cicd, monitoring, istio-system, external-dns, cert-manager. 제외: kube-system, kube-public(k8s 자체 관리), kube-node-lease. Events는 백업 의미 없음(`excludedResources: [events]`). 실수로 너무 적게 백업하는 게 너무 많이 백업하는 것보다 위험 — 의심스러우면 포함하는 게 안전.

**Q5. Restore 테스트는 어떻게 해요?**
> namespace mapping 활용한 DR test. `--namespace-mappings app:app-dr-test`로 원본 namespace 영향 없이 별도 namespace로 복원. 검증 후 삭제. 본 프로젝트는 (1) 월 1회 자동 DR test 파이프라인 — Jenkins가 매월 첫 주에 `velero restore --namespace-mappings`로 별도 NS 복원, (2) 핵심 컴포넌트 동작 검증 (smoke test), (3) Slack 알림 + cleanup. "백업이 1년 잘 됐는데 복원 시점에 corrupt 발견" 사고 방지.

**Q6. Velero가 죽으면 어떻게 되나요?**
> 즉시 영향 없음 — 이미 백업된 데이터는 Object Storage에 있고 클러스터는 정상 동작. 영향은 (1) 새 백업 안 됨 — RPO 영향, (2) 진행 중이던 restore 중단 — 재시도 필요. Prometheus alert으로 Velero pod down 즉시 감지. Velero는 stateless라 재기동 빠름(2-3분).

**Q7. Object Storage 4GB로 충분해요?**
> 본 프로젝트 환경 기준 충분. 백업 대상은 매니페스트 위주(MB 단위) + CSI snapshot은 별도 quota라 Object Storage 사용 안 함. PV 자체를 fs-backup으로 했으면 GB 단위 폭증하지만 본 프로젝트는 CSI snapshot이라 manifest tarball만 Object Storage에 저장. 7일 retention 가정 시 ~500MB 수준 예상. 여유 충분.

**Q8. Velero로 cluster 전체 마이그레이션 가능해요?**
> 가능. 시나리오: 다른 region 또는 다른 cloud의 새 k8s cluster에 Velero 설치 + 같은 Object Storage backup location 연결 → 백업 복원. 단 (1) namespace + 리소스만 복원되고 PV는 cross-region 어려움 (snapshot은 region-locked), (2) Service IP, NodePort 같은 cluster-specific 정보 재할당, (3) cert-manager 인증서는 새로 발급. 본 프로젝트는 single region이라 이 시나리오 적용 안 하지만, Velero의 마이그레이션 기능이 큰 가치.

**Q9. PV CSI snapshot이 OCI Block Volume Backup이랑 어떻게 다른가요?**
> 같습니다. CSI snapshot은 k8s 표준 API, 실제로는 OCI Block Volume Backup을 트리거. 즉 본 프로젝트의 (1) Terraform `oci_core_volume_backup_policy_assignment`로 정기 백업 + (2) Velero CSI snapshot으로 manual 백업 둘 다 같은 Block Volume Backup 5개 한도 사용. 중복 백업 피하려면 Velero는 manifest만 백업하고 PV는 Terraform 정책에 위임하는 방식도 가능. 본 프로젝트는 Velero가 manifest + CSI snapshot 둘 다 처리하고 Terraform 정책은 보조.

**Q10. Velero restore가 매니페스트 변경된 후 실행하면 어떻게 되나요?**
> 옵션에 따라 다름. (1) `--existing-resource-policy=none` (default): 기존 리소스 있으면 skip. 변경 안 됨. (2) `--existing-resource-policy=update`: 백업 시점 매니페스트로 덮어쓰기. 의도치 않은 rollback 가능. 본 프로젝트는 (1) default 사용 — restore는 "잃어버린 것 복구" 목적이지 "특정 시점으로 rollback"이 아님. Rollback은 ArgoCD의 history 활용.
