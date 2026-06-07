# Gateway API 기능 상세 (Gateway API Features in Depth)

> 쿠버네티스 · 네트워킹/Gateway API · 학습내용: HTTPRoute 매칭(path/header/method/query)과 매칭 우선순위, 가중치 기반 트래픽 분할·카나리, 필터(Redirect/Rewrite/HeaderModifier/Mirror), 교차 네임스페이스+ReferenceGrant, TLSRoute/TCPRoute/GRPCRoute, Policy Attachment, status/conditions 디버깅

---

이 문서는 "심화"다. Gateway API로 **실제 라우팅을 어떻게 짜는지**를 YAML 중심으로 깊게 파고든다. 이 프로젝트는 외부 트래픽을 **OCI NLB → Gateway → HTTPRoute → Service** 순으로 받고(도메인 `ggang.cloud`, TLS는 cert-manager DNS-01, DNS는 external-dns+Cloudflare), 메시는 **Istio Ambient**(ztunnel + waypoint)로 구현한다. Gateway API 모델 자체는 컨트롤러가 무엇이든 똑같다.

## 1. HTTPRoute 매칭 (Matching)

`HTTPRoute.spec.rules[].matches[]` 가 "어떤 요청을 이 규칙이 처리할지"를 정의한다. 한 match 안의 여러 조건은 **AND**(전부 만족), 한 rule 안의 여러 match는 **OR**(하나라도 만족) 관계다.

### 1.1 Path 매칭

| type | 의미 | 예 |
|------|------|-----|
| **Exact** | 정확히 일치 | `/login` 만 |
| **PathPrefix** (기본) | **경로 세그먼트** 단위 접두 일치 | `/api` 는 `/api`, `/api/v1` 매칭 (단, `/apifoo`는 **아님**) |
| **RegularExpression** | 정규식 일치(구현체별 지원) | `^/users/[0-9]+$` |

> ★ 함정: PathPrefix는 **문자열 접두**가 아니라 **세그먼트 접두**다. `/api` PathPrefix는 `/api/v1`에는 매칭되지만 `/apiserver` 에는 **매칭되지 않는다**. 이걸 문자열 접두로 착각하면 라우팅이 어긋난다.

### 1.2 Header / Method / Query 매칭

```yaml
matches:
  - path:
      type: PathPrefix
      value: /shop
    method: POST
    headers:
      - name: X-Canary
        type: Exact          # Exact | RegularExpression
        value: "true"
    queryParams:
      - name: debug
        type: Exact
        value: "1"
```

- **headers**: 헤더 이름/값으로 매칭. `Exact` 또는 `RegularExpression`. 헤더 이름은 대소문자 무시.
- **method**: HTTP 메서드(`GET`, `POST`…)로 매칭.
- **queryParams**: 쿼리 파라미터로 매칭.

이런 매칭은 Ingress 표준엔 없던 것이라, **헤더 기반 카나리**(예: `X-Canary: true` 인 요청만 신버전으로) 같은 패턴을 표준 필드만으로 짤 수 있다.

### 1.3 매칭 우선순위 (Precedence) ★★★

요청 하나가 여러 rule/match에 걸릴 때 어떤 규칙이 이기는지는 명확히 규정돼 있다. **컨트롤러가 임의로 정하지 않고 스펙이 정한 순서**를 따른다.

가장 **구체적인(specific)** 매칭이 이긴다. 동점이면 다음 순서로 비교한다.

1. **path 의 정확도** — `Exact` > 더 긴 `PathPrefix` > 더 짧은 `PathPrefix`. (가장 긴/정확한 경로가 우선)
2. **method** 매칭이 있는 규칙 우선
3. **header** 매칭 개수가 많은 규칙 우선
4. **queryParams** 매칭 개수가 많은 규칙 우선

여전히 동점이면:

5. **HTTPRoute 생성 시각(creation timestamp)** 이 더 오래된 것 우선
6. 그래도 같으면 **이름의 알파벳 순서**(namespace/name)로 결정

> ★★★ 면접 핵심: "Gateway API의 라우팅 우선순위는 **선언 순서가 아니라 구체성(specificity)** 으로 정해진다. path 정확도(Exact > 긴 PathPrefix)가 1순위이고, 그다음 method, header 수, query 수 순. 동점이면 더 오래된 Route, 그다음 이름순." → Ingress가 컨트롤러마다 우선순위가 제각각이던 문제를 **표준화**한 부분이다.

```yaml
rules:
  - matches: [{ path: { type: Exact, value: /api/health } }]   # ① 가장 구체 → 항상 이김
    backendRefs: [{ name: health, port: 80 }]
  - matches: [{ path: { type: PathPrefix, value: /api } }]     # ② 그다음
    backendRefs: [{ name: api, port: 80 }]
  - matches: [{ path: { type: PathPrefix, value: / } }]        # ③ 폴백
    backendRefs: [{ name: web, port: 80 }]
```

