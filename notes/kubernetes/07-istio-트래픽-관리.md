# Istio 트래픽 관리 (Istio Traffic Management)

> 쿠버네티스 · Istio · 학습내용: VirtualService/DestinationRule/Gateway/ServiceEntry/Sidecar 리소스의 역할, 가중치 기반 트래픽 분할과 카나리·블루그린, 타임아웃·리트라이·서킷 브레이커(connection pool + outlier detection), 폴트 인젝션, 트래픽 미러링(shadow), 헤더/URI 라우팅, 로케일리티 로드밸런싱

---

이 문서는 우리 프로젝트가 채택한 **Istio Ambient 모드**를 기준으로 트래픽 관리를 다룬다. Ambient에서 L7 라우팅·리트라이·서킷 브레이커 같은 고급 기능은 해당 네임스페이스/서비스에 **waypoint 프록시(Envoy)** 가 배치돼 있을 때 적용된다. waypoint가 없으면 ztunnel이 L4(mTLS)만 처리하므로, 아래 VirtualService/DestinationRule의 L7 정책은 동작하지 않는다. 사이드카 모드는 비교용으로만 언급한다. 외부 노출은 Gateway API 기반으로 OCI NLB(네트워크 로드밸런서)를 거쳐 도메인 `ggang.cloud` 로 들어온다.

## 1. 트래픽 관리 리소스 전체 지도

Istio의 트래픽 관리는 **"무엇을 어디로(routing)"** 와 **"목적지에 어떻게 연결할까(policy)"** 를 서로 다른 CRD로 분리한다.

| CRD | 한 줄 정의 | 비유 |
|------|-----------|------|
| **VirtualService** | 들어온 요청을 **어느 서비스/서브셋으로 보낼지** 결정하는 라우팅 규칙 | "교통 표지판 + 분기기" |
| **DestinationRule** | 목적지에 **어떻게 붙을지**(서브셋 정의, LB, 커넥션 풀, 서킷 브레이커, TLS) | "목적지 도착 후 운영 규칙" |
| **Gateway** | 메시 **경계(edge)** 의 진입/출구 포트·프로토콜·TLS(L4~L6) | "건물 정문" |
| **ServiceEntry** | 메시 **외부 서비스**를 내부 레지스트리에 등록 | "외부 주소록 등록" |
| **Sidecar** | (사이드카 모드 한정) 프록시가 보는 서비스 **범위 축소** | "시야 제한" |

> ★★★ **핵심**: 가장 자주 헷갈리는 게 **VirtualService vs DestinationRule** 이다. VirtualService는 **"어디로 보낼지"(라우팅·분할·타임아웃·리트라이·폴트·미러링)**, DestinationRule은 **"목적지에 어떻게 붙을지"(서브셋·LB·커넥션 풀·outlier detection)**. 가중치 카나리를 하려면 보통 **둘 다** 필요하다. DestinationRule에서 `subset`(버전 그룹)을 정의하고, VirtualService에서 그 subset에 가중치를 준다.

### 1.1 라우팅 매칭의 우선순위

VirtualService의 `http` 규칙은 **위에서 아래로 순서대로** 평가된다(첫 매칭 우선). 그래서 **구체적인 규칙(헤더/URI 매칭)은 위에, 기본 라우트(catch-all)는 맨 아래**에 둔다. 매칭에는 `uri`(prefix/exact/regex), `headers`, `method`, `queryParams` 등을 쓴다.

## 2. Gateway — 메시 경계 진입

전통 Istio **Gateway** CRD는 메시 가장자리에서 외부 트래픽이 들어오는 **포트·프로토콜·호스트·TLS**를 정의한다. 단, Gateway 단독으로는 라우팅을 못 하므로 **VirtualService를 그 Gateway에 바인딩**해야 실제로 트래픽이 흐른다.

```yaml
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: ggang-gateway
  namespace: istio-ingress
spec:
  selector:
    istio: ingressgateway          # 이 Gateway를 구현할 게이트웨이 파드 선택
  servers:
    - port:
        number: 443
        name: https
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: ggang-cloud-cert   # TLS 인증서가 담긴 Secret
      hosts:
        - "ggang.cloud"
```

> ★ 우리 프로젝트는 외부 노출을 쿠버네티스 표준인 **Gateway API**(Gateway/HTTPRoute 리소스)로 하고, 그 앞단을 OCI NLB가 받아 `ggang.cloud` 로 연결한다. 전통 Istio Gateway CRD와 Gateway API는 **같은 데이터플레인을 설정하는 두 가지 선언 방식**이다. 면접에서 "Istio Gateway와 Gateway API 차이?"를 물으면 → 전자는 Istio 전용 CRD, 후자는 여러 구현체가 공유하는 K8s 표준 API. 신규 프로젝트는 Gateway API 방향.

