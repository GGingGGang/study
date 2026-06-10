# Grafana Tempo

## 1. Why — 왜 쓰는가

분산 트레이싱 백엔드. "어느 service에서 어느 service로 요청이 흘렀는가"를 시각화. 토스급 옵저버빌리티 삼각형의 마지막 변(Metrics + Logs + **Traces**).

**분산 시스템에서 트레이싱이 필요한 이유**:
- 단일 요청이 5개 service를 거치면 어디서 느려졌는지 메트릭만으로는 알 수 없음
- 로그는 service별로 분산 → trace_id 없이는 연결 불가
- "P99 latency가 갑자기 늘었다" → 어느 service의 어느 단계에서?

**Tempo의 해결**:
- W3C Trace Context 표준 기반 분산 트레이스 수집
- Object Storage 우선 — index 없음(Loki와 같은 컨셉)
- TraceID로만 조회. 검색은 다른 시스템(Loki, Prometheus)에서 시작
- **Grafana 통합 — 메트릭 ↔ 로그 ↔ 트레이스 jump**

**대체재**:
- **Jaeger**: CNCF graduated. 가장 광범위 사용. ES backend 부담.
- **Zipkin**: Twitter 출신. 오래된 표준.
- **DataDog APM / New Relic**: SaaS, 비용
- **Tempo**: Grafana 진영. Loki/Prometheus와 통합 매끄러움. Object Storage 우선이라 경제적.

본 프로젝트는 **Loki + Tempo + Prometheus 삼각형이 Grafana 단일 UI에서 통합**되는 시너지가 핵심.

## 2. Architecture — 어떻게 구성되는가

**Tempo 배포 모드**:
- **Single Binary**: 본 프로젝트 선택. 모든 컴포넌트 한 프로세스.
- **Microservice**: 대규모용. distributor / ingester / querier 분리.

**Tempo 컴포넌트** (Single binary 안):
- **Distributor**: 들어온 span을 ingester에 분배
- **Ingester**: 메모리에 trace 누적 → block flush
- **Querier**: TraceID로 조회
- **Compactor**: block compaction

**Trace data flow**:
- **Span**: 한 service에서 한 단계 (예: "DB query"). 시작/종료 시각, attributes 포함.
- **Trace**: 같은 trace_id를 가진 span들의 묶음. 트리 구조.
- **OTLP**: OpenTelemetry Protocol. gRPC 또는 HTTP로 span 전송 표준.

## 3. Mechanism — 어떻게 돌아가는가

**Trace 생성 흐름**:

1. 외부 요청이 Istio Gateway에 도착
2. Istio가 자동으로 trace context 생성 (W3C traceparent header)
3. 백엔드 service로 propagate (앱이 traceparent header 받음)
4. 앱의 OpenTelemetry SDK가 자식 span 생성 + 자기 작업의 시작/종료 기록
5. 다른 service 호출 시 traceparent 다시 전파
6. 각 service가 자기 span을 OTLP로 Tempo에 push
7. Tempo가 trace_id로 모든 span 묶어 저장

**Tempo가 자동으로 받는 span 종류**:
- **Istio span**: gateway/sidecar/waypoint 통과 시 자동 생성. ServiceA → ServiceB 트래픽 자동 추적.
- **App span**: 앱 코드에 OTel SDK 추가 시 DB query, Redis call 등 세부 단계 추적.

**저장 흐름**:
- Ingester가 메모리에 5분 또는 chunk 크기 도달 시 block 생성
- Block을 Object Storage(또는 local PV)에 저장
- TraceID 인덱스는 block 안에 포함됨 (별도 index store 없음)

**쿼리 흐름**:
- TraceID 조회: Tempo가 모든 block을 빠르게 스캔 (TraceID 인덱스 활용)
- 본 프로젝트는 TraceID로만 조회. Grafana에서 Loki 로그 → trace_id 클릭 → Tempo로 jump

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Tempo 의존 관계.

