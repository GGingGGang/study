# Prometheus (Prometheus)

> 쿠버네티스 · 인프라/옵저버빌리티 · 학습내용: 풀(pull) 기반 스크레이프 모델, 시계열 데이터 모델(metric+label), 메트릭 4종, PromQL 기초, 서비스 디스커버리, Operator의 ServiceMonitor/PodMonitor, 레코딩·알럿 룰과 Alertmanager, 보존·원격쓰기

---

## 1. Prometheus가 뭐고 왜 쓰나

**Prometheus**는 시스템·애플리케이션의 **메트릭(수치 지표)을 시계열(time series)로 수집·저장하고 질의**하는 모니터링 시스템이다. 원래 SoundCloud에서 시작해 지금은 CNCF의 졸업 프로젝트로, 쿠버네티스 모니터링의 사실상 표준이다.

핵심 발상은 두 가지다.

- **풀(pull) 방식**: Prometheus 서버가 정해진 주기로 대상(target)의 `/metrics` HTTP 엔드포인트에 직접 접속해 메트릭을 긁어온다(스크레이프, scrape). 대상이 서버로 밀어넣는(push) 게 아니다.
- **다차원 시계열**: 모든 데이터는 `메트릭 이름 + 라벨(key=value) + 타임스탬프 + 값`으로 저장된다. 라벨로 같은 메트릭을 여러 차원(인스턴스·경로·상태코드 등)으로 쪼개 본다.

직접 로그를 뒤지거나 사람이 그래프를 그리는 대신, Prometheus는 "어떤 지표가 어떤 추세인지"를 **PromQL로 질의**하고 **임계치를 넘으면 알림**까지 자동화한다.

## 2. 풀(pull) 스크레이프 모델

```
Prometheus 서버 --(HTTP GET /metrics, 주기적)--> Target(앱/exporter)
```

- 대상 앱은 **exporter** 또는 클라이언트 라이브러리로 `/metrics` 엔드포인트를 열어 현재 값을 **텍스트로 노출**만 한다. 누적·전송은 Prometheus가 책임진다.
- 스크레이프 주기(`scrape_interval`, 보통 15~30초)마다 Prometheus가 긁어 자체 TSDB(시계열 DB)에 저장.
- 직접 메트릭이 없는 시스템은 **exporter**로 변환: `node_exporter`(노드 CPU·메모리·디스크), `kube-state-metrics`(쿠버네티스 오브젝트 상태) 등.
- 짧게 살다 죽는 배치 작업은 풀이 어렵다 → **Pushgateway**에 잠깐 밀어넣고 Prometheus가 그걸 긁는 예외 패턴 사용.

★ "Prometheus는 왜 pull인가?"는 단골 질문이다. 대상의 **헬스 자체를 스크레이프 성공 여부(`up`)로 알 수 있고**, 누가 무엇을 긁는지 **중앙에서 통제**하기 쉬우며, 대상은 그냥 값을 노출만 하면 되어 단순하다.

## 3. 시계열 데이터 모델

하나의 시계열은 **메트릭 이름**과 **라벨 집합**의 조합으로 유일하게 식별된다.

```
http_requests_total{method="GET", handler="/api", status="200"}  →  1027  @timestamp
http_requests_total{method="POST", handler="/api", status="500"} →  3     @timestamp
```

- 같은 `http_requests_total`이라도 **라벨 조합이 다르면 별개의 시계열**이다.
- 라벨이 다양할수록 차원 분석이 풍부해지지만, **라벨 값의 가짓수(cardinality)가 폭발하면** 시계열 수가 곱셈으로 늘어 메모리·저장이 터진다. → 사용자 ID, 요청 URL 전체처럼 **무한히 늘어나는 값은 라벨로 쓰지 말 것**. ★

## 4. 메트릭 4종

| 타입 | 의미 | 특징 | 예시 |
|------|------|------|------|
| **Counter** | 단조 증가만 하는 누적값 | 줄지 않음(재시작 시 0으로 리셋) | 총 요청 수, 총 에러 수 |
| **Gauge** | 오르내리는 순간값 | 증가·감소 모두 | 현재 메모리, 동시 접속 수, 온도 |
| **Histogram** | 관측값을 **버킷(구간)별 누적 카운트**로 | `_bucket`/`_sum`/`_count` 생성, 서버측 분위수 계산 | 요청 지연 분포 |
| **Summary** | 클라이언트가 **분위수(quantile)를 직접 계산** | 집계가 어려움(여러 인스턴스 합산 불가) | 분위수가 인스턴스 단위로 충분할 때 |

★★★ Counter는 직접 보면 의미가 없고 **`rate()`로 초당 증가율**을 봐야 한다. 지연(latency)을 여러 인스턴스에 걸쳐 집계하려면 **Histogram**(서버측 `histogram_quantile()` 가능)이 Summary보다 유리하다.

## 5. PromQL 기초

PromQL은 시계열을 질의하는 함수형 언어다.

```promql
# 1) 셀렉터: 라벨로 시계열 필터
http_requests_total{status="500"}

# 2) rate: Counter의 초당 평균 증가율(최근 5분 윈도)
rate(http_requests_total[5m])

# 3) aggregation: 라벨 기준으로 합산
sum(rate(http_requests_total[5m])) by (status)

# 4) Histogram에서 p95 지연 계산
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
```

- `[5m]`은 **range vector**(시간 구간의 샘플들), 그냥 셀렉터는 **instant vector**(현재 시점 한 값). `rate`/`increase`는 range vector를 받는다.
- 집계 연산: `sum` `avg` `max` `min` `count` + `by(...)`(남길 라벨) / `without(...)`(뺄 라벨).