## 2. 트래픽 분할 (Traffic Splitting) · 카나리

한 rule에 **여러 backendRefs를 두고 `weight`** 를 주면 트래픽이 비율대로 나뉜다. 가중치는 절대 백분율이 아니라 **합 대비 비율**이다(예: 90+10 → 90%/10%, 3+1 → 75%/25%).

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: shop, namespace: app }
spec:
  parentRefs: [{ name: web-gateway, namespace: gateway-system }]
  hostnames: ["shop.ggang.cloud"]
  rules:
    - backendRefs:
        - name: shop-v1
          port: 80
          weight: 90
        - name: shop-v2
          port: 80
          weight: 10        # 10% 카나리
```

- **카나리 진행**: weight를 90/10 → 50/50 → 0/100 으로 점진 조정해 신버전 비중을 올린다.
- **weight: 0** 인 백엔드는 트래픽을 안 받지만 정의는 유지된다(빠른 롤백 대비).
- **헤더 기반 카나리**와 결합하면(1.2절) "내부 테스터(헤더 보유)만 신버전, 나머지는 가중치 분할" 같은 정교한 배포까지 짜낸다.

> ★ 함정: weight를 모든 backendRef에서 생략하면 **균등 분배**다. 일부에만 weight를 주면 의도와 다르게 동작할 수 있으니 **분할할 땐 전부 명시**하는 게 안전하다.

## 3. 필터 (Filters)

`rules[].filters[]`(또는 `backendRefs[].filters[]`)로 요청/응답을 가공한다. 어노테이션 없이 **표준 타입**으로 처리한다는 게 핵심이다.

| 필터 | 무엇을 하나 |
|------|-------------|
| **RequestRedirect** | 클라이언트에게 리다이렉트 응답(스킴/호스트/경로/상태코드 변경). 예: HTTP→HTTPS |
| **URLRewrite** | 백엔드로 보내기 전 경로/호스트 **재작성**(리다이렉트 아님, 내부 변경) |
| **RequestHeaderModifier** | 백엔드로 가는 요청 헤더 add/set/remove |
| **ResponseHeaderModifier** | 클라이언트로 가는 응답 헤더 add/set/remove |
| **RequestMirror** | 요청 사본을 다른 백엔드로 **미러링**(응답은 무시) |
| **ExtensionRef** | 구현체별 확장 필터 연결 |

### 3.1 RequestRedirect — HTTP→HTTPS

```yaml
rules:
  - filters:
      - type: RequestRedirect
        requestRedirect:
          scheme: https
          statusCode: 301
```

### 3.2 URLRewrite — 경로/호스트 재작성

```yaml
rules:
  - matches: [{ path: { type: PathPrefix, value: /old } }]
    filters:
      - type: URLRewrite
        urlRewrite:
          path:
            type: ReplacePrefixMatch
            replacePrefixMatch: /new      # /old/x → /new/x
    backendRefs: [{ name: app, port: 80 }]
```

> ★ Redirect vs Rewrite 구분(면접 단골): **Redirect는 클라이언트에게 3xx를 돌려보내 다시 요청시키는 것**(URL 바뀜, 라운드트립 1회 추가), **Rewrite는 클라이언트 모르게 백엔드로 보낼 경로/호스트를 바꾸는 것**(URL 그대로, 내부 변경).

### 3.3 Header Modifier

```yaml
filters:
  - type: RequestHeaderModifier
    requestHeaderModifier:
      add:    [{ name: X-Env, value: prod }]
      set:    [{ name: X-Trace, value: on }]
      remove: ["X-Debug"]
```

### 3.4 RequestMirror — 트래픽 미러링(섀도잉)

```yaml
filters:
  - type: RequestMirror
    requestMirror:
      backendRef: { name: shop-v2, port: 80 }   # 사본만 받음, 응답은 버려짐
```

신버전을 **실서비스 트래픽으로 부하 테스트**할 때 요긴하다(사용자 응답엔 영향 없음).

## 4. 교차 네임스페이스 + ReferenceGrant

기본적으로 HTTPRoute의 `backendRefs`는 **같은 네임스페이스**의 Service만 참조한다. 다른 네임스페이스의 Service를 백엔드로 쓰려면 **대상(참조당하는) 네임스페이스에 ReferenceGrant**를 두어 명시적으로 허용한다.

```yaml
# app 네임스페이스의 Route
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata: { name: web, namespace: app }
spec:
  parentRefs: [{ name: web-gateway, namespace: gateway-system }]
  rules:
    - backendRefs:
        - name: backend
          namespace: data        # ← 다른 네임스페이스 Service
          port: 80