- **Istio** — 자동 trace span 생성 (config에서 sampling rate 조정)
- **OpenTelemetry SDK (앱)** — 앱 코드에 추가 (Go: otel-go, Python: opentelemetry-python)
- **Block Volume** — local PV 사용 (본 프로젝트, Object Storage 경합 회피, 24h retention)
- **Grafana** — DataSource로 Tempo 등록 + Loki ↔ Tempo derivedFields
- **Prometheus** — Tempo 자체 메트릭 수집

**Local PV vs Object Storage 결정**:
- Loki/Thanos는 Object Storage 사용 → 20GB 경합
- Tempo는 디버깅용이고 24h retention만 필요 → Block Volume 20GB로 충분
- 본 프로젝트는 **Tempo만 local PV** 선택해서 Object Storage 압박 완화

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install tempo grafana/tempo \
  --namespace monitoring \
  --version 1.x \
  -f tempo-values.yaml
```

tempo-values.yaml (single binary, local PV):
```yaml
tempo:
  storage:
    trace:
      backend: local
      local:
        path: /var/tempo/traces
  retention: 24h               # 짧은 retention
  
  ingester:
    max_block_duration: 5m
    
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
    
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { cpu: 500m, memory: 512Mi }

persistence:
  enabled: true
  storageClassName: oci-bv
  size: 15Gi
```

**Istio trace sampling 활성화** (mesh config):

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: default
  namespace: istio-system
spec:
  tracing:
  - providers:
    - name: tempo-otel
    randomSamplingPercentage: 1.0    # 1% sampling (production)
```

```yaml
# Istio mesh config에 provider 등록
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
  meshConfig:
    extensionProviders:
    - name: tempo-otel
      opentelemetry:
        service: tempo.monitoring.svc.cluster.local
        port: 4317
```

**Grafana DataSource 추가**:

```yaml
datasources:
- name: Tempo
  type: tempo
  uid: tempo
  url: http://tempo.monitoring.svc:3100
  jsonData:
    tracesToLogsV2:
      datasourceUid: loki
      tags: ['service.name', 'pod']
    tracesToMetrics:
      datasourceUid: prometheus
      tags: ['service.name']
    serviceMap:
      datasourceUid: prometheus
```

**앱 코드 OpenTelemetry SDK 예시** (Go):

```go
import (
    "go.opentelemetry.io/otel"
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
    "go.opentelemetry.io/otel/sdk/trace"
)

// 초기화
exporter, _ := otlptracegrpc.New(ctx,
    otlptracegrpc.WithEndpoint("tempo.monitoring.svc.cluster.local:4317"),
    otlptracegrpc.WithInsecure(),
)
tp := trace.NewTracerProvider(
    trace.WithBatcher(exporter),
    trace.WithSampler(trace.TraceIDRatioBased(0.01)),  // 1%
)
otel.SetTracerProvider(tp)

// 사용
tracer := otel.Tracer("login-service")
ctx, span := tracer.Start(ctx, "validateJWT")
defer span.End()
span.SetAttributes(attribute.String("user.id", userID))
```

## 6. Configuration — 어떤 설정이 있는가

**Sampling 정책**:
- `head-based sampling`: 트레이스 시작 시 결정 (예: 1% 무작위)
- `tail-based sampling`: 트레이스 완성 후 결정 (에러나 느린 요청만 유지) — Tempo 자체 미지원, OTel Collector로 가능
- 본 프로젝트는 simple하게 head-based 1% sampling

**Retention 옵션**:
- `retention`: trace 보관 기간 (본 프로젝트 24h)
- 디버깅 용도라 길게 보관할 필요 없음
- 만약 prod 사고 분석 위해 더 길게 필요하면 Object Storage로 이전 + 7일 retention

**Backend 선택**:
- `local`: Block Volume PV. 본 프로젝트.
- `s3`: Object Storage. Loki와 경합.
- `gcs`, `azure`: 다른 클라우드

