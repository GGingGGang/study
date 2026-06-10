# Thanos

## 1. Why — 왜 쓰는가

Prometheus의 한계를 보완하는 장기 저장 + 글로벌 뷰 도구. CNCF Incubating.

**Prometheus의 한계**:
- Local TSDB만 → 디스크 가득 차면 오래된 데이터 삭제
- 장기 보관 어려움 (90일 이상은 사실상 무리)
- Multi-cluster 통합 뷰 없음 — 클러스터마다 별도 Grafana DataSource
- Prometheus pod 죽으면 직전 2시간 메트릭 위험

**Thanos의 해결**:
- **Object Storage 통합**: Prometheus 2시간 블록을 S3 호환 Object Storage(OCI Object Storage)에 업로드 → 무한 보관
- **Downsampling**: 오래된 데이터를 5분/1시간 해상도로 자동 압축 → 저장 공간 절약 + 쿼리 속도 개선
- **Global View**: 여러 Prometheus의 데이터를 단일 쿼리 엔드포인트(Thanos Query)로 통합
- **HA**: 같은 메트릭을 수집하는 Prometheus 2개를 deduplication

**왜 토스 스택인가**: 토스가 Thanos를 쓰는 narrative + 단일 클러스터에서도 장기 보관 가치 있음.

**대체재**:
- **Mimir** (Grafana Labs): Cortex fork. 더 가볍고 빠르나 Grafana 진영. 본 프로젝트는 토스 정합으로 Thanos.
- **Cortex**: Mimir의 전신. Grafana가 fork한 후 stagnant.
- **VictoriaMetrics**: Prometheus 대체 + 장기 저장 통합. 채택 사례 많아지는 중.

## 2. Architecture — 어떻게 구성되는가

**핵심 컴포넌트** (단일 클러스터 sidecar 모드 기준):

- **Thanos Sidecar**: Prometheus Pod 안에 사이드카로 동작. 2시간 단위 완성된 TSDB 블록을 Object Storage에 업로드. Prometheus와 동일 Pod이라 직접 호출 가능.
- **Thanos Store Gateway**: Object Storage의 블록을 읽어서 쿼리 가능하게 만드는 컴포넌트. 자체 PV에 인덱스 캐시.
- **Thanos Query** (Querier): 모든 Thanos 컴포넌트를 묶어서 단일 PromQL 엔드포인트 제공. Grafana DataSource로 등록.
- **Thanos Compactor**: Object Storage의 블록을 downsampling + 오래된 블록 삭제 (retention 정책 적용).
- **Thanos Receiver** (안 씀): push-based 대안. HA Prometheus 환경에서 사용. 본 프로젝트 미사용.
- **Thanos Ruler** (선택): Object Storage 데이터에 대해 알람 룰 평가. 본 프로젝트 미사용 (Prometheus가 local rules로 충분).

**Sidecar vs Receiver 선택 (본 프로젝트 sidecar)**:
- Sidecar: pull-based, 단일 Prometheus 정합. 본 프로젝트 권장.
- Receiver: push-based, HA Prometheus용. 노드 3개 이상 + 진짜 HA 환경에서 의미.

## 3. Mechanism — 어떻게 돌아가는가

**메트릭 흐름**:

1. Prometheus가 2시간 단위로 TSDB 블록 완성
2. Sidecar가 새 블록 감지 → Object Storage에 업로드
3. Compactor가 주기적으로 Object Storage 스캔 → downsampling + retention 적용
4. Query에 PromQL 요청 도착
5. Query가 두 곳에서 데이터 수집:
   - 최근 2시간 (sidecar 경유 Prometheus local)
   - 그 이전 (Store Gateway 경유 Object Storage)
6. 두 결과 merge + deduplication → 응답

**Downsampling**:
- Raw resolution (15-30s) → 5분 해상도 → 1시간 해상도
- 본 프로젝트 retention:
  - raw: 7일
  - 5분: 30일
  - 1시간: 1년
- 1년치 메트릭을 1시간 해상도로 보면 200KB/series 수준 → 매우 효율적

**HBONE 같은 거 안 씀**: Thanos는 gRPC 통신. Store gateway가 메모리 + PV에 블록 인덱스 캐시.

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Thanos 의존 관계.

