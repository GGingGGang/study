# HPA + Prometheus Adapter

## 1. Why — 왜 쓰는가

**HPA (Horizontal Pod Autoscaler)**: Pod replicas를 부하에 따라 자동으로 조절. k8s 기본 리소스.
**Prometheus Adapter**: HPA가 CPU/메모리 외에 Prometheus 커스텀 메트릭(RPS, latency 등)으로도 스케일 가능하게 만드는 어댑터.

**기본 HPA의 한계**:
- CPU/메모리 기반만 → 트래픽 폭증해도 CPU 안 올라가면 스케일 안 됨
- 핀테크 워크로드는 I/O bound가 많아서 CPU 사용률 낮은데도 latency가 폭증하는 케이스 흔함
- 큐 길이, 활성 connection 수 같은 비즈니스 메트릭으로 스케일이 더 정확

**Prometheus Adapter의 해결**:
- Prometheus의 PromQL 결과를 k8s metrics API에 노출
- HPA가 `custom.metrics.k8s.io`로 RPS 같은 커스텀 메트릭 조회 가능
- 결과: "Pod당 RPS 100 초과 시 스케일 아웃" 같은 비즈니스 친화적 정책

**대체재**:
- **KEDA**: event-driven autoscaling. Kafka lag, Redis queue 등 50+ source 기반 스케일. Prometheus Adapter보다 광범위.
- **Karpenter**: 노드 레벨 autoscaling (HPA가 Pod 못 띄울 때 노드 추가). 본 프로젝트는 OCI 미지원이라 사용 불가.
- **Cluster Autoscaler**: 노드 풀 기반. OKE Basic 미지원 (Enhanced 전용).

본 프로젝트는 **HPA + Prometheus Adapter** 조합으로 Pod 레벨만 스케일. 노드 autoscaling은 안 함 (Always Free 한계). 미래 확장 시 KEDA 추가 가능.

## 2. Architecture — 어떻게 구성되는가

**HPA 컴포넌트**:
- **HPA controller** (kube-controller-manager 일부): HPA 리소스 watch + 메트릭 조회 + replicas 조정
- **metrics-server** (또는 동등): CPU/메모리 메트릭 노출 (`resource.metrics.k8s.io`)
- **Prometheus Adapter**: 커스텀 메트릭 노출 (`custom.metrics.k8s.io`, `external.metrics.k8s.io`)

**메트릭 API 종류**:
1. **resource.metrics.k8s.io**: CPU/메모리 (metrics-server 제공)
2. **custom.metrics.k8s.io**: 클러스터 내부 메트릭 (Prometheus Adapter)
3. **external.metrics.k8s.io**: 외부 메트릭 (예: Kafka lag from outside)

**HPA 동작 흐름**:
1. HPA controller가 15초마다 (default) 메트릭 조회
2. 현재 평균과 target 비교
3. desired replicas 계산: `desired = ceil(current * (current_metric / target_metric))`
4. 변동이 thresholds 넘으면 Deployment의 replicas 업데이트
5. ReplicaSet controller가 Pod 추가/삭제

## 3. Mechanism — 어떻게 돌아가는가

**CPU 기반 HPA**:
- HPA controller가 metrics-server에 query: `pods/<pod>/cpu`
- 모든 Pod CPU 평균 계산
- target=70%, current=85% → desired = ceil(3 * 85/70) = 4 (replicas 3 → 4)

**Custom metric (RPS) 기반**:
- Prometheus가 `http_requests_total{job="login"}` 수집
- Prometheus Adapter가 이걸 `pods/login-xxx/http_requests_per_second`로 expose
- HPA가 query → 평균 RPS 계산
- target=100 RPS/pod, current=150 RPS/pod → 스케일 아웃

**Scale up/down behavior**:
- Scale up: 즉시 가능 (default)
- Scale down: 5분 stabilization window (오토스케일 oscillation 방지)
- 본 프로젝트는 fintech라 traffic spike 잦을 수 있어 scale down을 더 보수적으로 (10분)

**Prometheus Adapter config**:
- `seriesQuery`: 어떤 메트릭을 노출할지
- `resources.overrides`: Prometheus label과 k8s resource 매핑 (`namespace → namespace`)
- `name.matches`/`name.as`: 메트릭 이름 변환
- `metricsQuery`: 실제 query (rate() 등)

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 HPA + Adapter 의존 관계.

