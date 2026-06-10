# Loki (Grafana Loki)

> 쿠버네티스 · 인프라/옵저버빌리티 · 학습내용: 로그 집계 시스템의 발상(라벨만 인덱싱 + 본문은 청크 저장), 구성요소 한눈에, LogQL 기초(스트림 셀렉터·필터·메트릭 쿼리), 수집 에이전트(Promtail/Alloy), 라벨 카디널리티 함정

---

## 1. Loki가 뭐고 왜 쓰나

**Grafana Loki**는 **로그를 수집·저장·질의**하는 로그 집계(log aggregation) 시스템이다. Grafana Labs가 만들었고 "**Prometheus처럼 동작하는 로그 시스템**"을 표방한다.

가장 큰 특징은 저장 방식이다. 기존 로그 시스템(예: Elasticsearch)은 **로그 본문 전체를 풀텍스트로 인덱싱**해 빠른 검색을 제공하지만, 그만큼 **인덱스가 거대하고 자원을 많이** 먹는다. Loki는 이 발상을 뒤집는다.

- **메타데이터(라벨)만 인덱싱**하고,
- **로그 본문은 인덱싱하지 않고 압축 청크(chunk)로 그냥 저장**한다.

정리하면 "어떤 스트림(라벨 조합)에 속한 로그인지"만 색인하고, 본문 검색은 질의 시점에 해당 청크를 **읽으면서 필터링(grep 식)**한다. 그래서 인덱스가 작아 **저장·운영 비용이 낮고**, 라벨 체계가 Prometheus와 같아 **메트릭과 로그를 같은 라벨로 연결**해 볼 수 있다.

## 2. 핵심 철학 — 라벨만 인덱싱 + 본문은 청크 저장

```
로그 라인 = { 라벨 집합(스트림 식별) }  +  타임스탬프  +  로그 본문 텍스트
            └── 인덱싱 (작다)              └── 청크에 압축 저장 (인덱싱 안 함)
```

- **스트림(stream)**: 라벨 조합 하나가 하나의 로그 스트림이다. 예: `{namespace="prod", app="api", level="error"}`.
- 같은 스트림의 로그 라인들은 시간순으로 **청크에 모아 압축**되어 오브젝트 스토리지(S3 등)에 저장된다.
- **인덱스는 "스트림 ↔ 청크 위치"만** 담는다. → 인덱스가 작아 메모리·디스크 절약. ★

★ "Loki는 왜 Elasticsearch보다 가벼운가?" → **본문을 풀텍스트 인덱싱하지 않기 때문**. 대신 본문에 대한 임의 검색은 청크를 읽으며 필터링하므로, **스트림 셀렉터로 범위를 먼저 좁히는 게 성능의 핵심**이다.

## 3. 구성요소 한눈에

Loki는 읽기/쓰기 경로가 나뉜 마이크로서비스로 동작한다(단일 바이너리로도 실행 가능).

| 컴포넌트 | 역할 |
|----------|------|
| **Distributor** | 들어온 로그를 검증하고 해시로 적절한 ingester에 분배(쓰기 진입점) |
| **Ingester** | 로그를 메모리에 모아 청크로 만들고 주기적으로 오브젝트 스토리지에 flush, 인덱스 갱신 |
| **Querier** | 질의(LogQL)를 받아 ingester(최근)와 스토리지(과거)에서 로그를 모아 결과 반환 |
| **Query Frontend** | 쿼리를 분할·병렬화·캐싱해 querier 성능 향상 |
| **Compactor** | 인덱스 압축·보존(retention) 적용 |

> 쓰기 흐름: 에이전트 → **Distributor → Ingester → (청크) 오브젝트 스토리지**. 읽기 흐름: Grafana/LogQL → **Query Frontend → Querier → Ingester+스토리지**.

## 4. LogQL 기초

LogQL은 Loki의 질의 언어로, PromQL과 닮았다. 두 단계로 나눠 생각하면 쉽다: **① 스트림 셀렉터로 범위 좁히기 → ② 필터·파싱·집계**.