## 3. 가중치 기반 트래픽 분할 · 카나리 · 블루그린

### 3.1 서브셋 정의 (DestinationRule)

먼저 DestinationRule로 같은 서비스의 **버전 그룹(subset)** 을 라벨로 정의한다.

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-dr
spec:
  host: reviews              # 대상 K8s 서비스
  subsets:
    - name: v1
      labels: { version: v1 }   # 파드 라벨 version=v1
    - name: v2
      labels: { version: v2 }
```

### 3.2 카나리 (가중치 분할)

VirtualService에서 subset별 **weight 합 100**으로 트래픽 비율을 정한다. 90:10에서 시작해 점진적으로 v2 비중을 올리는 게 카나리다.

```yaml
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews-vs
spec:
  hosts: [reviews]
  http:
    - route:
        - destination: { host: reviews, subset: v1 }
          weight: 90
        - destination: { host: reviews, subset: v2 }
          weight: 10
```

> ★★★ **카나리 면접 포인트**: 카나리는 **새 버전(v2)에 소량 트래픽만 흘려 실 사용자 영향으로 검증**한 뒤 비율을 올리는 방식이다. Istio가 강력한 이유는 **레플리카 수와 트래픽 비율을 분리**한다는 점. 디플로이먼트 레플리카 비율로 카나리를 하면 10%를 맞추려고 파드 개수를 맞춰야 하지만, Istio는 **weight로 정확한 비율**을 주므로 v2 파드 1개로도 10%를 정확히 보낼 수 있다.

### 3.3 블루그린

블루그린은 v1(blue)과 v2(green)를 **둘 다 띄워 둔 채 weight를 100:0 → 0:100으로 한 번에 전환**하는 방식이다. 카나리가 "점진 비율 증가"라면, 블루그린은 "스위치 토글"이다. 문제가 생기면 weight를 다시 0:100으로 되돌려 **즉시 롤백**한다.

| 구분 | 카나리(Canary) | 블루그린(Blue-Green) |
|------|----------------|---------------------|
| 전환 방식 | 비율을 **점진적으로** 증가(10→30→100) | **한 번에** 전환(100:0 → 0:100) |
| 검증 노출 | 실제 사용자 일부에게 점진 검증 | 전환 직후 전체 노출 |
| 롤백 | weight를 다시 낮춤 | weight를 즉시 역전 |
| 리소스 | 두 버전 동시 운영(green 소량 가능) | 두 버전 **풀 용량** 동시 운영 |
| 핵심 위험 | 점진 증가 중 모니터링 필요 | 전환 순간 전체 영향 |

### 3.4 헤더 기반 라우팅과 결합한 안전한 카나리

특정 헤더를 가진 **내부 테스터에게만 v2**를 보내고, 나머지는 v1로 가게 하면 "다크 런치" 형태의 안전한 검증이 된다.

```yaml
http:
  - match:
      - headers:
          x-tester: { exact: "true" }   # 테스터 헤더가 있으면
    route:
      - destination: { host: reviews, subset: v2 }
  - route:                                # 그 외 모두 (catch-all)
      - destination: { host: reviews, subset: v1 }
```

## 4. 헤더 / URI 기반 라우팅과 조작

VirtualService는 매칭뿐 아니라 **요청/응답 헤더 조작**과 **URI rewrite, redirect**도 한다.

```yaml
http:
  - match:
      - uri: { prefix: "/api/v2" }
    rewrite:
      uri: "/"                    # 백엔드에는 /api/v2 떼고 / 로 전달
    route:
      - destination: { host: api-v2 }
    headers:
      request:
        set: { x-route: "v2" }    # 백엔드로 갈 때 헤더 추가
      response:
        remove: ["x-internal"]    # 응답에서 내부 헤더 제거
```

> ★ URI `rewrite` 와 `redirect` 구분: **rewrite는 백엔드로 가는 경로를 바꾸는 것(사용자는 모름)**, **redirect는 3xx로 클라이언트에게 다른 URL로 다시 요청하라고 응답**하는 것이다.

## 5. 타임아웃 (Timeout)

요청이 무한정 대기해 리소스를 잡아먹지 않도록, 한 요청의 **최대 대기 시간**을 건다. 미설정 시 Istio 기본은 사실상 무제한(비활성)이므로 명시하는 게 좋다.

```yaml
http:
  - route:
      - destination: { host: reviews, subset: v1 }
    timeout: 2s                    # 2초 안에 응답 없으면 504