- **앱 (Login/Core/Batch)** — HPA target
- **Prometheus** (kube-prometheus-stack) — 메트릭 source
- **Prometheus Adapter** — `monitoring` namespace 배포
- **metrics-server** — OKE 기본 설치됨 (CPU/메모리)
- **kube-controller-manager** — HPA controller 내장

**HPA가 동작하지 않는 흔한 원인**:
1. metrics-server 미설치 또는 다운
2. Prometheus Adapter config 오류
3. Pod에 resources.requests 없음 (HPA가 % 계산 못 함)
4. HPA target metric의 label이 Prometheus와 불일치

## 5. Usage — 어떻게 쓰는가

**metrics-server 확인** (OKE에 기본):

```bash
kubectl get deployment metrics-server -n kube-system
kubectl top nodes
kubectl top pods -n app
```

**Prometheus Adapter 설치** (Helm):

```bash
helm install prometheus-adapter prometheus-community/prometheus-adapter \
  --namespace monitoring \
  --version 4.x \
  -f adapter-values.yaml
```

adapter-values.yaml:
```yaml
prometheus:
  url: http://prometheus-operated.monitoring.svc
  port: 9090

rules:
  default: false              # 기본 룰 비활성 (수동 정의)
  custom:
  # HTTP RPS per pod
  - seriesQuery: 'http_requests_total{namespace!="",pod!=""}'
    resources:
      overrides:
        namespace: { resource: "namespace" }
        pod: { resource: "pod" }
    name:
      matches: "^(.*)_total"
      as: "${1}_per_second"
    metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
```

**기본 CPU HPA**:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: login
  namespace: app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: login
  minReplicas: 2
  maxReplicas: 6
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 600    # 10분 (보수적)
      policies:
      - type: Percent
        value: 25                         # 한 번에 25%씩만 줄임
        periodSeconds: 60
    scaleUp:
      stabilizationWindowSeconds: 0       # 즉시
      policies:
      - type: Percent
        value: 100                        # 한 번에 2배까지 가능
        periodSeconds: 60
```

**Custom metric (RPS) HPA**:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: login-rps
  namespace: app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: login
  minReplicas: 2
  maxReplicas: 6
  metrics:
  - type: Pods
    pods:
      metric:
        name: http_requests_per_second
      target:
        type: AverageValue
        averageValue: "100"    # Pod당 RPS 100
  - type: Resource              # CPU 70%와 OR 조건
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

**복합 HPA** (여러 메트릭 중 가장 높은 desired 선택):
- HPA는 multiple metrics를 OR로 처리 → 어느 하나라도 trigger 시 스케일

**검증 명령**:

```bash
# HPA 상태
kubectl get hpa -n app
kubectl describe hpa login -n app

