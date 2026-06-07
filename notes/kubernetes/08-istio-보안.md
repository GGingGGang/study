# Istio 보안 (Istio Security)

> 쿠버네티스 · Istio · 학습내용: mTLS의 원리와 PeerAuthentication(STRICT/PERMISSIVE/DISABLE)·적용 범위, AuthorizationPolicy(ALLOW/DENY/AUDIT/CUSTOM·deny-by-default·source/operation/condition), RequestAuthentication(최종 사용자 JWT), 워크로드 신원 SPIFFE/SVID와 istiod CA의 인증서 자동 발급·회전, Ambient에서 ztunnel이 mTLS를 담당하는 방식

---

이 문서는 우리 프로젝트가 채택한 **Istio Ambient 모드**를 기준으로 보안을 다룬다. Ambient에서 **L4 mTLS와 워크로드 신원은 노드의 ztunnel이 담당**하고, **L7 인가(요청 단위 AuthorizationPolicy)** 는 해당 네임스페이스/서비스에 **waypoint** 가 있을 때 적용된다. 사이드카 모드는 비교용으로만 언급한다. 외부 진입은 Gateway API + OCI NLB로 `ggang.cloud` 에 연결된다.

## 1. Istio 보안의 세 기둥

Istio 보안은 세 가지 질문에 답한다.

| 질문 | 메커니즘 | CRD |
|------|----------|-----|
| **누가 통신하는가?** (워크로드 신원·암호화) | mTLS + SPIFFE 신원 | PeerAuthentication |
| **그 요청을 보낸 사람은 누구인가?** (최종 사용자) | JWT 검증 | RequestAuthentication |
| **이 요청을 허용할까?** (인가) | 신원·속성 기반 접근 제어 | AuthorizationPolicy |

> ★★★ **핵심**: 인증(Authentication)과 인가(Authorization)를 구분하라. **인증 = "너 누구야?"** 를 증명(mTLS의 워크로드 신원, JWT의 사용자 신원), **인가 = "그래서 이걸 해도 돼?"** 를 판단(AuthorizationPolicy). Istio는 또 **두 종류의 신원**을 다룬다: ① 서비스 간 통신의 **워크로드 신원(peer, mTLS/SPIFFE)** ② 요청을 시작한 **최종 사용자 신원(request, JWT)**.

## 2. mTLS (Mutual TLS)

### 2.1 원리

일반 TLS는 **서버만** 인증서로 신원을 증명한다(클라이언트는 익명). **mTLS(상호 TLS)** 는 **양쪽 모두** 인증서로 신원을 증명한다. Istio는 메시 내 서비스 간 통신을 mTLS로 자동 보호해 **① 도청 방지(암호화) ② 양방향 신원 확인 ③ 변조 방지**를 동시에 얻는다.

핵심은 이게 **애플리케이션 코드 변경 없이** 일어난다는 점이다. 평문으로 통신하던 두 서비스 사이에 프록시가 끼어들어 알아서 TLS 핸드셰이크를 하고 인증서를 검증한다.

### 2.2 적용 모드 — PeerAuthentication

**PeerAuthentication** CRD로 워크로드가 받는 트래픽의 mTLS 요구 수준을 정한다.

| 모드 | 의미 | 용도 |
|------|------|------|
| **STRICT** | **mTLS만 허용**, 평문 거부 | 보안 목표 상태 |
| **PERMISSIVE** | mTLS와 평문 **둘 다 허용** | 점진적 마이그레이션 중간 단계 |
| **DISABLE** | mTLS 끔(평문) | 특수 예외(외부 LB 헬스체크 등) |

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system     # 루트 네임스페이스 → 메시 전체에 적용
spec:
  mtls:
    mode: STRICT
```

> ★★★ **mTLS 마이그레이션 면접 포인트**: 처음부터 STRICT를 걸면 아직 메시에 안 들어온 워크로드가 보낸 평문이 전부 끊긴다. 그래서 **PERMISSIVE로 시작**(mTLS·평문 공존) → 모든 워크로드가 메시에 편입돼 mTLS로 말하게 되면 → **STRICT로 잠근다**. PERMISSIVE의 존재 이유가 바로 이 **무중단 점진 도입**이다.

### 2.3 적용 범위 (Scope)

PeerAuthentication은 어디에 두느냐로 범위가 달라진다. **좁은 범위가 넓은 범위를 덮어쓴다(override).**

| 범위 | 위치 / 셀렉터 |
|------|---------------|
| **메시 전체(mesh-wide)** | **루트 네임스페이스**(보통 `istio-system`) + 셀렉터 없음 |
| **네임스페이스(namespace-wide)** | 일반 네임스페이스 + 셀렉터 없음 |
| **워크로드(workload-specific)** | `selector.matchLabels` 로 특정 워크로드 지정 |

```yaml
# 메시는 STRICT지만, legacy 워크로드만 예외로 PERMISSIVE
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: legacy-permissive
  namespace: payments
