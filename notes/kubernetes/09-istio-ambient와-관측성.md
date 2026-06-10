# Istio Ambient와 관측성 (Istio Ambient & Observability)

> 쿠버네티스 · Istio · 학습내용: Ambient 모드 심화(ztunnel = 노드 L4 mTLS·HBONE 터널, waypoint = L7 정책), 사이드카 대비 장단점, 트래픽 경로, Istio가 자동으로 내보내는 표준 메트릭(RED + TCP), 분산 트레이싱 전파(B3/W3C), 액세스 로그, Telemetry API

---

이 문서는 우리 프로젝트가 채택한 **Istio Ambient 모드**의 동작을 깊게 파고, Istio가 **무엇을 관측 데이터로 내보내는지**에 집중한다. 관측성 백엔드 도구의 사용법은 다루지 않는다(Istio가 표준 포맷으로 데이터를 내보내면 어떤 호환 백엔드든 받는다는 관점). 사이드카 모드는 비교용으로만 언급한다. 외부 진입은 Gateway API + OCI NLB로 `ggang.cloud` 에 연결된다.

## 1. Ambient 모드란 — L4와 L7의 분리

Ambient 모드의 한 문장 요지는 **"데이터플레인을 L4 계층과 L7 계층으로 쪼갠다"** 이다.

| 계층 | 컴포넌트 | 배치 | 책임 |
|------|----------|------|------|
| **L4(보안 계층)** | **ztunnel** | **노드마다 1개**(DaemonSet) | mTLS 암호화, 워크로드 신원, L4 인가, 기본 텔레메트리 |
| **L7(고급 계층)** | **waypoint** | **필요한 NS/서비스에만** | 라우팅·트래픽 분할, 리트라이·타임아웃, L7 인가, 풍부한 텔레메트리 |

> ★★★ **Ambient 핵심**: 사이드카 모드는 **L4와 L7을 한 Envoy가 통째로** 처리하므로, 단순히 통신만 암호화하고 싶어도 모든 파드에 무거운 Envoy가 붙는다. Ambient는 이를 두 계층으로 나눠 **"보안(mTLS)은 모든 워크로드에 저비용으로 항상, 고급 L7 기능은 필요한 곳에만"** 을 가능하게 한다. 이걸 **"secure overlay"(ztunnel) + 선택적 L7(waypoint)** 라고 표현한다.

## 2. ztunnel — 노드 L4 데몬

**ztunnel(zero-trust tunnel)** 은 각 노드에서 도는 **Rust 기반 경량 데몬**(DaemonSet)이다. 하는 일은 다음과 같다.

- **L4 mTLS**: 메시에 편입된 워크로드 간 트래픽을 가로채 **mTLS로 암호화**한다. 워크로드 신원은 SPIFFE/SVID(istiod CA 발급).
- **HBONE 터널**: 노드 간 트래픽을 **HBONE(HTTP-Based Overlay Network Environment)** 로 캡슐화한다. 즉 **mTLS로 보호된 HTTP/2 CONNECT** 위에 원 트래픽을 실어 보낸다. 표준 포트는 **15008**.
- **L4 인가/텔레메트리**: 워크로드/포트 수준 인가와 TCP 메트릭(L4 RED)을 생성한다.
- **L7은 안 함**: HTTP 라우팅·리트라이·경로 기반 인가 같은 건 ztunnel이 손대지 않는다. 그건 waypoint의 몫이다.

> ★ 면접 포인트: "ztunnel은 파드마다 뜨나?" → **아니다. 노드마다 하나(DaemonSet)**. 그래서 파드가 수백 개여도 프록시는 노드 수만큼이라 자원 효율이 높다. 사이드카처럼 파드에 컨테이너를 주입하지 않으므로 **메시 편입에 파드 재시작이 불필요**하다(네임스페이스 라벨만 추가).

## 3. waypoint — 선택적 L7 프록시

**waypoint** 는 L7 기능이 필요한 **네임스페이스 또는 서비스 단위로 배치하는 Envoy 기반 프록시**다(Deployment). 맡는 일은 다음과 같다.

- VirtualService/DestinationRule 기반 **라우팅·가중치 분할·리트라이·타임아웃·서킷 브레이커**.
- HTTP 메서드/경로/헤더 기반 **L7 AuthorizationPolicy**.
- 요청 단위 **풍부한 메트릭·트레이싱**.

배치는 보통 다음처럼 한다(개념 예시).

```bash
# payments 네임스페이스에 waypoint 배포 + 그 NS 트래픽이 waypoint를 거치도록 지정
istioctl waypoint apply -n payments --enroll-namespace
```

