# kube-prometheus-stack

## 1. Why — 왜 쓰는가

Kubernetes 환경의 사실상 표준 모니터링 스택을 한 Helm chart로 묶은 메타 차트. Prometheus + Grafana + Alertmanager + node-exporter + kube-state-metrics + Prometheus Operator + 기본 대시보드 + 기본 알람 룰까지 전부 포함.

**개별 설치의 문제**:
- Prometheus 따로, Grafana 따로, exporter 따로 설치하면 5+개 컴포넌트 + 연동 ServiceMonitor + DataSource 설정 모두 수동
- 버전 호환성 (Prometheus vs operator vs CRD) 매번 신경 써야 함
- 기본 대시보드/알람 룰 없음 → 처음부터 작성

**kube-prometheus-stack의 해결**:
- 단일 Helm chart로 모든 컴포넌트 설치 + 연동
- ServiceMonitor / PodMonitor CRD 자동 등록
- k8s 기본 대시보드(노드, Pod, kubelet 등) 30+ 자동 포함
- 기본 알람 룰 ("PVC 95% 도달", "Pod OOMKilled 반복" 등) 포함
- Thanos sidecar 통합 옵션 (Phase 4의 다음 단계)

**대체재**:
- **Datadog/New Relic**: SaaS, 비용 발생. self-host 컨셉 위반
- **OpenTelemetry Collector + Mimir**: Grafana 진영 신흥 스택. 강력하나 학습곡선 + Mimir보단 Thanos가 토스 스택 정합
- **VictoriaMetrics**: Prometheus 호환 + 더 빠르고 가벼움. 본 프로젝트 검토 대상이나 표준성 + Thanos sidecar 호환성에서 Prometheus 우선

## 2. Architecture — 어떻게 구성되는가

**포함된 컴포넌트** (모두 `monitoring` namespace):

- **Prometheus Operator**: Prometheus, Alertmanager 인스턴스를 CR로 관리. ServiceMonitor/PodMonitor watch.
- **Prometheus**: 메트릭 수집 + 저장 + 쿼리. PV 필수.
- **Alertmanager**: Prometheus 알람을 받아서 routing/grouping/silencing 후 외부 전송 (Slack, email 등).
- **Grafana**: 시각화. 기본 DataSource로 Prometheus 자동 등록.
- **node-exporter**: DaemonSet. 노드별 CPU/메모리/디스크/네트워크 메트릭.
- **kube-state-metrics**: Deployment, Pod, PVC 등 k8s 리소스 상태를 메트릭으로 노출.

**핵심 CRD**:
- **Prometheus**: Prometheus 인스턴스 정의 (retention, resources, Thanos sidecar 등)
- **ServiceMonitor**: 어느 Service의 /metrics를 scrape할지 선언적 정의
- **PodMonitor**: Service 없는 Pod의 /metrics 직접 scrape
- **PrometheusRule**: 알람 룰 + recording rule
- **Alertmanager**: Alertmanager 인스턴스 정의
- **AlertmanagerConfig**: 알람 routing 룰 (namespace 단위)

## 3. Mechanism — 어떻게 돌아가는가

**메트릭 수집 흐름**:

1. 앱 Pod이 /metrics 엔드포인트로 Prometheus 포맷 메트릭 노출
2. 앱 namespace에 ServiceMonitor 생성 (어느 Service를 scrape할지 명시)
3. Prometheus Operator가 ServiceMonitor watch → Prometheus 설정 자동 업데이트
4. Prometheus가 설정된 주기(default 30s)로 target의 /metrics HTTP GET
5. 받은 metric을 local TSDB에 저장 (기본 retention 본 프로젝트 3일)
6. Thanos sidecar(Phase 4 다음 단계)가 2시간 블록을 Object Storage로 업로드

**알람 흐름**:
1. PrometheusRule CR에 알람 조건 정의 (예: `up{job="login"} == 0 for 5m`)
2. Prometheus가 매 평가 주기마다 PromQL 실행
3. 조건 만족 시 alert 생성 → Alertmanager로 전송
4. Alertmanager가 grouping (예: 같은 service의 알람 묶음) + silencing 평가
5. Webhook으로 Slack/email/PagerDuty 전송