spec:
  selector:
    matchLabels: { app: legacy-billing }
  mtls:
    mode: PERMISSIVE
```

> ★ 면접 포인트: "메시는 STRICT인데 특정 서비스만 평문이 필요하면?" → 그 워크로드에 셀렉터로 **PERMISSIVE/DISABLE PeerAuthentication을 별도로** 둔다. 범위가 좁을수록 우선한다.

## 3. 워크로드 신원 — SPIFFE / SVID 와 istiod CA

### 3.1 SPIFFE 신원

mTLS가 "양쪽을 인증한다"고 할 때, 그 **신원이 무엇인지**를 정의하는 표준이 **SPIFFE(Secure Production Identity Framework For Everyone)** 다. Istio는 워크로드의 신원을 **SPIFFE ID** 라는 URI 형식으로 표현한다.

```
spiffe://<trust-domain>/ns/<namespace>/sa/<service-account>
예) spiffe://cluster.local/ns/payments/sa/checkout
```

즉 신원의 뿌리는 **쿠버네티스 서비스 어카운트(ServiceAccount)** 다. 같은 ServiceAccount로 뜬 파드는 같은 신원을 가진다.

> ★★★ **신원 면접 포인트**: Istio의 워크로드 신원은 **IP나 호스트명이 아니라 SPIFFE ID(= 서비스 어카운트 기반)** 다. IP는 파드가 재스케줄되면 바뀌고 위조될 수 있지만, SPIFFE 신원은 **암호학적으로 증명되는 인증서**에 담긴다. AuthorizationPolicy도 이 신원(principal)을 기준으로 "checkout 서비스만 payments를 호출 가능" 같은 규칙을 쓴다.

### 3.2 SVID — 신원을 담은 인증서

**SVID(SPIFFE Verifiable Identity Document)** 는 SPIFFE ID를 담은 **X.509 인증서**다. 워크로드는 mTLS 핸드셰이크 때 이 SVID를 제시해 자신의 신원을 증명한다.

### 3.3 istiod CA — 자동 발급·회전

**istiod는 메시의 인증 기관(CA)** 역할을 한다. 인증서 발급·회전 흐름은 다음과 같다.

```
워크로드(에이전트)가 키페어 생성 + CSR 작성
        │
        ▼
   K8s ServiceAccount 토큰으로 자신을 증명하며 istiod에 CSR 제출
        │
        ▼
   istiod(CA)가 신원(SPIFFE ID) 검증 후 SVID(인증서) 서명·발급
        │
        ▼
   프록시(ztunnel/Envoy)가 SVID로 mTLS 수행
        │
        ▼
   만료 전에 자동 재발급(회전) — 수명이 짧음
```

> ★★★ **인증서 회전 면접 포인트**: Istio mTLS의 운영상 강점은 **인증서가 짧은 수명으로 자동 회전**된다는 점이다. 사람이 인증서를 만들거나 갱신할 필요가 없고(no manual cert management), 유출돼도 곧 만료되므로 위험이 짧다. **istiod가 CA**라는 것, **신원 증명의 출발점이 K8s ServiceAccount 토큰**이라는 것을 함께 답하면 깊이가 산다.

## 4. Ambient 모드에서의 mTLS — ztunnel

사이드카 모드는 파드마다 Envoy가 mTLS를 한다. **Ambient 모드는 노드의 ztunnel이 L4 mTLS를 담당**한다.

```
[Ambient mTLS 경로]

  소스 파드 ──평문──► ztunnel(소스 노드)
                          │  HBONE 터널(mTLS, HTTP/2 CONNECT)
                          ▼
                     ztunnel(목적 노드) ──평문──► 목적 파드