> ★★★ **waypoint 면접 포인트**: Ambient에서 **"L7 정책을 걸었는데 안 먹는다"** 의 1순위 원인은 **waypoint 미배치**다. ztunnel만으로는 L4까지만 처리되므로, 경로 기반 인가나 가중치 카나리 같은 L7 기능은 그 트래픽이 waypoint를 거쳐야 적용된다. **"필요한 곳에만 waypoint"** 가 비용 절감의 핵심이자, 동시에 "어디에 둘지 설계해야 한다"는 운영 포인트다.

## 4. 트래픽 경로 (Traffic Path)

```
[Ambient 트래픽 경로 — L7 정책이 있는 경우]

  소스 파드
     │ (평문, iptables/CNI가 ztunnel로 리다이렉트)
     ▼
  ztunnel(소스 노드)
     │  HBONE(mTLS, HTTP/2 CONNECT, :15008)
     ▼
  waypoint(목적 NS/서비스, L7 정책 적용)   ← L7 정책이 있을 때만 경유
     │  HBONE(mTLS)
     ▼
  ztunnel(목적 노드)
     │ (평문)
     ▼
  목적 파드
```

L7 정책(waypoint)이 **없으면** 경로는 더 짧다: `소스 파드 → ztunnel → ztunnel → 목적 파드`. 즉 **mTLS는 항상, waypoint 경유는 선택적**이다.

## 5. 사이드카 모드 대비 장단점

| 구분 | 사이드카(Sidecar) | **Ambient(우리 선택)** |
|------|-------------------|------------------------|
| 프록시 배치 | 파드마다 Envoy 1개 | 노드마다 ztunnel(L4) + 선택적 waypoint(L7) |
| 리소스 비용 | 파드 수 × Envoy(높음) | 노드 수 × ztunnel(낮음) |
| 메시 편입 | 사이드카 주입 + **파드 재시작 필요** | 네임스페이스 라벨만, **재시작 불필요** |
| L4/L7 분리 | 한 Envoy가 통합 처리 | **L4(ztunnel)·L7(waypoint) 분리** |
| 점진 도입 | 파드 단위 주입 | mTLS는 전 워크로드, L7은 선택적 |
| 성숙도/생태계 | 오래됨, 사례 풍부 | 상대적으로 신규(빠르게 안정화 중) |
| 디버깅 | 파드 안에 프록시(직관적) | 경로가 노드/waypoint로 분산(추적 포인트 늘어남) |
| per-pod 세밀 제어 | 강함(파드 단위) | L7은 waypoint 단위(파드별보다 굵음) |

> ★★★ **Ambient 장단점 면접 포인트**: 장점은 **① 자원 효율(노드 단위 프록시) ② 무중단 편입(재시작 불필요) ③ 점진 도입(mTLS 먼저, L7 나중)**. 단점은 **① 상대적으로 새로워 사례·툴링이 사이드카보다 적음 ② 트래픽 경로가 ztunnel/waypoint로 나뉘어 디버깅 포인트가 늘어남 ③ L7 제어 단위가 파드별보다 굵음**. "왜 Ambient를 택했나?"엔 자원 효율 + 점진 도입을, "리스크는?"엔 성숙도/디버깅을 답하면 균형 잡힌다.

## 6. 관측성 — Istio가 무엇을 내보내는가

서비스 메시의 큰 가치 중 하나는 **코드 변경 없이 균일한 텔레메트리**를 얻는다는 것이다. 데이터플레인이 모든 트래픽을 보므로 **메트릭·트레이싱·로그**를 자동 생성해 표준 포맷으로 내보낸다. 우리는 "Istio가 무엇을 내보내는가"에 집중한다(특정 백엔드 도구는 논외).

### 6.1 표준 메트릭 — RED + TCP

Istio는 **서비스 레벨 표준 메트릭**을 자동 수집한다. HTTP/gRPC는 **RED 모델**을 따른다.

| 약자 | 메트릭(예) | 의미 |
|------|-----------|------|
| **R**ate | `istio_requests_total` | 초당 요청 수(트래픽 양) |
| **E**rrors | `istio_requests_total{response_code=~"5.."}` | 에러율(5xx 비율) |
| **D**uration | `istio_request_duration_milliseconds` | 요청 지연(레이턴시 분포) |

TCP(비-HTTP) 트래픽은 별도 메트릭으로 본다.

| TCP 메트릭 | 의미 |
|------------|------|
| `istio_tcp_connections_opened_total` | 열린 커넥션 수 |
| `istio_tcp_connections_closed_total` | 닫힌 커넥션 수 |
| `istio_tcp_sent_bytes_total` / `istio_tcp_received_bytes_total` | 송수신 바이트 |

각 메트릭에는 **풍부한 라벨(차원)** 이 붙는다. `source_workload`, `destination_workload`, `destination_service`, `response_code`, `connection_security_policy`(mTLS 여부) 등이다. 이 라벨 덕분에 **"어느 서비스가 어느 서비스를 호출했고 그 결과는?"** 을 그래프로 재구성한다.