**Receiver protocols**:
- `otlp.grpc`: 4317 포트, 기본
- `otlp.http`: 4318 포트, HTTP/1.1
- `jaeger`: Jaeger 호환 (legacy)
- `zipkin`: Zipkin 호환 (legacy)

**Ingester 옵션**:
- `max_block_duration`: 메모리 block을 flush할 최대 시간 (default 5m)
- `max_block_bytes`: 메모리 block flush 크기 (default 500MB)
- 본 프로젝트는 작은 트래픽이라 default로 충분

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Tempo 2.x+** (2026-05 권장)
- **OpenTelemetry Protocol (OTLP)**: gRPC 또는 HTTP. 표준.
- **Istio 1.20+**: telemetry.istio.io/v1 API 사용
- **W3C Trace Context**: traceparent header propagation 표준
- **Grafana 10+**: tracesToLogsV2, tracesToMetrics 지원
- **Backend 호환**: local (PV), S3 호환 Object Storage, GCS, Azure Blob

## 8. 면접 예상 질문 & 답변

**Q1. 분산 트레이싱이 왜 필요해요?**
> 마이크로서비스 환경에서 단일 외부 요청이 5-10개 service를 거칠 수 있는데, 메트릭만으로는 어디서 느려졌는지 알 수 없습니다. 로그만으로는 service별로 흩어져서 연결이 안 됩니다. 분산 트레이싱은 trace_id를 통해 한 요청의 전 흐름을 시각화해서 "API gateway에서 10ms, login service에서 200ms, DB query에서 850ms"같이 단계별 latency 분해를 가능하게 합니다. 본 프로젝트는 Login → Core → Batch 3단계 흐름이 있어 트레이싱 가치가 명확합니다.

**Q2. Tempo 골랐는데 Jaeger 안 골랐어요?**
> Jaeger는 CNCF graduated 표준이지만 본 프로젝트는 Tempo를 선택했습니다. 사유는 (1) Grafana 진영 통합 — Loki + Prometheus + Tempo가 Grafana 단일 UI에서 jump 가능, (2) Object Storage 우선 설계로 Always Free 환경 정합 — Jaeger의 Elasticsearch backend는 자원 부담 큼, (3) Tempo는 인덱스 없는 구조라 운영 단순. 단점은 Jaeger 대비 검색 기능이 제한적(trace_id로만 조회)이지만 본 프로젝트는 Loki로 검색 후 trace_id 추출하는 패턴이라 충분합니다.

**Q3. Tempo가 인덱스 없이 어떻게 trace를 빠르게 찾아요?**
> trace_id를 block 안에 포함된 작은 인덱스(Bloom filter 같은)로 찾습니다. 모든 block을 스캔하지만 Bloom filter로 매칭 안 되는 block은 즉시 skip하므로 사실상 O(log N) 가까운 성능입니다. **trace_id 외의 검색은 안 됩니다.** 그래서 "어제 5xx 에러난 요청들의 트레이스 찾기"는 Loki에서 먼저 로그 검색 → trace_id 추출 → Tempo에서 조회하는 흐름이 표준입니다. 본 프로젝트는 Grafana derivedFields로 이 jump가 자동 링크됩니다.

**Q4. Istio가 자동으로 span을 만든다는 게 무슨 뜻이에요?**
> Istio sidecar(또는 Ambient의 ztunnel/waypoint)는 모든 요청을 가로채는데, 가로챈 시점에 자동으로 W3C trace context를 추가하고 sample되면 자기 span을 OTel/Zipkin 형식으로 외부 collector에 push합니다. 결과적으로 앱 코드를 전혀 안 바꿔도 service-to-service 호출의 latency가 자동으로 추적됩니다. 단점은 service 내부 단계(DB query 등)는 안 보이므로, 진짜 깊은 트레이싱은 앱 코드에 OTel SDK를 추가해서 자식 span을 만들어야 합니다.