```

- **ztunnel**(노드 데몬, Rust)이 워크로드의 SVID를 가지고 **노드 간 트래픽을 HBONE 터널로 mTLS 암호화**한다.
- **HBONE(HTTP-Based Overlay Network Environment)**: mTLS로 보호된 HTTP/2 CONNECT 위에 원 트래픽을 캡슐화하는 방식.
- 워크로드 신원(SPIFFE/SVID)·istiod CA의 발급·회전 구조는 **사이드카 모드와 동일**하다. 단지 mTLS를 **수행하는 주체가 파드별 Envoy → 노드별 ztunnel** 로 바뀐 것이다.

| 구분 | 사이드카 mTLS | Ambient mTLS |
|------|--------------|--------------|
| 수행 주체 | 파드마다 **Envoy** | 노드마다 **ztunnel** |
| 암호화 단위 | 파드↔파드 | ztunnel↔ztunnel(HBONE) |
| 신원/CA | SPIFFE/SVID + istiod CA | **동일** |
| 비용 | 파드 수만큼 프록시 | 노드 수만큼 데몬(낮음) |

> ★ 면접 포인트: "Ambient에서 mTLS는 누가 하나?" → **노드의 ztunnel**이 HBONE 터널로 L4 mTLS를 한다. SPIFFE 신원·istiod CA·자동 회전은 그대로다. **암호화는 ztunnel(L4)이, 요청 단위 L7 인가는 waypoint가** 나눠 맡는다는 분리를 강조하면 좋다.

## 5. AuthorizationPolicy — 인가

### 5.1 액션 4종

**AuthorizationPolicy** 는 워크로드에 도달한 요청을 **허용/거부**한다. `action` 은 네 가지다.

| action | 의미 |
|--------|------|
| **ALLOW** | 규칙에 매칭되면 허용(기본 action) |
| **DENY** | 규칙에 매칭되면 거부 |
| **AUDIT** | 매칭 요청을 **로깅만**(허용/거부에 영향 없음) |
| **CUSTOM** | **외부 인가 엔진(extAuthz)** 에 위임(예: OPA, 외부 인증 서버) |

### 5.2 평가 순서와 deny-by-default

여러 정책이 있을 때 평가 순서는 **CUSTOM → DENY → ALLOW** 다. 그리고 가장 중요한 규칙:

> ★★★ **deny-by-default 면접 포인트**: **어떤 워크로드에 ALLOW 정책이 하나라도 적용되면, 그 정책에 매칭되지 않는 요청은 전부 거부**된다(allow-list 동작). 반대로 **그 워크로드에 적용되는 정책이 하나도 없으면 모두 허용**된다(기본 개방). 그래서 메시를 잠그려면 **빈 spec의 deny-all 정책**을 깔고 필요한 것만 ALLOW로 연다. "AuthorizationPolicy는 기본이 deny인가 allow인가?"의 정답은 **"정책이 없으면 allow, ALLOW 정책이 붙는 순간 그 워크로드는 deny-by-default가 된다"** 이다.

```yaml
# 1) 네임스페이스 전체를 deny-all로 잠금 (빈 spec)
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: deny-all
  namespace: payments
spec:
  {}                    # rules 없음 = 아무 요청도 허용 안 함
```

### 5.3 규칙 구성 — from / to / when

ALLOW 규칙은 **source(from) · operation(to) · condition(when)** 3축으로 쓴다.

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: allow-checkout
  namespace: payments
spec:
  selector:
    matchLabels: { app: billing }     # 이 정책을 적용할 대상 워크로드
  action: ALLOW
  rules:
    - from:                            # source: 누가
        - source:
            principals:               # mTLS 워크로드 신원(SPIFFE)
              - "cluster.local/ns/payments/sa/checkout"
      to:                              # operation: 무엇을
        - operation:
            methods: ["POST"]
            paths: ["/charge"]
      when:                            # condition: 조건
        - key: request.headers[x-env]
          values: ["prod"]
```

| 축 | 키워드(예) | 의미 |
|----|-----------|------|
| **from(source)** | `principals`, `namespaces`, `ipBlocks`, `requestPrincipals` | 호출 주체(워크로드 신원/NS/IP/JWT 주체) |
| **to(operation)** | `methods`, `paths`, `hosts`, `ports` | 어떤 작업(HTTP 메서드/경로 등) |
| **when(condition)** | `request.headers[..]`, `source.ip`, `request.auth.claims[..]` | 추가 조건 |

