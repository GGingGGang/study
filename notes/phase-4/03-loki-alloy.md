# Loki + Grafana Alloy

## 1. Why — 왜 쓰는가

**Loki**: Grafana Labs의 로그 집계 시스템. "Prometheus for logs"라는 컨셉.
**Alloy**: OpenTelemetry Collector 기반 통합 에이전트. Promtail의 후계자.

**왜 묶어서 다루는가**: Loki는 server 측, Alloy는 client 측. 둘이 항상 같이 쓰임.

**기존 로깅의 문제**:
- ELK (Elasticsearch + Logstash + Kibana): 강력하나 무거움. 단일 노드 1GB+ RAM. 풀텍스트 인덱싱 비용 큼.
- Fluentd + ES: 자원 부담 큼
- CloudWatch / Stackdriver: SaaS 비용
- 로그 양이 메트릭의 10-100배라 인덱싱 비용이 폭증

**Loki의 해결**:
- **label 기반 인덱싱만**: 로그 본문은 인덱싱 안 함. Prometheus처럼 label로만 인덱싱.
- **Object Storage 우선**: chunk를 Object Storage에 저장. local PV는 인덱스만.
- **LogQL**: PromQL 유사 쿼리 언어. `{app="login"} |= "error"` 같은 식
- **Grafana 통합**: DataSource로 추가하면 메트릭과 트레이스랑 같이 보기 가능

**Promtail → Alloy 마이그레이션**:
- **Promtail은 2026-03-02 EOL 공식 deprecated**
- Alloy는 OpenTelemetry Collector 기반 통합 에이전트. 로그 + 메트릭 + 트레이스 + profile 수집을 단일 binary로
- Promtail의 모든 기능 + OTel 호환 + 더 광범위한 source

**대체재**:
- **Elasticsearch + Kibana**: 풀텍스트 검색 강력. 인덱싱 비용 큼.
- **Splunk**: Enterprise 표준이나 매우 비쌈
- **Vector**: Datadog 출신. Alloy와 유사한 통합 에이전트.
- **Loki + Alloy**: Always Free 환경 최적. CNCF 진영 표준.

## 2. Architecture — 어떻게 구성되는가

**Loki 배포 모드 3가지**:
1. **Single Binary (Monolithic)**: 모든 컴포넌트(distributor, ingester, querier, compactor)를 한 프로세스에. 단일 노드. 본 프로젝트 선택.
2. **Simple Scalable (SSD)**: read/write path 분리. 3+ 노드.
3. **Microservice**: 각 컴포넌트 별도 Pod. 대규모 환경.

**Loki 컴포넌트** (Single Binary 안에 모두):
- **Distributor**: 들어온 로그를 ingester에 분배
- **Ingester**: 메모리에 chunk 누적 → 일정 시간/크기 후 Object Storage에 flush
- **Querier**: LogQL 쿼리 처리
- **Query Frontend**: 쿼리 splitting + caching
- **Compactor**: 오래된 chunk를 더 큰 단위로 통합 (S3 비용 절약)

**Alloy 컴포넌트**:
- **DaemonSet**: 노드당 1개. 노드의 모든 Pod 로그 수집.
- Configuration은 River 언어 (HCL 비슷). Promtail의 YAML과 다름.
- 본 프로젝트는 로그 수집만 사용 (메트릭은 Prometheus, 트레이스는 Tempo).

## 3. Mechanism — 어떻게 돌아가는가

**로그 수집 흐름**:

1. Pod이 stdout/stderr에 로그 출력
2. kubelet이 노드의 `/var/log/pods/<ns>_<pod>_<uid>/<container>/*.log`에 기록
3. Alloy DaemonSet이 이 경로를 watch (inotify)
4. Alloy가 로그 line을 읽어서 label 추가 (namespace, pod, container 등)
5. Alloy → Loki Distributor (HTTP push, gRPC)
6. Distributor가 stream(label 조합)에 해당하는 Ingester 결정 (consistent hashing)
7. Ingester가 메모리에 chunk 누적
8. 15분 또는 chunk가 5MB 도달 시 Object Storage에 flush (compressed)
9. 동시에 index를 BoltDB-shipper 또는 TSDB index store에 기록

**쿼리 흐름**:

1. Grafana에서 LogQL 쿼리 (`{app="login"} |= "error" |~ "user_id=(\\d+)"`)
2. Querier가 인덱스에서 매칭되는 stream 찾기
3. 해당 stream의 chunk를 Object Storage에서 가져옴
4. chunk 내용에서 `|=` (contains), `|~` (regex) 필터 적용
5. 결과 반환