```

> ★ 타임아웃은 **리트라이와 상호작용**한다. 전체 timeout이 리트라이까지 포함한 상한이므로, `timeout` 보다 개별 시도 시간이 길면 리트라이가 끝까지 못 돌 수 있다. 둘을 함께 설계해야 한다.

## 6. 리트라이 (Retry)

일시적 실패(네트워크 흔들림, 5xx)에 대해 **자동 재시도**한다.

```yaml
http:
  - route:
      - destination: { host: reviews }
    retries:
      attempts: 3                          # 최대 3회 재시도
      perTryTimeout: 1s                     # 시도당 1초
      retryOn: "5xx,reset,connect-failure"  # 어떤 조건에서 재시도할지
```

> ★★★ **리트라이 면접 포인트**: 리트라이는 양날의 검이다. 잘못 쓰면 **장애 상황에서 트래픽을 증폭(retry storm)** 시켜 다운스트림을 더 무너뜨린다. 그래서 ① **멱등(idempotent) 요청에만**(보통 GET) ② **재시도 횟수 제한** ③ **서킷 브레이커와 함께** 써야 안전하다. `retryOn` 에 `5xx` 를 넣을 때, 비멱등 POST가 중복 처리될 위험을 항상 고려해야 한다.

## 7. 서킷 브레이커 (Circuit Breaker)

서킷 브레이커는 **DestinationRule의 `trafficPolicy`** 에서 두 축으로 구성된다: **커넥션 풀 제한**(부하 자체를 막음)과 **outlier detection**(망가진 인스턴스를 풀에서 제거).

```yaml
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews-cb
spec:
  host: reviews
  trafficPolicy:
    connectionPool:
      tcp:
        maxConnections: 100           # 업스트림 최대 TCP 커넥션
      http:
        http1MaxPendingRequests: 10   # 대기열 최대 요청 수
        maxRequestsPerConnection: 1   # keep-alive 재사용 제한
    outlierDetection:
      consecutive5xxErrors: 5         # 연속 5xx 5번이면
      interval: 10s                   # 10초마다 검사
      baseEjectionTime: 30s           # 30초 동안 풀에서 제외
      maxEjectionPercent: 50          # 최대 50%까지만 제외(전멸 방지)
```

| 구성 요소 | 목적 | 동작 |
|-----------|------|------|
| **connectionPool** | **유입 부하 제한** | 동시 커넥션/대기 요청이 한계를 넘으면 **즉시 503**으로 빠르게 실패(fail-fast) |
| **outlierDetection** | **불량 인스턴스 격리** | 연속 에러가 잦은 엔드포인트를 일정 시간 **로드밸런싱 풀에서 추방(eject)** |

> ★★★ **서킷 브레이커 면접 포인트**: 핵심 가치는 **"빠른 실패(fail-fast)와 격리"** 다. 다운스트림이 느려졌을 때 커넥션 풀이 차면 **즉시 503**을 돌려보내 호출 측 스레드/커넥션이 묶이는 걸 막고, 연쇄 장애(cascading failure)를 차단한다. outlier detection은 **건강한 인스턴스로만 트래픽을 몰아** 자가 치유를 돕는다. `maxEjectionPercent` 로 **전 인스턴스가 동시에 추방돼 서비스가 비는 사태**를 방지하는 것까지 답하면 좋다.

## 8. 폴트 인젝션 (Fault Injection)

장애를 **일부러 주입**해 시스템의 복원력(리트라이·타임아웃·서킷 브레이커가 제대로 동작하는지)을 테스트한다. 두 종류가 있다.

```yaml
http:
  - fault:
      delay:
        percentage: { value: 10 }    # 요청의 10%에
        fixedDelay: 5s               # 5초 지연 주입
      abort:
        percentage: { value: 5 }     # 요청의 5%에
        httpStatus: 503              # 503으로 강제 실패
    route:
      - destination: { host: reviews, subset: v1 }
```

| 종류 | 무엇 | 검증 대상 |
|------|------|-----------|
| **delay** | 응답을 일부러 **지연** | 타임아웃·리트라이가 정상 동작하는가 |
| **abort** | 일부 요청을 **에러 코드로 강제 실패** | 서킷 브레이커·폴백 로직이 동작하는가 |

> ★ 폴트 인젝션은 **카오스 엔지니어링**의 한 도구다. 코드를 건드리지 않고 메시 레벨에서 장애를 흉내 낼 수 있어, 운영 전에 복원력 가정을 검증한다. `percentage` 로 일부 트래픽에만 주입해 영향 범위를 통제한다.

## 9. 트래픽 미러링 (Mirroring / Shadow)

운영 트래픽의 **복사본**을 새 버전에 보내되, **그 응답은 버린다(fire-and-forget)**. 실제 사용자에게는 영향 없이 신버전을 실 트래픽으로 테스트하는 방법이다.

```yaml
http:
  - route:
      - destination: { host: reviews, subset: v1 }   # 실제 응답은 v1
    mirror:
      host: reviews
      subset: v2                                       # 복사본을 v2에도 전송
    mirrorPercentage:
      value: 20                                        # 트래픽의 20%만 미러링