> ★ `principals` 는 mTLS로 증명된 **워크로드 신원**, `requestPrincipals` 는 **JWT(최종 사용자) 신원**이다. 이 둘을 섞어 "checkout 서비스가, prod 권한 JWT를 가진 사용자를 대신해 호출할 때만 허용" 같은 정교한 정책을 만들 수 있다.

### 5.4 Ambient에서의 인가 적용 지점

> ★★★ Ambient에서 **L4 수준 인가**(어느 워크로드/포트에서 오는지)는 ztunnel이 처리할 수 있지만, **HTTP 메서드·경로·헤더 같은 L7 조건**을 쓰는 AuthorizationPolicy는 **waypoint가 배치된 곳에서만** 동작한다. 그래서 세밀한 L7 인가가 필요한 네임스페이스/서비스에는 waypoint를 배포해야 한다. "Ambient에서 path 기반 인가가 안 먹는다"의 흔한 원인이 바로 waypoint 미배치다.

## 6. RequestAuthentication — 최종 사용자 JWT 검증

**RequestAuthentication** 은 요청에 담긴 **JWT를 검증**한다. 발급자(issuer)와 공개키(JWKS)를 지정하면, 메시가 토큰 서명·만료·issuer를 검증해 **유효하면 클레임을 추출**한다.

```yaml
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: jwt-auth
  namespace: payments
spec:
  selector:
    matchLabels: { app: api }
  jwtRules:
    - issuer: "https://auth.ggang.cloud"
      jwksUri: "https://auth.ggang.cloud/.well-known/jwks.json"
```

> ★★★ **RequestAuthentication 함정 면접 포인트**: RequestAuthentication **단독으로는 토큰 없는 요청을 막지 않는다**. 토큰이 **있으면 검증**하고, **없으면 그냥 통과**시킨다(검증만 할 뿐 강제 아님). 토큰을 **반드시 요구**하려면 AuthorizationPolicy에서 `requestPrincipals: ["*"]`(유효 JWT 보유자만 허용) 같은 규칙을 함께 걸어야 한다. 즉 **RequestAuthentication(검증) + AuthorizationPolicy(강제)** 가 한 쌍이다.

```yaml
# 유효한 JWT가 없는 요청은 거부
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: require-jwt
  namespace: payments
spec:
  selector:
    matchLabels: { app: api }
  action: ALLOW
  rules:
    - from:
        - source:
            requestPrincipals: ["*"]   # 유효 JWT(검증 통과)가 있어야 함
```

## 7. 전체 보안 흐름 정리

```
요청 도착
  │
  ① mTLS(PeerAuthentication): 상대 워크로드 신원(SPIFFE/SVID) 확인 — ztunnel
  │
  ② RequestAuthentication: JWT 서명/만료/issuer 검증 → 클레임 추출(L7, waypoint)
  │
  ③ AuthorizationPolicy: principals/requestPrincipals/operation/condition으로 허용/거부
  │     (CUSTOM → DENY → ALLOW 순, ALLOW 붙으면 deny-by-default)
  ▼
  허용 시 백엔드로 전달
```

### 한 줄 요약
Istio 보안은 **mTLS로 서비스 간 통신을 자동 암호화·상호 인증**(워크로드 신원은 SPIFFE/SVID, istiod CA가 발급·자동 회전)하고, **AuthorizationPolicy로 신원·속성 기반 인가**(ALLOW가 붙으면 deny-by-default), **RequestAuthentication으로 최종 사용자 JWT를 검증**한다. Ambient 모드에서는 **L4 mTLS를 ztunnel이**(HBONE 터널), **L7 인가·JWT는 waypoint가** 맡는다.

### 참고 (공식 문서)
- Istio 보안 개요: https://istio.io/latest/docs/concepts/security/
- 인증(PeerAuthentication/RequestAuthentication): https://istio.io/latest/docs/tasks/security/authentication/
- 인가(AuthorizationPolicy): https://istio.io/latest/docs/tasks/security/authorization/
- AuthorizationPolicy 레퍼런스: https://istio.io/latest/docs/reference/config/security/authorization-policy/
- 워크로드 신원(SPIFFE): https://istio.io/latest/docs/concepts/security/#istio-identity
- Ambient 보안(ztunnel/HBONE): https://istio.io/latest/docs/ambient/architecture/