**핵심 비유**: Prometheus는 메트릭에서 했던 것을 Loki가 로그에서 함. label 인덱싱 + chunk 저장 + 시간 범위 쿼리.

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Loki + Alloy 의존 관계.

- **OCI Object Storage** — chunk + index 저장. 20GB 경합 영역
- **Block Volume** — Loki single binary 인스턴스의 local index cache (~5GB)
- **Grafana** — DataSource로 Loki 등록
- **Alloy DaemonSet** — 모든 노드에 배포, 모든 Pod의 stdout/stderr 수집
- **앱 (Login/Core/Batch)** — 구조화된 JSON 로그 출력 권장 (Loki label 추출 용이)
- **Tempo** — trace_id를 로그에 포함하면 Grafana에서 로그 ↔ 트레이스 jump 가능

**OTel 통합**: Alloy는 OpenTelemetry Collector라 향후 메트릭/트레이스도 통합 수집 확장 가능. 본 프로젝트는 로그만.

## 5. Usage — 어떻게 쓰는가

**Loki 설치** (Helm, single binary 모드):

```bash
helm install loki grafana/loki \
  --namespace monitoring \
  --version 6.x \
  -f loki-values.yaml
```

loki-values.yaml:
```yaml
deploymentMode: SingleBinary
singleBinary:
  replicas: 1
  persistence:
    enabled: true
    storageClass: oci-bv
    size: 5Gi              # local index cache

loki:
  storage:
    type: s3                # Object Storage 인증은 native OCI 없어서 S3 호환 사용
    bucketNames:
      chunks: loki-chunks
      ruler: loki-ruler
      admin: loki-admin
    s3:
      endpoint: <namespace>.compat.objectstorage.<region>.oraclecloud.com
      region: ap-tokyo-1
      accessKeyId: <customer-secret-access-key>
      secretAccessKey: <customer-secret-key>
      s3ForcePathStyle: true
      insecure: false
  limits_config:
    retention_period: 168h   # 7일 retention
  schema_config:
    configs:
    - from: 2024-01-01
      store: tsdb
      object_store: s3
      schema: v13
      index:
        prefix: index_
        period: 24h

# Alertmanager 통합 (선택)
loki:
  ruler:
    alertmanager_url: http://alertmanager-operated.monitoring.svc:9093
```

**Alloy 설치** (Helm, DaemonSet):

```bash
helm install alloy grafana/alloy \
  --namespace monitoring \
  --version 0.x \
  -f alloy-values.yaml
```

alloy-values.yaml:
```yaml
alloy:
  configMap:
    create: true
    content: |
      logging {
        level = "info"
      }
      
      // Discover Kubernetes pods on this node
      discovery.kubernetes "pods" {
        role = "pod"
        selectors {
          role = "pod"
          field = "spec.nodeName=" + sys.env("HOSTNAME")
        }
      }
      
      // Convert k8s labels to Loki labels
      discovery.relabel "pod_logs" {
        targets = discovery.kubernetes.pods.targets
        
        rule {
          source_labels = ["__meta_kubernetes_namespace"]
          target_label = "namespace"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_name"]
          target_label = "pod"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_container_name"]
          target_label = "container"
        }
        rule {
          source_labels = ["__meta_kubernetes_pod_label_app"]
          target_label = "app"
        }
      }
      
      // Read pod logs
      loki.source.kubernetes "pods" {
        targets = discovery.relabel.pod_logs.output
        forward_to = [loki.write.default.receiver]
      }
      
      // Send to Loki
      loki.write "default" {
        endpoint {
          url = "http://loki.monitoring.svc:3100/loki/api/v1/push"
        }
      }

controller:
  type: daemonset
```

**Grafana DataSource 추가**:

```yaml
datasources:
- name: Loki
  type: loki
  url: http://loki.monitoring.svc:3100
  jsonData:
    derivedFields:
    - name: TraceID
      matcherRegex: 'trace_id=(\w+)'
      url: '$${__value.raw}'
      datasourceUid: tempo
```

**LogQL 핵심 쿼리**:

```logql
{namespace="app"}                                        # 모든 app NS 로그
{namespace="app", app="login"}                           # login만
{app="login"} |= "error"                                 # "error" 포함
{app="login"} |~ "5\\d\\d"                                # 5xx 정규식
{app="login"} | json | level="error"                     # JSON 파싱 후 필터
sum by (status) (count_over_time({app="login"}[5m]))     # 5분 카운트 (메트릭처럼)
rate({app="login"} |= "error"[5m])                       # 에러율
```