★ "Counter에 rate를 안 씌우고 그래프 그리면?" → 재시작 리셋·누적값이라 추세 파악 불가. **rate 먼저**.

## 6. 서비스 디스커버리

대상이 동적으로 뜨고 사라지는 쿠버네티스에서 스크레이프 대상을 **수동 등록할 수 없다**. Prometheus는 **서비스 디스커버리(SD)**로 대상 목록을 자동 갱신한다.

- `kubernetes_sd_config`로 Pod·Service·Endpoints·Node 등을 자동 발견.
- `relabel_configs`로 발견된 메타데이터(라벨·어노테이션)를 보고 **어떤 대상을 긁을지·어떤 라벨을 붙일지**를 가공.

## 7. Prometheus Operator — ServiceMonitor / PodMonitor

직접 `prometheus.yml`을 손으로 관리하는 대신, **Prometheus Operator**(보통 `kube-prometheus-stack` Helm 차트로 배포)를 쓰면 스크레이프 설정도 **쿠버네티스 리소스(CRD)**로 선언한다.

| 리소스 | 역할 |
|--------|------|
| **Prometheus** | Prometheus 인스턴스 자체를 정의 |
| **ServiceMonitor** | **Service**를 셀렉터로 골라 그 뒤 엔드포인트를 스크레이프 |
| **PodMonitor** | **Pod**를 직접 셀렉터로 골라 스크레이프(Service 없이) |
| **PrometheusRule** | 레코딩·알럿 룰을 선언 |
| **Alertmanager** | Alertmanager 인스턴스를 정의 |

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app
  labels:
    release: kube-prometheus-stack   # Operator가 고르는 셀렉터와 일치해야 함
spec:
  selector:
    matchLabels:
      app: my-app                    # 이 라벨을 가진 Service를 대상으로
  endpoints:
    - port: metrics                  # Service의 포트 '이름'
      interval: 30s
      path: /metrics
```

★ 흔한 실수: ServiceMonitor의 `labels`가 Operator의 `serviceMonitorSelector`와 안 맞으면 **조용히 무시**된다. kube-prometheus-stack은 보통 `release: <릴리스명>` 라벨을 요구한다.

## 8. 레코딩·알럿 룰 + Alertmanager

`PrometheusRule` 하나에 두 종류의 룰을 담는다.

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: app-rules
  labels:
    release: kube-prometheus-stack
spec:
  groups:
    - name: app.rules
      rules:
        # 레코딩 룰: 비싼 쿼리를 미리 계산해 새 메트릭으로 저장
        - record: job:http_requests:rate5m
          expr: sum(rate(http_requests_total[5m])) by (job)
        # 알럿 룰: 조건이 5분간 참이면 발화
        - alert: HighErrorRate
          expr: sum(rate(http_requests_total{status=~"5.."}[5m])) > 1
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "5xx 에러율이 높습니다"
```

- **레코딩 룰**: 자주 쓰는 무거운 표현식을 주기적으로 계산해 별도 시계열로 저장 → 대시보드·알럿이 빨라짐.
- **알럿 룰**: 조건이 `for` 기간 동안 지속되면 Prometheus가 **Alertmanager**로 알림을 보낸다.
- **Alertmanager**가 알림의 **그룹화·중복 제거(dedup)·억제(inhibition)·라우팅**을 맡아 Slack·Email·PagerDuty 등으로 전달. ★ Prometheus는 "발화"만, "누구에게 어떻게 보낼지"는 Alertmanager 담당이라는 역할 분리를 기억.

## 9. 보존·원격 쓰기 (한 줄)

Prometheus 로컬 TSDB는 **보존 기간(`--storage.tsdb.retention.time`, 기본 15일)**이 지나면 데이터를 지운다. 장기 보관·전역 조회가 필요하면 **remote write**로 외부 저장소(Thanos·Mimir·Cortex 등)에 시계열을 전송해 무제한 보존·수평 확장한다.

## 10. 흔한 함정

- **라벨 카디널리티 폭발**: 고유값이 많은 항목(user_id, full URL)을 라벨로 → 시계열 수 급증, OOM. ★★★
- **Counter를 rate 없이 사용**: 누적·리셋 때문에 추세 왜곡.
- **ServiceMonitor 셀렉터 불일치**: 룰/모니터가 조용히 무시됨.
- **Histogram 버킷 미설계**: `le` 경계가 실제 지연 분포와 안 맞으면 분위수가 부정확.

### 한 줄 요약
Prometheus는 대상의 `/metrics`를 **주기적으로 긁어(pull)** `메트릭+라벨`의 **시계열**로 저장하고, **PromQL**로 질의하며, 조건 충족 시 **Alertmanager**로 알림을 보내는 모니터링 시스템이다. 쿠버네티스에선 **Operator의 ServiceMonitor/PodMonitor/PrometheusRule**로 선언형 관리하고, **라벨 카디널리티 관리와 Counter의 rate 사용**이 핵심이다.

### 참고 (공식 문서)
- 개요·데이터 모델: https://prometheus.io/docs/concepts/data_model/
- 메트릭 타입: https://prometheus.io/docs/concepts/metric_types/
- PromQL 기초: https://prometheus.io/docs/prometheus/latest/querying/basics/
- Prometheus Operator(ServiceMonitor 등): https://prometheus-operator.dev/docs/developer/getting-started/
- Alertmanager: https://prometheus.io/docs/alerting/latest/alertmanager/