**Operator pattern의 가치**:
- Prometheus 설정 변경 = 매니페스트 변경 (declarative)
- 새 ServiceMonitor 추가 = 자동 반영, Prometheus 재시작 불필요
- GitOps 친화

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 kube-prometheus-stack 의존 관계.

- **Thanos** — Prometheus sidecar 옵션으로 통합 (다음 study)
- **Loki** — Alloy가 Prometheus 메트릭도 일부 처리 가능 (본 프로젝트는 분리 유지)
- **Tempo** — Grafana에서 DataSource로 통합 (메트릭 → 트레이스 jump)
- **앱 (Login/Core/Batch)** — ServiceMonitor로 /metrics scrape
- **Slack** — Alertmanager webhook
- **OCI Object Storage** — Thanos sidecar 경유 (Phase 4 다음)
- **모든 인프라 컴포넌트** — Istio, ArgoCD, Vault, Strimzi 등이 자체 ServiceMonitor 제공

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version 70.0.0 \
  -f values.yaml
```

values.yaml 핵심:
```yaml
prometheus:
  prometheusSpec:
    retention: 3d                # local retention (Thanos가 장기 보관)
    storageSpec:
      volumeClaimTemplate:
        spec:
          storageClassName: oci-bv
          resources:
            requests:
              storage: 30Gi
    thanos:                      # Thanos sidecar 활성화
      objectStorageConfig:
        existingSecret:
          name: thanos-objstore-config
          key: objstore.yml
    resources:
      requests: { cpu: 200m, memory: 1Gi }
      limits: { cpu: 1, memory: 2Gi }

alertmanager:
  alertmanagerSpec:
    storage:
      volumeClaimTemplate:
        spec:
          storageClassName: oci-bv
          resources:
            requests:
              storage: 5Gi

grafana:
  adminPassword: <random>        # 또는 Vault에서 주입
  ingress:
    enabled: false               # HTTPRoute로 별도 노출
  datasources:
    datasources.yaml:
      apiVersion: 1
      datasources:
      - name: Prometheus
        type: prometheus
        url: http://thanos-query.monitoring.svc:9090   # Thanos query 통합
        isDefault: true

defaultRules:
  create: true                   # 기본 알람 룰 활성화 (인프라 레벨)
```

**ServiceMonitor 예시** (앱):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: login
  namespace: app
  labels:
    release: prometheus          # Prometheus가 select하는 label
spec:
  selector:
    matchLabels:
      app: login
  endpoints:
  - port: metrics                # Service의 metrics 포트
    interval: 30s
    path: /metrics
```

**PrometheusRule 예시** (앱 알람):

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: login-alerts
  namespace: app
  labels:
    release: prometheus
spec:
  groups:
  - name: login.rules
    rules:
    - alert: LoginHighErrorRate
      expr: |
        sum(rate(http_requests_total{job="login",status=~"5.."}[5m]))
        / sum(rate(http_requests_total{job="login"}[5m])) > 0.05
      for: 10m
      labels:
        severity: warning
      annotations:
        summary: "Login 5xx error rate above 5%"