## 6. Configuration — 어떤 설정이 있는가

**Loki 핵심 옵션**:
- `retention_period`: 보관 기간 (Compactor가 적용)
- `schema_config.configs[*].store`: `tsdb` (최신 권장) vs `boltdb-shipper` (legacy)
- `limits_config.ingestion_rate_mb`: namespace당 ingestion 속도 제한
- `limits_config.max_label_value_length`: high-cardinality 방지
- `chunk_idle_period`: 메모리에서 idle 시 flush (default 30m)

**Alloy core 컴포넌트**:
- `discovery.kubernetes`: k8s API 통해 target 발견
- `discovery.relabel`: label 변환
- `loki.source.kubernetes`: Pod 로그 read
- `loki.process`: 파이프라인 (multiline 처리, label 추출 등)
- `loki.write`: Loki로 push

**Cardinality 통제** (Loki에서 가장 중요):
- label 값이 폭주하면 stream 수 폭증 → 인덱스 폭발
- 금지 패턴: trace_id, request_id, user_id 같은 high-cardinality를 label로
- 권장: 이런 값은 log 본문에 두고 LogQL `| json` 필터로 추출

**Storage 옵션**:
- TSDB index (권장): 효율적 인덱스
- BoltDB-shipper (legacy): 작은 환경 OK
- Object Storage chunk: S3 호환 또는 native (Loki는 native OCI 미지원, S3 호환 사용)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Loki 3.x+** (2026-05 권장). TSDB index 안정.
- **Alloy 1.0+** (Promtail 대체, 2024-12 안정 GA)
- **Promtail 2026-03-02 EOL** — 신규 채택 금지
- **Grafana 10+**: Loki DataSource + derivedFields 지원
- **OCI Object Storage**: native 미지원, S3 호환 모드 필수. Customer Secret Key 인증.
- **OpenTelemetry Collector 호환**: Alloy는 OTel collector라 향후 OTel native source/sink 추가 가능

## 8. 면접 예상 질문 & 답변

**Q1. ELK 안 쓰고 Loki 쓴 이유는?**
> ELK는 풀텍스트 인덱싱을 하므로 로그 양이 폭증할수록 인덱스 비용이 선형 이상으로 증가합니다. 단일 노드 1GB+ RAM 필요하고 디스크도 큽니다. Loki는 "Prometheus for logs"라는 컨셉으로 **label만 인덱싱**하고 로그 본문은 인덱싱 안 합니다. 본문은 chunk로 압축해서 Object Storage에 저장하고, 쿼리 시 grep처럼 스캔합니다. 결과적으로 인덱스 크기가 ELK 대비 1/10 이하이고 Always Free 환경에 적합합니다. 단점은 풀텍스트 검색이 ELK보다 느리지만, 대부분의 운영 쿼리는 namespace/app/severity label로 좁힌 후 작은 범위 grep이라 충분합니다.

**Q2. Promtail 안 쓰고 Alloy 쓴 이유는?**
> Promtail이 **2026-03-02 EOL** 공식 deprecated됐습니다. Grafana Labs가 통합 에이전트 전략으로 OpenTelemetry Collector 기반 Alloy로 이전했습니다. Alloy는 (1) 로그 + 메트릭 + 트레이스 + profile을 단일 binary로 수집 가능, (2) OTel 표준 호환, (3) Promtail의 모든 기능 + 더 광범위한 source 지원. 본 프로젝트는 로그만 쓰지만 향후 OTel native로 확장 가능한 기반을 마련합니다. Promtail에서 Alloy로 마이그레이션은 `alloy convert --source-format=promtail` 명령으로 자동 변환됩니다.

**Q3. Loki single binary vs scalable mode 선택은?**
> single binary는 모든 컴포넌트를 한 프로세스에 묶은 단일 인스턴스 모드입니다. Always Free 환경의 노드 2개 + Loki 부하 작은 본 프로젝트에 적합합니다. scalable mode는 read path와 write path를 분리해서 각각 독립 스케일 가능한데, 3+ 노드 + 실제 production traffic에서 의미가 있습니다. 본 프로젝트는 단순성 우선으로 single binary, 미래 확장 narrative로 "scalable mode 전환이 values.yaml만 바꾸면 가능"을 답변합니다.