> ★★★ **관측성 면접 포인트**: Istio 메트릭의 핵심 가치는 **"애플리케이션 코드 한 줄 안 바꾸고 모든 서비스에 대해 동일한 RED 메트릭(+서비스 그래프용 라벨)"** 을 얻는 것이다. 라벨에 **source/destination workload가 들어가 서비스 간 호출 관계를 메트릭만으로 재구성**할 수 있다는 점이 표준 라이브러리 메트릭과의 결정적 차이다. Ambient에서는 **L4 메트릭은 ztunnel이, L7 상세 메트릭은 waypoint가** 만든다.

### 6.2 분산 트레이싱 전파 (B3 / W3C)

분산 트레이싱은 한 요청이 여러 서비스를 거치는 **전체 경로(span의 트리)** 를 보여준다. Istio 데이터플레인은 span을 **생성·보고**하지만, **요청을 가로지르는 trace 컨텍스트(헤더) 전파는 애플리케이션이 협조해야** 한다.

| 전파 포맷 | 헤더(예) | 비고 |
|-----------|---------|------|
| **B3** | `x-b3-traceid`, `x-b3-spanid`, `x-b3-sampled` | Zipkin 계열 전통 포맷 |
| **W3C Trace Context** | `traceparent`, `tracestate` | 현재 권장되는 표준 |

> ★★★ **트레이싱 전파 면접 포인트**: **가장 자주 나오는 함정** — Istio가 자동으로 span을 만들어도, **애플리케이션이 인바운드 요청의 trace 헤더(`traceparent`/`x-b3-*`)를 아웃바운드 호출에 그대로 복사해 넘겨주지 않으면 trace가 끊긴다**. Istio는 각 홉의 span을 만들 뿐, **요청 간 컨텍스트를 묶는 헤더 전파는 앱 책임**이다. "메시만 깔면 분산 트레이싱이 공짜인가?"의 정답은 **"span 생성은 메시가, 헤더 전파는 앱이"** 다. 샘플링 비율도 함께 설계해야 한다(전수 수집은 비용·오버헤드).

### 6.3 액세스 로그 (Access Logs)

데이터플레인은 처리한 각 요청을 **액세스 로그**로 남긴다. 메서드·경로·응답 코드·지연·업스트림·**연결 보안(mTLS 여부)** 등이 한 줄로 기록돼 디버깅의 1차 단서가 된다(기본은 비활성이거나 환경에 따라 다르므로 Telemetry/메시 설정으로 켠다).

## 7. Telemetry API — 텔레메트리 제어

**Telemetry** CRD는 메트릭·트레이싱·액세스 로그의 동작을 **선언적으로 제어**한다(범위는 메시/네임스페이스/워크로드).

```yaml
apiVersion: telemetry.istio.io/v1
kind: Telemetry
metadata:
  name: mesh-telemetry
  namespace: istio-system     # 메시 전체
spec:
  tracing:
    - randomSamplingPercentage: 10.0    # 트레이스 10% 샘플링
  accessLogging:
    - {}                                 # 액세스 로그 활성화
  metrics:
    - overrides:                         # 메트릭 차원 커스터마이즈
        - match: { metric: REQUEST_COUNT }
          tagOverrides:
            request_method:
              value: "request.method"
```

> ★ 면접 포인트: "트레이싱 샘플링·로그를 어떻게 조절하나?" → **Telemetry API**로 메시/NS/워크로드 단위로 샘플링 비율, 액세스 로그 on/off, 메트릭 차원(라벨)을 선언적으로 제어한다. 전수 트레이싱은 비용이 크므로 **샘플링 비율 설정이 운영의 핵심**이다.

### 한 줄 요약
Ambient 모드는 데이터플레인을 **L4(노드별 ztunnel: mTLS·HBONE 터널)** 와 **L7(선택적 waypoint: 라우팅·인가·풍부한 텔레메트리)** 로 분리해 **저비용·무중단·점진 도입**을 가능하게 한다. 관측성 측면에서 Istio는 코드 변경 없이 **RED+TCP 표준 메트릭(서비스 그래프용 라벨 포함)·분산 트레이싱 span·액세스 로그**를 표준 포맷으로 내보내며, 그 동작은 **Telemetry API**로 제어한다. 단, **trace 헤더(B3/W3C) 전파는 애플리케이션의 책임**이다.

### 참고 (공식 문서)
- Ambient 아키텍처: https://istio.io/latest/docs/ambient/architecture/
- ztunnel 동작: https://istio.io/latest/docs/ambient/architecture/ztunnel/
- waypoint 프록시: https://istio.io/latest/docs/ambient/usage/waypoint/
- 관측성 개요: https://istio.io/latest/docs/concepts/observability/
- 분산 트레이싱(컨텍스트 전파): https://istio.io/latest/docs/tasks/observability/distributed-tracing/overview/
- Telemetry API: https://istio.io/latest/docs/reference/config/telemetry/