# 커스텀 메트릭 API 확인
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/app/pods/*/http_requests_per_second" | jq

# Prometheus Adapter 로그
kubectl logs deploy/prometheus-adapter -n monitoring
```

## 6. Configuration — 어떤 설정이 있는가

**HPA target 종류**:
- `Resource`: CPU/메모리 (resource.metrics.k8s.io)
- `Pods`: Pod 단위 average (custom.metrics.k8s.io)
- `Object`: 단일 object 메트릭 (예: Ingress RPS)
- `External`: 클러스터 외부 (Kafka lag 등)

**Behavior 옵션** (HPA v2):
- `stabilizationWindowSeconds`: 변동 평균 윈도우. scale down 사이즈 안정화.
- `policies.type`: `Percent`(비율) vs `Pods`(절대값)
- `policies.value`: 단계당 변화량
- `selectPolicy`: `Max`(가장 큰 변화) vs `Min`(가장 작은) vs `Disabled`

**Prometheus Adapter rule 옵션**:
- `seriesQuery`: 메트릭 필터
- `resources`: k8s resource(namespace, pod 등)와 Prometheus label 매핑
- `name.matches`: regex로 메트릭 이름 매칭
- `name.as`: 변환된 이름
- `metricsQuery`: 실제 PromQL (`<<.Series>>`, `<<.LabelMatchers>>`, `<<.GroupBy>>` 변수 사용)

**스케일 안정성**:
- Min/Max replicas 차이를 너무 크게 두면 oscillation 가능
- Cooldown 충분히 (5-10분)
- Behavior로 단계적 변화 제한

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+** (HPA v2 stable)
- **Prometheus Adapter 0.12+** (2026-05 권장)
- **HPA API version**: `autoscaling/v2` (v1은 CPU만, v2beta는 deprecated)
- **metrics-server 0.7+**
- **OKE Basic**: metrics-server 기본 설치됨, Prometheus Adapter는 별도 설치

## 8. 면접 예상 질문 & 답변

**Q1. CPU만 기반으로 HPA 하는 게 왜 부족해요?**
> 핀테크 워크로드는 I/O bound가 많아서 CPU 사용률은 낮은데 latency가 폭증하는 케이스가 흔합니다. 예를 들어 DB query가 느려져서 응답이 쌓이면 CPU는 30%인데 latency P99가 5초가 됩니다. CPU 기반 HPA는 안 트리거되고 사용자는 timeout 경험. 그래서 RPS, latency, queue 길이 같은 비즈니스 메트릭이 필요하고, Prometheus Adapter가 이걸 HPA에서 사용 가능하게 만들어줍니다. 본 프로젝트는 CPU(70%) + Pod당 RPS(100)을 OR 조건으로 둬서 둘 중 하나라도 넘으면 스케일합니다.

**Q2. Prometheus Adapter와 KEDA 차이는?**
> Prometheus Adapter는 Prometheus 메트릭을 k8s metrics API로 expose하는 도구입니다. KEDA는 더 광범위한 event source(Kafka lag, RabbitMQ, Redis queue, Azure Service Bus 등 50+)를 지원하는 autoscaling 도구입니다. KEDA는 ScaledObject CRD로 정의하고 내부적으로 HPA를 만듭니다. 본 프로젝트는 RPS 같은 Prometheus 메트릭만 쓰므로 Prometheus Adapter로 충분하지만, 미래에 Kafka consumer lag 기반 스케일링이 필요하면 KEDA 추가가 자연스럽습니다.

**Q3. HPA가 동작 안 해요. 디버깅 순서는?**
> 다섯 단계로 봅니다. (1) `kubectl describe hpa <name>` — Conditions와 Events에서 오류 메시지 확인. (2) Pod에 `resources.requests` 정의 안 됐으면 CPU % 계산 불가 — 추가. (3) `kubectl top pods` 동작 확인 — metrics-server 살아있는지. (4) Custom metric이면 `kubectl get --raw "/apis/custom.metrics.k8s.io/..."`로 메트릭 노출 확인. (5) Prometheus Adapter 로그에서 query 오류 확인. 대부분 (2) resources.requests 누락 또는 (4) Adapter config 매핑 오류입니다.

**Q4. Scale down 시간을 길게 하는 이유는?**
> Scale down은 oscillation 위험이 큽니다. 트래픽이 잠시 줄어들어 Pod 1개로 축소했는데 30초 후 다시 트래픽 폭증하면 또 스케일 아웃해야 합니다. Pod 시작 시간(40초 ~ 1분, Java는 더 김)을 감안하면 그 사이 latency 폭증과 에러가 발생합니다. 본 프로젝트는 scale down stabilizationWindowSeconds 600(10분) + 한 번에 25%만 줄여서 점진적으로 줄입니다. Scale up은 즉시 + 100% (2배) 가능하게 둬서 trafic spike에 빠르게 대응합니다.

**Q5. 본 프로젝트 maxReplicas를 6으로 잡은 근거는?**
> Always Free 노드 2개 × 12GB = 24GB RAM, Login Server resources.requests=64Mi라 이론상 수백 개 가능합니다. 하지만 (1) 단일 노드 장애 시 다른 노드로 모든 replica가 몰리면 노드 자원 초과, (2) HPA가 너무 많은 Pod를 만들면 Pod startup 부담, (3) LB 10Mbps 병목이 먼저 도달. 그래서 6으로 보수적으로 잡았습니다. 면접에서 "production 환경 + 노드 autoscaling 가능하면 maxReplicas 20+로 확장 가능"이라 답합니다.

**Q6. PromQL의 rate() vs irate() 어느 걸 HPA에 써요?**
> rate()를 씁니다. rate(http_requests_total[2m])은 2분 윈도우 평균이라 부드럽고 noise가 적습니다. irate()는 마지막 2 datapoint만 보므로 spike에 너무 민감해서 HPA가 oscillation 합니다. 본 프로젝트 Adapter config의 metricsQuery는 `sum(rate(...[2m]))` 사용. 윈도우는 scrape interval(30s)의 4배 이상 (2분)이 권장입니다.

**Q7. HPA에서 multiple metrics를 어떻게 처리해요?**
> OR 조건입니다. CPU 70% + RPS 100을 둘 다 명시하면, HPA가 각각 desired replicas를 계산하고 **가장 높은 값**을 채택합니다. 예: CPU가 50%(desired 3), RPS가 150 RPS/pod(desired 6) → max(3, 6) = 6으로 스케일. 이 동작은 "조금이라도 부하 신호가 있으면 보수적으로 더 띄우자"는 의미라 안전합니다. 단점은 어떤 메트릭이 트리거인지 명확히 추적해야 하는데 `kubectl describe hpa`의 Conditions로 확인 가능합니다.

**Q8. Pod resources.requests가 HPA에 왜 중요해요?**
> CPU Utilization 기반 HPA는 `current CPU / requests CPU`로 % 계산합니다. requests가 100m이고 current가 80m이면 80% utilization. requests가 없으면 division by zero라 HPA가 동작 안 합니다. 또 requests는 스케줄러가 노드 선택 시 보장하는 값이라 Pod이 실제로 그 만큼 사용 가능합니다. requests > limits 설정은 의미 없고, requests == limits로 두면 QoS class Guaranteed가 되어 노드 부족 시 가장 안전합니다. 본 프로젝트는 모든 앱 Pod에 requests = limits 패턴.

**Q9. Prometheus Adapter가 죽으면 어떻게 되나요?**
> custom metric 기반 HPA가 동작 안 합니다. CPU 기반 HPA는 metrics-server를 쓰므로 영향 없습니다. Adapter 다운 시 HPA가 "metric not available" 상태가 되고 replicas는 현재 상태 유지(스케일 안 함). 트래픽 폭증해도 자동 대응 안 되므로 즉시 Slack alert 필요. Adapter는 stateless라 재기동 1분 이내 회복.

**Q10. KEDA를 도입한다면 어떤 시나리오에서?**
> 본 프로젝트의 Batch Server가 Kafka consumer라, **Kafka consumer lag 기반 스케일링**이 가장 자연스러운 KEDA 시나리오입니다. Batch가 lag > 1000이면 consumer Pod을 늘려서 lag을 줄이고, lag 0이면 1개로 축소. 또 (1) Redis queue 길이 기반 worker 스케일링, (2) HTTP 트래픽 cron 패턴 기반 시간 기반 스케일링(예: 평일 9시 미리 스케일 아웃)도 KEDA 시나리오. 본 프로젝트는 Phase 5 단계에서는 Prometheus Adapter로 충분하나 향후 확장 narrative로 KEDA 답변 준비.

**Q11. HPA가 Pod 수를 너무 자주 바꿔요. 어떻게 안정화해요?**
> 세 가지 방어선이 있습니다. (1) `behavior.scaleDown.stabilizationWindowSeconds`를 길게 (10분 이상). (2) `behavior.scaleUp.stabilizationWindowSeconds`도 약간 (30초). (3) HPA target value를 약간 여유 있게 (RPS target 80 대신 100 — 일반 트래픽에서 oscillation 안 발생). 또 메트릭 자체의 noise를 줄이려면 PromQL에서 `[5m]`처럼 더 긴 윈도우 사용. 본 프로젝트는 이 셋을 조합해서 oscillation 최소화합니다.

**Q12. resources.requests를 어떻게 정해야 해요?**
> 부하 테스트로 측정합니다. k6(Phase 6-D)로 일반 트래픽 부하 주면서 Pod의 CPU/메모리 실제 사용량을 Grafana로 관찰. P95 사용량 + 20% 마진을 requests로 설정. limits는 requests와 같게 두는 게 본 프로젝트 표준 (QoS Guaranteed). 처음부터 정확히 알기 어려우니 (1) 보수적으로 시작(과대 추정 OK), (2) 일주일 운영 후 actual 사용량으로 조정, (3) HPA가 maxReplicas 도달하지 않게 모니터링. 면접에서 "측정 기반 조정 + maxReplicas 모니터링"으로 답합니다.