- **Prometheus** — sidecar로 같은 Pod에 동작
- **OCI Object Storage** — TSDB 블록 저장 (Always Free 20GB 경합 영역)
- **OCI IAM** — Instance Principal 인증 (Phase 1 IAM 모듈에 Dynamic Group + manage objects policy 추가 필요)
- **Grafana** — DataSource를 Thanos Query로 (Prometheus 직접 아닌)
- **Compactor** — Object Storage에 별도 PV 필요 (인덱스 캐시 위해 ~5GB)

**OCI Object Storage 인증**:
- Customer Secret Key (S3 호환 모드): Velero 같은 도구에서 사용
- **Instance Principal (native OCI)**: 본 프로젝트 권장. Pod의 SA가 OCI Dynamic Group과 매핑되어 자동 인증
- Thanos의 OCI 지원: `type: OCI` config로 native mode 사용 가능 (s3 호환보다 안정적)

## 5. Usage — 어떻게 쓰는가

**OCI IAM 설정** (Phase 1 IAM 모듈에 추가):

```
# Dynamic Group: thanos pods
Any { instance.compartment.id = '<compartment>', tag.namespace.tagkey.value = 'thanos' }

# Policy
Allow dynamic-group thanos-sidecar to manage objects in compartment <x> where target.bucket.name = 'thanos-metrics'
```

**Object Storage bucket** (Terraform):

```hcl
resource "oci_objectstorage_bucket" "thanos" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.ns.namespace
  name           = "thanos-metrics"
  storage_tier   = "Standard"
  versioning     = "Disabled"
}
```

**Thanos sidecar 활성화** (kube-prometheus-stack values.yaml 추가):

```yaml
prometheus:
  prometheusSpec:
    thanos:
      objectStorageConfig:
        existingSecret:
          name: thanos-objstore-config
          key: objstore.yml
      version: v0.36.0
```

**objstore.yml 설정**:

```yaml
type: OCI
config:
  provider: instance-principal
  bucket: thanos-metrics
  compartment_ocid: <compartment>
  region: ap-tokyo-1
```

```bash
kubectl create secret generic thanos-objstore-config -n monitoring \
  --from-file=objstore.yml=./objstore.yml
```

**Thanos Query, Store, Compactor 별도 설치** (Helm bitnami/thanos):

```bash
helm install thanos bitnami/thanos \
  --namespace monitoring \
  -f thanos-values.yaml
```

thanos-values.yaml:
```yaml
existingObjstoreSecret: thanos-objstore-config
existingObjstoreSecretItems:
- key: objstore.yml
  path: objstore.yml

query:
  enabled: true
  dnsDiscovery:
    enabled: true
    sidecarsService: prometheus-operated   # kube-prometheus-stack의 Prometheus headless svc
    sidecarsNamespace: monitoring

storegateway:
  enabled: true
  persistence:
    storageClass: oci-bv
    size: 5Gi

compactor:
  enabled: true
  retentionResolutionRaw: 7d
  retentionResolution5m: 30d
  retentionResolution1h: 365d
  persistence:
    storageClass: oci-bv
    size: 10Gi

ruler:
  enabled: false                    # 본 프로젝트는 Prometheus local rules 사용
```

**Grafana DataSource 변경**:

```yaml
datasources:
- name: Thanos
  type: prometheus
  url: http://thanos-query.monitoring.svc:9090
  isDefault: true
```

**검증 명령**:

```bash
# Sidecar 업로드 상태
kubectl logs <prometheus-pod> -n monitoring -c thanos-sidecar | grep "successfully uploaded block"

# Object Storage에 블록 확인
oci os object list --bucket-name thanos-metrics --prefix prometheus/

# Thanos Query UI
kubectl port-forward svc/thanos-query 9090:9090 -n monitoring
# 브라우저로 localhost:9090/stores → 모든 컴포넌트 연결 확인
```

## 6. Configuration — 어떤 설정이 있는가

**Compactor retention** (가장 중요):
- `retentionResolutionRaw`: 원본 해상도 보관 기간. 본 프로젝트 7일.
- `retentionResolution5m`: 5분 다운샘플 보관. 30일.
- `retentionResolution1h`: 1시간 다운샘플 보관. 1년.
- 미설정 시 무한 보관 → Object Storage 폭주

**Query 옵션**:
- `--query.replica-label=prometheus_replica`: HA 환경에서 중복 메트릭 제거
- `--query.timeout=2m`: 쿼리 타임아웃
- `--query.max-concurrent=20`: 동시 쿼리 수
- `partial_response_strategy`: 일부 store가 응답 안 할 때 처리 (abort vs warn)