```logql
# 1) 스트림 셀렉터: 라벨로 로그 스트림 선택 (필수)
{namespace="prod", app="api"}

# 2) 라인 필터: 본문에 특정 문자열 포함/제외
{namespace="prod", app="api"} |= "error" != "healthcheck"

# 3) 파서 + 라벨 필터: JSON 로그를 파싱 후 필드로 필터
{app="api"} | json | status >= 500

# 4) 메트릭 쿼리: 로그를 수치로 집계 (LogQL → 시계열)
sum(rate({app="api"} |= "error" [5m])) by (namespace)
```

- 라인 필터 연산자: `|=`(포함) `!=`(미포함) `|~`(정규식 일치) `!~`(정규식 불일치).
- `| json` `| logfmt` `| pattern` 등으로 본문을 파싱해 추출 라벨로 필터링.
- **메트릭 쿼리**: `rate()` `count_over_time()` 등으로 로그를 시계열 그래프·알럿으로 바꾼다. ★ 로그만으로 "에러율 그래프"를 그릴 수 있는 게 Loki의 강점.

## 5. 수집 에이전트 (Promtail / Alloy)

Loki 자체는 로그를 **받기만** 한다. 로그를 긁어 보내는 일은 **에이전트**가 맡는다.

| 에이전트 | 설명 |
|----------|------|
| **Grafana Alloy** | 현재 권장되는 통합 텔레메트리 수집기(로그·메트릭·트레이스). Promtail의 후속격 |
| **Promtail** | 전통적인 Loki 전용 로그 에이전트(현재는 유지보수 모드/Alloy로 이전 권장) |

- 보통 각 노드에 **DaemonSet**으로 떠서 컨테이너 로그 파일을 읽는다.
- 에이전트가 쿠버네티스 메타데이터(namespace·pod·container)를 **라벨로 붙여** Loki에 전송 → 이 라벨이 곧 스트림 식별자가 된다.

## 6. 라벨 카디널리티 함정 (가장 중요)

Loki의 인덱스는 **라벨 조합 = 스트림**으로 만들어진다. 그래서 **라벨 값의 가짓수(cardinality)가 폭발하면 스트림이 끝없이 늘어나** 성능과 비용이 급격히 나빠진다. ★★★

- **나쁜 예**: `request_id`, `user_id`, `ip`, `full URL`, `trace_id`를 **라벨로** 사용 → 라인마다 새 스트림 → 인덱스 폭발.
- **좋은 원칙**: 라벨은 **값의 종류가 적고(low cardinality) 검색의 출입구가 되는 것**만 — `namespace`, `app`, `level`, `cluster` 정도.
- 고유값으로 검색하고 싶으면? **라벨이 아니라 로그 본문에 두고 `|=`/`| json`으로 질의**한다. 본문 필터의 비용은 인덱스 폭발과 성격이 다르다.

> 핵심 멘탈 모델: **"라벨은 적게, 본문은 자유롭게."** Prometheus의 카디널리티 주의와 동일한 원리지만, Loki에선 더 직접적으로 비용을 가른다.

## 7. 최소 예시 — Grafana에서 LogQL로 prod 에러 로그 보기

```logql
{namespace="prod", app="api"} | json | level="error"
```

→ prod 네임스페이스 api 앱의 로그 중 JSON으로 파싱해 `level=error`인 라인만. Grafana의 Loki 데이터소스에서 그대로 실행한다.

### 한 줄 요약
Loki는 **라벨(메타데이터)만 인덱싱하고 로그 본문은 압축 청크로 저장**해 가볍게 운영하는 로그 집계 시스템이다. **LogQL**로 "스트림 셀렉터 → 필터/파싱 → 메트릭 집계" 순으로 질의하며, **Distributor→Ingester→스토리지** 흐름으로 동작한다. 성패는 **라벨 카디널리티를 낮게 유지**하는 데 달려 있다(고유값은 라벨이 아니라 본문에).

### 참고 (공식 문서)
- Loki 개요: https://grafana.com/docs/loki/latest/get-started/overview/
- 라벨·카디널리티 가이드: https://grafana.com/docs/loki/latest/get-started/labels/
- LogQL: https://grafana.com/docs/loki/latest/query/
- 아키텍처(컴포넌트): https://grafana.com/docs/loki/latest/get-started/components/
- 로그 수집(Alloy/에이전트): https://grafana.com/docs/loki/latest/send-data/