---
# data 네임스페이스(참조 당하는 쪽)에 두는 허락
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata: { name: allow-app, namespace: data }
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: app
  to:
    - group: ""
      kind: Service
```

> ★★★ 함정: ReferenceGrant를 빼먹으면 Route는 만들어지지만 **백엔드가 "거부"되어 트래픽이 안 간다**(보통 502/리졸브 실패). 이때 Route의 `status.conditions`에 `ResolvedRefs: False (RefNotPermitted)` 가 찍힌다(6절 디버깅 참고). ReferenceGrant는 반드시 **참조당하는 쪽 네임스페이스**에 둔다는 점도 자주 틀린다.

## 5. 다른 프로토콜 Route

HTTP 말고도 프로토콜별 Route가 있다. **HTTP/gRPC는 표준 채널, TLS/TCP/UDP Route는 실험적(experimental) 채널** 이라 별도 설치와 주의가 따른다.

### 5.1 TLSRoute — TLS 종료 vs 패스스루

| 모드 | 어디서 복호화 | 용도 |
|------|----------------|------|
| **Terminate** (Gateway 리스너에서) | Gateway가 TLS 종료 후 평문으로 백엔드 | 일반 HTTPS(L7 라우팅·헤더 조작 가능) |
| **Passthrough** (TLSRoute) | **백엔드까지 암호화 유지**, Gateway는 **SNI만 보고** 전달 | end-to-end mTLS, Gateway가 인증서를 못/안 가질 때 |

```yaml
# 리스너: passthrough면 SNI 기반으로만 라우팅 (Gateway는 복호화 안 함)
listeners:
  - name: tls-passthrough
    protocol: TLS
    port: 443
    tls: { mode: Passthrough }
    allowedRoutes: { kinds: [{ kind: TLSRoute }] }
---
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TLSRoute
metadata: { name: secure, namespace: app }
spec:
  parentRefs: [{ name: web-gateway, namespace: gateway-system }]
  hostnames: ["secure.ggang.cloud"]   # SNI로 매칭
  rules:
    - backendRefs: [{ name: secure-app, port: 8443 }]
```

> ★ Terminate vs Passthrough: **Terminate면 Gateway가 인증서를 갖고 복호화**하므로 L7 매칭/헤더 조작이 가능하다. **Passthrough면 Gateway가 SNI만 보고 통과**시키므로 헤더 기반 라우팅이 불가하지만, 종단 간 암호화가 유지된다. 이 프로젝트의 외부 HTTPS는 보통 **Terminate**(cert-manager 발급 인증서로 종료)다.

### 5.2 TCPRoute — L4 단순 전달

매칭 규칙 없이 리스너로 들어온 TCP를 백엔드로 전달한다.

```yaml
apiVersion: gateway.networking.k8s.io/v1alpha2
kind: TCPRoute
metadata: { name: db, namespace: app }
spec:
  parentRefs: [{ name: tcp-gateway, sectionName: postgres }]
  rules:
    - backendRefs: [{ name: postgres, port: 5432 }]
```

### 5.3 GRPCRoute — gRPC service/method 매칭

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GRPCRoute
metadata: { name: orders, namespace: app }
spec:
  parentRefs: [{ name: web-gateway, namespace: gateway-system }]
  hostnames: ["grpc.ggang.cloud"]
  rules:
    - matches:
        - method:
            service: orders.OrderService
            method: GetOrder
      backendRefs: [{ name: orders, port: 9090 }]
```

gRPC는 HTTP/2 기반이라 HTTPRoute로도 대충 되지만, **service/method 단위 매칭과 gRPC 상태코드 처리**는 GRPCRoute가 표준으로 다룬다.

## 6. Policy Attachment (정책 부착)

라우팅 규칙으로 표현하기 애매한 **횡단 설정**(타임아웃, 재시도, 헬스체크, 보안 정책 등)은 **Policy Attachment** 패턴으로 붙인다. 별도 Policy 리소스가 `targetRef`로 대상(Gateway/Route/Service 등)을 가리켜 정책을 "부착"하는 식이다.

- **방향성**: 보통 **상위(Gateway)에 붙으면 하위로 상속**되고, 하위(Route)에 더 구체적인 정책이 있으면 그게 우선(override)한다.
- **두 갈래**: 일부 설정은 표준 필드로 흡수되는 중(예: HTTPRoute의 `timeouts`)이고, 그 외 벤더·확장 정책은 각 구현체(예: Istio)가 자체 Policy CRD로 제공한다.

> ★ Policy Attachment는 "어노테이션 지옥"의 재발을 막는 **표준 확장 메커니즘**이다. 다만 "정책이 어디 붙어 어디까지 상속되는지"가 헷갈리기 쉬워, **status로 적용 여부를 확인**하는 습관이 중요하다.