**Q4. LogQL의 `|=` `|~` `| json` 차이는?**
> `|=`는 line contains (단순 문자열 매칭). 가장 빠름. `|~`는 정규식 매칭. 빠르지만 `|=`보단 느림. `| json`은 JSON parser. JSON 로그를 파싱해서 label로 추출하므로 그 다음에 `level="error"` 같은 필터 사용 가능. 본 프로젝트는 앱이 구조화된 JSON 로그를 출력하고, 자주 쓰는 필드(level, http_status)를 Alloy 단계에서 label로 추출해서 자주 검색되는 필드는 빠르게 처리하고 가끔 보는 필드는 `| json` 동적 파싱으로 처리합니다.

**Q5. Loki label cardinality 폭주를 어떻게 막아요?**
> 절대 label로 쓰면 안 되는 것: trace_id, request_id, user_id, session_id 같은 unique 또는 high-cardinality 값. label로 쓰는 게 적절한 것: namespace, pod, container, app, level (~5-10개 정도 unique 값). 본 프로젝트는 Alloy의 discovery.relabel 단계에서 명시적으로 namespace/pod/container/app만 label로 추출하고, trace_id 같은 건 로그 본문에서 `| json | trace_id="abc"`로 동적 검색합니다. cardinality 모니터링은 Grafana의 Loki dashboard에 stream 수가 표시됩니다.

**Q6. Loki 인증을 native OCI 안 쓰고 S3 호환 쓴 이유는?**
> Loki가 native OCI provider를 지원하지 않습니다. Thanos는 native OCI 있는데 Loki는 S3 호환만 가능합니다. 이를 위해 OCI Customer Secret Key를 발급받아서 S3 호환 endpoint(`<namespace>.compat.objectstorage.<region>.oraclecloud.com`)로 접근합니다. 단점은 (1) Access Key를 k8s Secret으로 관리해야 하고, (2) Instance Principal 같은 native auth 사용 불가. 향후 Loki가 native OCI provider 추가하면 마이그레이션 검토합니다.

**Q7. trace_id를 로그에 어떻게 포함시키나요? 왜 중요해요?**
> 앱 코드에서 OpenTelemetry SDK가 자동으로 W3C trace context를 propagate하고, 로그 출력 시 현재 context의 trace_id를 JSON 필드로 포함시킵니다. 예: `{"level":"info","msg":"login attempt","trace_id":"abc123","user_id":"u1"}`. Grafana의 derivedFields 설정으로 로그에서 trace_id 발견 시 Tempo로 jump 링크 자동 생성됩니다. 결과적으로 Loki에서 에러 로그 찾고 → 클릭으로 Tempo로 가서 분산 트레이스 확인 → 메트릭과 함께 분석 가능한 통합 옵저버빌리티가 됩니다. 면접에서 강력한 어필 영역입니다.

**Q8. Loki Object Storage 사용량을 어떻게 통제해요?**
> 본 프로젝트는 (1) `limits_config.retention_period: 168h`로 7일 retention 강제, (2) compactor가 매일 동작해서 오래된 chunk 삭제, (3) Alloy 단계에서 불필요 namespace 로그 drop (예: kube-system의 verbose 로그). Object Storage 20GB 중 Loki 할당 6GB라 빠듯하고, log volume이 폭증하면 ingestion rate limit으로 보호합니다. 본 프로젝트는 노드 2개 + 단순 앱이라 일일 log volume이 ~500MB 수준 예상되어 7일 = 3.5GB로 안전합니다.

**Q9. Alloy DaemonSet이 죽으면 어떻게 되나요?**
> 그 노드의 새 로그가 Loki에 안 보내집니다. 다만 kubelet은 노드 로컬에 로그 파일을 계속 누적하므로(`/var/log/pods/*`), Alloy 재기동 시 cursor file을 참고해서 마지막 읽은 위치부터 다시 읽습니다. 결과적으로 짧은 다운(분 단위)은 손실 없이 복구됩니다. 장시간 다운 + 로그 파일 rotation 발생 시에는 일부 로그 손실 가능. Prometheus 알람으로 Alloy DaemonSet의 ready replica 부족을 즉시 감지합니다.

**Q10. Loki vs CloudWatch Logs 어느 게 나은가요?**
> CloudWatch는 SaaS라 운영 부담이 없지만 (1) AWS 종속, OCI에서 비용 발생, (2) 본 프로젝트의 self-host 컨셉 위반, (3) ingestion 비용 + retention 비용이 누적되면 매월 수십만원 가능. Loki는 self-host로 Object Storage만 쓰면 사실상 무료입니다. 운영 부담은 있지만 학습 가치 + 비용 통제 + multi-cloud 이식성 측면에서 Loki가 본 프로젝트에 정합합니다. 회사 환경에 따라 SaaS가 더 합리적일 수도 있습니다.