**Sidecar 옵션**:
- `--prometheus.url`: 같은 Pod의 Prometheus 주소 (보통 localhost:9090)
- `--objstore.config-file`: Object Storage 설정
- `--shipper.upload-compacted`: false 권장 (Prometheus가 이미 compacted block 만듦)

**Store Gateway 옵션**:
- `--index-cache-size`: 인덱스 캐시 RAM 크기 (default 250MB)
- `--chunk-pool-size`: 청크 캐시 (default 2GB) — 본 프로젝트는 노드 메모리 제약상 줄임
- `--data-dir`: PV mount path (인덱스 캐시 저장)

**External labels** (Prometheus 측):
- Prometheus의 `externalLabels`에 `cluster: oci-1`, `replica: 0` 같은 식으로 명시
- Thanos가 이 label로 데이터 origin 추적

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Prometheus 2.x ~ 3.x** 모두 호환 (Thanos 0.36+ 권장)
- **Thanos 0.36+** (2026-05 기준)
- **Object Storage**: S3 호환 또는 native OCI. 본 프로젝트는 native OCI 사용
- **kube-prometheus-stack**: Thanos sidecar 통합 기본 지원
- **Grafana 10+**: Prometheus DataSource로 Thanos Query 그대로 사용 가능
- **Network**: Thanos 컴포넌트 간 gRPC 통신 — Istio mTLS 환경에서 ztunnel/sidecar 주입 호환성 확인 필요

## 8. 면접 예상 질문 & 답변

**Q1. Prometheus만으로 부족한가요? Thanos가 왜 필요해요?**
> Prometheus는 local TSDB만 사용하고 디스크 가득 차면 오래된 데이터를 삭제합니다. 3일 retention으로 운영하면 사고 분석할 때 4일 전 데이터를 못 봅니다. Thanos는 Prometheus의 2시간 단위 블록을 Object Storage에 무한 보관해서 1년치 메트릭도 쿼리 가능하게 만듭니다. 또 downsampling으로 오래된 데이터를 5분/1시간 해상도로 압축해서 저장 공간과 쿼리 속도를 동시에 개선합니다. 본 프로젝트는 Always Free 환경의 Block Volume 한계도 있어서 Thanos가 사실상 필수입니다.

**Q2. Sidecar 방식과 Receiver 방식 어느 걸 골랐어요?**
> Sidecar입니다. 본 프로젝트는 단일 Prometheus 인스턴스라 sidecar가 정답입니다. Receiver는 Prometheus가 push로 보내는 방식이라 multiple HA Prometheus 환경에서 의미가 있는데, 노드 3개 이상의 진짜 HA 클러스터에서 권장됩니다. 본 프로젝트는 노드 2개 단일 Prometheus라 sidecar가 더 단순하고 안정적입니다. 2026 공식 가이드도 "단일 = sidecar, HA = receiver" 권장입니다.

**Q3. Sidecar 방식의 진짜 리스크는 뭐예요?**
> "Prometheus 장애 시 직전 2시간 메트릭 손실"이라는 흔한 답변은 부정확합니다. 정확하게는 (1) Prometheus가 2시간 단위 블록을 완성한 후에 sidecar가 업로드하므로, (2) 진행 중인 2시간 블록은 PV에만 존재하고 (3) **PV 자체가 손상**되어야 데이터가 사라집니다. Pod이 죽고 재기동되어도 PV가 살아있으면 sidecar가 직전 블록을 업로드합니다. 따라서 진짜 리스크는 "Prometheus 다운"이 아니라 "Block Volume CSI/PV 손상"이고, 본 프로젝트는 Block Volume Backup 5개 한도 중 Prometheus를 우선순위 2위로 배치합니다.

**Q4. Compactor retention 설정의 의미는?**
> 세 가지 해상도별로 보관 기간을 분리합니다. raw(원본 15-30초)는 7일만 보관 — 짧은 사고 분석용. 5분 해상도는 30일 — 주간/월간 추세. 1시간 해상도는 1년 — 장기 capacity planning. 이렇게 분리하면 1년치 메트릭이 raw 그대로 저장될 때 대비 10배 이상 작아집니다. 본 프로젝트는 Object Storage 8GB 할당이고 retention 미설정 시 무한 누적되어 빠르게 초과합니다.