```

> ★★★ **미러링 면접 포인트**: 미러링(shadowing)의 핵심은 **"사용자 영향 0으로 실 트래픽 테스트"** 다. 미러된 요청의 응답은 클라이언트로 가지 않으므로 v2가 에러를 내도 사용자는 모른다. 단, **부작용(DB 쓰기, 외부 결제 호출)이 있는 요청을 미러링하면 실제로 중복 실행**되므로 주의해야 한다는 점을 함께 답하면 좋다. 미러 트래픽의 Host 헤더에는 `-shadow` 가 붙어 구분된다.

## 10. ServiceEntry — 외부 서비스 편입

기본적으로 메시는 클러스터 내부 서비스만 안다. **ServiceEntry**로 외부 API(예: 외부 결제 게이트웨이)를 **내부 레지스트리에 등록**하면, 그 외부 호출에도 타임아웃·리트라이·DestinationRule 같은 메시 정책을 적용할 수 있다.

```yaml
apiVersion: networking.istio.io/v1
kind: ServiceEntry
metadata:
  name: external-api
spec:
  hosts: ["api.external.com"]
  ports:
    - number: 443
      name: https
      protocol: TLS
  resolution: DNS
  location: MESH_EXTERNAL
```

> ★ 면접 포인트: "메시 밖 외부 API에도 Istio 정책을 걸 수 있나?" → **ServiceEntry로 등록하면 가능**하다. 등록 후 VirtualService/DestinationRule을 그 host에 적용해 타임아웃·리트라이·서킷 브레이커를 외부 호출에도 적용한다.

## 11. 로케일리티 로드밸런싱 (Locality LB)

멀티 리전/존 클러스터에서, 호출자와 **같은 존(zone)/리전의 엔드포인트를 우선** 선택해 지연과 비용을 줄이고, 그 존이 죽으면 **다른 존으로 자동 페일오버**한다.

```yaml
trafficPolicy:
  loadBalancer:
    localityLbSetting:
      enabled: true
      failover:                       # region 단위 페일오버 순서
        - from: us-west
          to: us-east
  outlierDetection:                   # locality LB는 outlierDetection이 켜져야 페일오버 동작
    consecutive5xxErrors: 5
    interval: 5s
    baseEjectionTime: 30s
```

> ★ 로케일리티 LB의 함정: **페일오버는 outlierDetection이 켜져 있어야** 동작한다. "같은 존 우선"만 켜고 outlier detection을 안 하면, 로컬 존이 죽어도 다른 존으로 넘어가지 못한다. 이 의존 관계를 알면 면접에서 깊이를 보여줄 수 있다.

## 12. Sidecar 리소스 (참고 — 사이드카 모드 전용)

**Sidecar** CRD는 사이드카 모드에서 각 Envoy가 **보는 서비스 범위를 좁혀** 메모리·설정 푸시 비용을 줄인다. 우리 프로젝트는 Ambient 모드라 직접 쓰지 않지만, 사이드카 모드의 확장성 한계를 이해하는 데 중요하다.

> ★ 면접 포인트: 사이드카 모드에서 서비스가 많아지면 **모든 Envoy가 전체 서비스 설정을 받아** 메모리가 폭증한다. Sidecar 리소스의 `egress.hosts` 로 시야를 제한해 이를 완화한다. **Ambient 모드는 ztunnel이 노드 단위라 이 per-pod 설정 폭증 문제 자체가 줄어든다**는 게 Ambient의 장점 중 하나다.

### 한 줄 요약
Istio 트래픽 관리는 **"어디로 보낼지"(VirtualService)** 와 **"목적지에 어떻게 붙을지"(DestinationRule)** 를 분리해, 코드 변경 없이 가중치 분할(카나리·블루그린)·타임아웃·리트라이·서킷 브레이커·폴트 인젝션·미러링·로케일리티 LB를 선언적으로 제공한다. Ambient 모드에서는 이런 L7 기능이 **waypoint가 배치된 곳에서** 동작하며, 외부 진입은 Gateway API + OCI NLB로 `ggang.cloud` 에 연결된다.

### 참고 (공식 문서)
- 트래픽 관리 개요: https://istio.io/latest/docs/concepts/traffic-management/
- VirtualService 레퍼런스: https://istio.io/latest/docs/reference/config/networking/virtual-service/
- DestinationRule(서킷 브레이커·LB): https://istio.io/latest/docs/reference/config/networking/destination-rule/
- 카나리/가중치 라우팅 태스크: https://istio.io/latest/docs/tasks/traffic-management/traffic-shifting/
- 폴트 인젝션 태스크: https://istio.io/latest/docs/tasks/traffic-management/fault-injection/
- 트래픽 미러링 태스크: https://istio.io/latest/docs/tasks/traffic-management/mirroring/