## 7. status / conditions 디버깅 ★★★

Gateway API의 모든 리소스는 `.status.conditions` 와 (Route는) `.status.parents[]` 에 **실제 적용 결과**를 남긴다. "YAML은 apply 됐는데 트래픽이 안 간다" 류 문제는 원인이 거의 여기서 드러난다.

| 리소스 | 주요 condition | True여야 정상 / False면 의미 |
|--------|----------------|------------------------------|
| **Gateway** | `Accepted` | 스펙이 유효해 컨트롤러가 받아들임 |
| **Gateway** | `Programmed` | 실제 데이터플레인(LB/프록시)이 **프로비저닝 완료** |
| **Gateway listener** | `ResolvedRefs` | TLS Secret 등 참조가 해소됨 |
| **HTTPRoute (parents[])** | `Accepted` | Gateway에 **바인딩 성공**(parentRefs/allowedRoutes 합의됨) |
| **HTTPRoute (parents[])** | `ResolvedRefs` | backendRefs(Service)가 **해소됨** |

자주 보는 실패 신호는 다음과 같다.

- `Accepted: False (NotAllowedByListeners)` → Gateway의 **allowedRoutes** 가 이 Route의 네임스페이스/종류를 막음(권한 위임 정책 문제).
- `Accepted: False (NoMatchingParent / NoMatchingListenerHostname)` → `parentRefs`가 가리킨 리스너가 없거나 hostname 불일치.
- `ResolvedRefs: False (RefNotPermitted)` → **ReferenceGrant 누락**(교차 네임스페이스 참조 거부, 4절).
- `ResolvedRefs: False (BackendNotFound)` → backendRef의 Service 이름/포트 오타.
- Gateway `Programmed: False` → LB/프록시 미생성(클라우드 권한, 쿼터, 컨트롤러 로그 확인).

```bash
kubectl get gateway -A
kubectl describe gateway web-gateway -n gateway-system   # listener별 conditions
kubectl get httproute web -n app -o yaml | yq '.status'  # parents[].conditions
kubectl describe httproute web -n app
```

> ★★★ 면접/실무 핵심: Gateway API 디버깅의 출발점은 **무조건 `status.conditions`**. ① Gateway가 `Accepted` & `Programmed` 인가 → ② Route가 부모에 `Accepted` 인가(바인딩) → ③ `ResolvedRefs` 가 True인가(백엔드·ReferenceGrant) 순서로 좁혀 간다.

## 8. 함정 모음

- **PathPrefix는 세그먼트 단위** — `/api`가 `/apifoo`를 매칭하지 않음(1.1).
- **우선순위는 선언 순서가 아니라 구체성** — Exact > 긴 PathPrefix(1.3).
- **교차 네임스페이스 backend엔 ReferenceGrant 필수**, 그것도 **참조당하는 쪽**에(4).
- **Passthrough면 L7 매칭/헤더 조작 불가**(SNI만 보임)(5.1).
- **TLS/TCP/UDPRoute는 실험 채널** — 클러스터에 CRD가 설치돼 있어야 함(5).
- **문제 진단은 status.conditions 우선** — apply 성공 ≠ 적용 성공(7).

### 한 줄 요약
HTTPRoute는 **path/header/method/query** 로 매칭하고 우선순위는 **구체성(Exact>긴 PathPrefix>method>header수>query수, 동점이면 오래된 Route→이름순)** 으로 정해진다. **weight**로 카나리, **필터**(Redirect/Rewrite/Header/Mirror)로 가공, 교차 네임스페이스는 **ReferenceGrant**(참조당하는 쪽)로 허용한다. L4·패스스루는 **TCP/TLSRoute**, gRPC는 **GRPCRoute**, 횡단 설정은 **Policy Attachment**로 다루며, 모든 디버깅은 **status.conditions**(Accepted/Programmed/ResolvedRefs)에서 시작한다.

### 참고 (공식 문서)
- HTTPRoute: https://gateway-api.sigs.k8s.io/api-types/httproute/
- HTTP 라우팅/매칭 가이드: https://gateway-api.sigs.k8s.io/guides/http-routing/
- 트래픽 분할(weight): https://gateway-api.sigs.k8s.io/guides/traffic-splitting/
- TLS(Terminate/Passthrough): https://gateway-api.sigs.k8s.io/guides/tls/
- 교차 네임스페이스 라우팅(ReferenceGrant): https://gateway-api.sigs.k8s.io/guides/multiple-ns/
- Policy Attachment: https://gateway-api.sigs.k8s.io/reference/policy-attachment/
- GRPCRoute: https://gateway-api.sigs.k8s.io/api-types/grpcroute/