**Q5. Compactor가 두 개 떠 있으면 어떻게 되나요?**
> 데이터 손상 위험이 있어 절대 안 됩니다. Compactor는 Object Storage의 블록을 read/write하면서 downsampling과 삭제를 하는데, 두 인스턴스가 동시에 같은 블록을 처리하면 race condition으로 블록이 파괴됩니다. 그래서 Compactor는 반드시 단일 인스턴스고 leader election 같은 메커니즘도 없습니다. Helm chart의 default도 replicas=1입니다. HA가 필요하면 Compactor lock(`shopify-distributed-lock` 같은)을 도입하지만 본 프로젝트는 단순 단일 인스턴스로 갑니다.

**Q6. OCI Object Storage 인증을 Instance Principal로 한 이유는?**
> Customer Secret Key 방식(S3 호환)도 가능하지만 Instance Principal이 두 가지 장점이 있습니다. (1) Secret 관리 부담 없음 — k8s Secret으로 키를 저장하지 않아도 됩니다. (2) 키 회전 자동 — IAM이 자동으로 토큰 발급/회전합니다. 단점은 Pod이 OCI Instance Metadata Service(IMDS)에 접근 가능해야 한다는 점인데, 본 프로젝트는 worker node에서 자동 가능합니다. Velero는 S3 호환 모드를 써야 해서 Customer Secret Key를 쓰는데, Thanos는 native OCI provider가 있어서 Instance Principal이 우선입니다.

**Q7. Grafana DataSource를 Prometheus 직접 안 쓰고 Thanos Query로 쓰는 이유는?**
> Thanos Query가 단기(Prometheus local)와 장기(Object Storage)를 통합 쿼리해주기 때문입니다. Prometheus 직접 쿼리하면 직전 3일 데이터만 보입니다. Thanos Query는 PromQL을 그대로 받아서 시간 범위에 따라 자동으로 Prometheus sidecar 또는 Store Gateway에 분기합니다. Grafana 입장에선 그냥 Prometheus 호환 endpoint로 보이고, 사용자는 1년 전 데이터도 자연스럽게 조회 가능합니다.

**Q8. Thanos가 Mimir보다 나은 점은?**
> 차이 위주로 답합니다. (1) Thanos는 sidecar 모델이라 기존 Prometheus 위에 얹기 쉽습니다. Mimir는 push 기반이라 Prometheus 설정 변경이 필요합니다. (2) Thanos는 Object Storage를 single source of truth로 보고 모든 컴포넌트가 그걸 읽는 구조라 단순합니다. Mimir는 별도 메타데이터 store가 있어 더 복잡합니다. (3) 본 프로젝트의 narrative는 토스 스택 정합이라 Thanos를 선택했지만, Grafana 진영 전체로 통일하려면 Mimir + Loki + Tempo로 가는 게 더 일관적입니다. 면접에서 "둘 다 검토했지만 토스 정합 + sidecar 단순성으로 Thanos 채택"이라 답합니다.

**Q9. Thanos가 죽으면 어떻게 되나요?**
> 컴포넌트별로 영향이 다릅니다. (1) Sidecar 다운: Prometheus는 정상이지만 Object Storage 업로드 멈춤. 24시간 내 복구 안 되면 신규 블록 누적 — 디스크 영향. (2) Query 다운: Grafana 대시보드 조회 불가. 메트릭 수집은 정상. (3) Store Gateway 다운: 장기 데이터 조회 불가, 최근 3일만 조회. (4) Compactor 다운: downsampling 멈춤, retention 정책 멈춤 → Object Storage 누적. 가장 critical은 Compactor 다운 시 무한 누적되는 거고, Prometheus 알람으로 즉시 감지하도록 룰을 박아둡니다.

**Q10. Object Storage 비용은 어떻게 통제해요?**
> 본 프로젝트는 Always Free 20GB 한도 안에서 다른 컴포넌트(Loki, Velero, Vault snapshot)와 경합합니다. 통제 방법: (1) Compactor retention을 짧게 (raw 7일, 5분 30일, 1시간 1년), (2) ServiceMonitor의 relabel_configs로 high-cardinality label drop해서 series 수 자체를 줄임, (3) Prometheus의 `--storage.tsdb.retention.size`로 local 디스크 상한 강제. 또 OCI bucket lifecycle policy로 30일 이상 안 쓴 객체 자동 삭제도 옵션이지만 본 프로젝트는 Compactor가 책임지므로 안 씁니다.