```

**PromQL 핵심 함수** (외워둘 것):

```promql
rate(http_requests_total[5m])                      # 5분 평균 초당 증가율 (counter)
irate(http_requests_total[5m])                     # 최근 2 datapoint 기반 (즉시값)
sum by (status) (rate(...))                        # status별 집계
histogram_quantile(0.99, rate(...bucket[5m]))      # P99 latency
absent(up{job="login"} == 1)                       # target 없음 감지
predict_linear(node_filesystem_free_bytes[1h], 4*3600) < 0   # 4시간 후 disk full 예측
```

## 6. Configuration — 어떤 설정이 있는가

**Prometheus 핵심 옵션**:
- `retention`: 로컬 보관 기간. Thanos sidecar 쓰면 짧게 (본 프로젝트 3일)
- `retentionSize`: 디스크 사용량 상한. 도달 시 오래된 블록 삭제
- `scrapeInterval`: 전역 scrape 주기 (default 30s)
- `evaluationInterval`: 알람 룰 평가 주기 (default 30s)
- `externalLabels`: 메트릭에 자동 추가될 label (Thanos 통합 시 cluster=oci-1 같은 식)
- `walCompression`: WAL 압축 (default true, 디스크 절약)

**ServiceMonitor selector**:
- 본 chart의 Prometheus는 `serviceMonitorSelector.matchLabels: { release: prometheus }`로 필터
- 새 ServiceMonitor는 반드시 `release: prometheus` label 부여
- 미부여 시 Prometheus가 scrape 안 함 (가장 흔한 함정)

**Series cardinality 제어**:
- `relabel_configs`로 불필요 label drop
- 예: pod_name 같은 high-cardinality label drop → RAM 폭증 방지
- 본 프로젝트는 ARM64 노드 2개 환경이라 cardinality 매우 신중

**Default alert rules** (`defaultRules.enabled: true`):
- KubePodCrashLooping, KubePodNotReady
- KubePersistentVolumeFillingUp
- KubeNodeNotReady, KubeNodeUnreachable
- NodeFilesystemAlmostOutOfSpace
- ~100+ 알람 룰 포함

**Storage 옵션**:
- Block Volume PV로 mount (본 프로젝트 30GB)
- emptyDir 사용 시 재시작마다 메트릭 손실 — 절대 안 됨

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **kube-prometheus-stack 70.x+** (2026-05 권장). Prometheus Operator 0.79+
- **Prometheus 3.0+** (2024-11 출시, native histogram, OTLP ingestion 등)
- **Grafana 11.x+** (Scenes 대시보드, 새 explore UI)
- **PrometheusRule CRD**: monitoring.coreos.com/v1
- **Thanos sidecar 호환**: Prometheus 2.x ~ 3.x, Thanos 0.36+

## 8. 면접 예상 질문 & 답변

**Q1. kube-prometheus-stack vs 개별 설치 어느 게 나아요?**
> 본 프로젝트는 kube-prometheus-stack을 선택했습니다. 사유는 (1) Prometheus + Operator + CRD + Grafana + Alertmanager + node-exporter + kube-state-metrics를 한 chart로 묶어서 버전 호환성 신경 안 써도 되고, (2) k8s 기본 대시보드 30+개와 기본 알람 룰 100+개가 자동 포함되어 처음부터 운영 가능 상태가 되고, (3) Thanos sidecar 통합 옵션이 chart에 박혀있어서 활성화만 하면 끝납니다. 개별 설치는 모든 컴포넌트를 직접 연결해야 하므로 학습 목적 외엔 비효율적입니다.

**Q2. ServiceMonitor와 PodMonitor 차이는요?**
> ServiceMonitor는 k8s Service를 통해 scrape하는 방식이고 PodMonitor는 Pod IP에 직접 scrape합니다. 일반적으로 ServiceMonitor를 쓰는데, Pod이 Service 뒤에 있어도 scrape는 Service endpoint를 통해 실제 Pod IP로 가서 결국 같은 효과입니다. PodMonitor는 Service 없는 Pod(예: 어드미션 webhook의 임시 Pod) 또는 multi-port Pod에서 Service 추상화가 복잡할 때 사용합니다. 본 프로젝트는 거의 ServiceMonitor만 씁니다.

**Q3. ServiceMonitor를 만들었는데 Prometheus가 scrape 안 해요. 왜 그래요?**
> 가장 흔한 원인은 ServiceMonitor에 `release: prometheus` label이 없는 경우입니다. kube-prometheus-stack의 Prometheus는 `serviceMonitorSelector.matchLabels`로 ServiceMonitor를 필터하는데 default가 `release: <helm-release-name>`입니다. 매니페스트에 라벨 추가하면 즉시 인식됩니다. 두 번째 흔한 원인은 ServiceMonitor가 같은 namespace에 있지만 `serviceMonitorNamespaceSelector`가 모든 namespace를 허용하지 않은 경우. `kubectl describe prometheus`로 selector 확인합니다.

**Q4. PromQL의 rate와 irate 차이는?**
> rate는 시간 윈도우(예: 5분) 안의 모든 datapoint를 사용해서 평균 변화율을 계산합니다. irate는 마지막 2개 datapoint만 사용해서 즉각적인 변화율을 봅니다. 일반적으로 알람과 대시보드는 rate를 쓰는데, 짧은 spike에 덜 민감하고 노이즈가 적기 때문입니다. irate는 트래픽이 매우 burst한 시스템의 현재 상태를 보고 싶을 때 사용합니다. rate의 윈도우는 scrape interval의 4배 이상 줘야 빈 윈도우가 안 생깁니다(30s scrape → 2m 이상 윈도우).

**Q5. histogram_quantile은 어떻게 동작해요?**
> Prometheus histogram metric은 `..._bucket{le="0.1"}`, `le="0.5"`, `le="+Inf"` 같은 buckets로 누적 카운트를 노출합니다. histogram_quantile은 이 buckets를 보고 지정한 quantile(예: 0.99 = P99)에 해당하는 값을 선형 보간으로 계산합니다. 정확한 quantile이 아니라 근사값이고, buckets 정의가 부정확하면 결과도 부정확합니다. P99 latency 추적 시 사용하는 표준 패턴이고, 본 프로젝트도 앱 알람에 활용합니다.

**Q6. Prometheus가 메모리를 많이 먹는 이유는?**
> series cardinality에 선형 비례합니다. Prometheus는 각 unique label 조합을 별도 series로 저장하는데, label 값이 폭주하면(예: pod_name이 매번 바뀜, user_id 같은 high-cardinality label) RAM이 폭증합니다. 본 프로젝트는 ARM64 노드 12GB 제약이라 (1) ServiceMonitor의 relabel_configs로 불필요 label drop, (2) Grafana Alloy 사용 시 동일하게 label drop, (3) Prometheus의 `--query.max-samples`로 query 자체도 제한 — 세 가지 방어선을 둡니다.

**Q7. Alertmanager의 grouping과 silencing은 어떻게 동작해요?**
> Grouping은 비슷한 알람을 묶어서 한 번에 보내는 메커니즘입니다. 예를 들어 같은 service의 Pod 5개가 동시에 죽으면 5개 알람을 받는 게 아니라 1개 묶음 알람으로 받습니다. `group_by: [service]` 설정으로 그룹 기준을 정합니다. Silencing은 일정 시간 알람을 막는 거고, maintenance window 동안 alert spam 방지에 씁니다. UI에서 matcher(label selector)와 시간 기간을 지정합니다. 본 프로젝트는 routing에서 severity별로 다른 채널 보내고, grouping은 service 단위로 묶습니다.

**Q8. Default alert rules에는 뭐가 있고 왜 활성화해야 해요?**
> kube-prometheus-stack의 defaultRules에는 100+개 룰이 있습니다. 핵심은 KubePodCrashLooping(반복 재시작), KubePodNotReady(5분 이상 not ready), KubePersistentVolumeFillingUp(PV 90% 도달), KubeNodeNotReady(노드 다운), KubeAPIErrorBudgetBurn(API server 에러율) 등입니다. Phase 4 완료 시점에 앱 알람(Phase 6-B)을 아직 안 만들었어도 인프라 레벨 알람은 즉시 동작해야 운영 가시성이 생깁니다. 본 프로젝트는 `defaultRules.enabled: true`로 즉시 활성화합니다.

**Q9. Prometheus 3.x로 올라가면서 뭐가 바뀌었나요?**
> 가장 큰 변화는 (1) Native histogram 정식 지원 — 기존 fixed bucket histogram보다 정확하고 가볍습니다, (2) OTLP ingestion 지원 — OpenTelemetry 메트릭을 Prometheus가 직접 받을 수 있습니다, (3) UTF-8 metric name 지원, (4) Remote Write 2.0 — 성능 개선, (5) PromQL 함수 추가. 본 프로젝트는 Prometheus 3.x를 쓰지만 Thanos sidecar 호환성을 위해 native histogram은 보수적으로 채택합니다.

**Q10. 메트릭 백업은 어떻게 해요?**
> 본 프로젝트는 Phase 4에서 Thanos sidecar를 활성화해서 Prometheus의 2시간 단위 TSDB 블록을 OCI Object Storage에 자동 업로드합니다. 결과적으로 Prometheus PV가 손상되어도 직전 2시간 외엔 데이터가 살아있습니다. Velero(Phase 7)는 매니페스트와 PV 메타데이터만 백업하지 메트릭 자체 백업은 Thanos에 위임합니다. 만약 Thanos를 안 쓰면 Velero fs-backup으로 Prometheus PV 전체를 백업하는 게 fallback인데 매우 비효율적이라 권장하지 않습니다.