**Q5. Sampling rate를 1%로 설정한 이유는?**
> 본 프로젝트는 production-like 환경 시뮬레이션이라 1% sampling이 표준입니다. 100% sampling은 (1) 저장 공간 폭증, (2) trace 자체가 network overhead 추가, (3) 정상 트레이스는 대부분 비슷해서 통계적 분석에 큰 가치 없음 — 세 가지 이유로 production에서 거의 안 합니다. 1% sampling으로도 P99 outlier는 대부분 잡힙니다. dev 환경에서는 100%로 풀어서 디버깅합니다.

**Q6. Tail-based sampling이 뭐고 왜 안 쓰나요?**
> Tail-based sampling은 트레이스가 완성된 후 "에러가 있었나" "느렸나"를 보고 sample 여부를 결정하는 방식입니다. Head-based(시작 시 결정)는 빠른 요청은 버려지고 느린 요청은 sample되지 않는 운 없는 케이스가 생기는데, tail-based는 모든 에러/slow trace를 보장합니다. 단 모든 trace를 일단 수집해야 하므로 OTel Collector에 메모리/CPU 부담이 큽니다. Tempo 자체는 tail-based 미지원이라 OTel Collector를 별도로 두고 거기서 처리해야 합니다. 본 프로젝트는 단순성 우선으로 head-based만 사용합니다.

**Q7. Grafana에서 로그 → 트레이스 jump가 어떻게 동작해요?**
> Grafana DataSource 설정의 derivedFields입니다. Loki DataSource에 `matcherRegex: 'trace_id=(\w+)'`로 로그 본문에서 trace_id 패턴을 추출하고, `datasourceUid: tempo`로 Tempo DataSource를 지정합니다. 그러면 Loki에서 로그를 보다가 trace_id가 있는 줄에 자동으로 클릭 가능한 링크가 생기고, 클릭하면 Tempo로 jump해서 해당 trace의 전체 흐름을 봅니다. 본 프로젝트의 narrative에서 가장 강력한 데모 영역입니다.

**Q8. Tempo가 Object Storage 안 쓰고 local PV 쓰는 이유는?**
> Always Free Object Storage 20GB가 Thanos + Loki + Velero + Vault snapshot 4개 컴포넌트 경합 영역이라 Tempo까지 합류하면 빠듯합니다. Tempo는 (1) 디버깅 용도라 장기 보관 가치 낮음, (2) 24h retention이면 충분, (3) 트래픽이 작아서 local PV 15GB로 충분 — 세 가지 이유로 local PV로 분리했습니다. Object Storage 압박 완화가 핵심 결정 사유입니다.

**Q9. OpenTelemetry SDK가 앱에 어떤 영향을 줘요?**
> CPU/메모리 overhead가 약간 추가됩니다. Sampling 1%면 99% 요청은 trace context 생성과 baggage propagation만 수행하므로 매우 가벼움 (~1% CPU). Sampled trace는 span 생성 + attribute 기록 + batch sending으로 ~3-5% overhead. 대신 분산 시스템 디버깅 능력이 압도적이라 트레이드오프가 명확합니다. 본 프로젝트는 1% sampling이라 평균 overhead 1% 이하 예상됩니다.

**Q10. Tempo + Loki + Prometheus 통합 narrative를 면접에서 어떻게 설명해요?**
> "토스급 옵저버빌리티 삼각형"이라고 답합니다. (1) Prometheus 메트릭에서 P99 latency 급증 감지 → (2) 해당 시간대 Loki 로그 조회로 에러 패턴 발견 → (3) 에러 로그의 trace_id 클릭으로 Tempo jump해서 어느 service에서 느려졌는지 확인 → (4) 다시 메트릭으로 돌아가 해당 service의 CPU/메모리 상태 확인. 이 30초 흐름이 Grafana 단일 UI에서 가능한 게 통합 옵저버빌리티의 가치고, 단일 도구로는 불가능합니다. 본 프로젝트의 가장 강력한 데모 포인트입니다.
