# Istio mTLS (PeerAuthentication + AuthorizationPolicy)

## 1. Why — 왜 쓰는가

Istio가 service mesh로서 가장 강력한 기능. **앱 코드 변경 없이** 모든 서비스간 통신을 mTLS(mutual TLS, 양방향 인증서 기반 암호화)로 보호하고 세밀한 인가 정책을 적용.

**평문 통신의 문제** (Istio 없이):
- 같은 클러스터 내부 통신도 평문 → 네트워크 sniffing 시 모든 데이터 노출
- 서비스간 인증 없음 → compromised pod이 모든 service 호출 가능
- 통신 정책이 NetworkPolicy(L4)만 → HTTP method, JWT claim 기반 정책 불가

**Istio mTLS의 해결**:
- **자동 mTLS**: ztunnel/sidecar가 모든 트래픽을 자동 mTLS 암호화. 앱 코드 변경 0.
- **SPIFFE ID 기반 인증**: 각 service account에 cryptographic identity. "누가 호출했는지" 검증 가능.
- **L7 AuthorizationPolicy**: HTTP path, method, header, JWT claim 기반 정책.

**Phase 6에서 다루는 2개 CR**:
1. **PeerAuthentication**: mTLS 모드 정책 (PERMISSIVE / STRICT / DISABLE)
2. **AuthorizationPolicy**: 누가 누구에게 무엇을 할 수 있는지

**대체재**:
- **Linkerd**: mTLS 자동. 더 단순하나 L7 policy 약함.
- **NetworkPolicy (Cilium)**: L4만, mTLS 안 됨, 인증 안 됨. 보완 관계.
- **앱 코드에 mTLS 구현**: 모든 service에 인증서 + JWT 검증 코드 → 운영 폭발

## 2. Architecture — 어떻게 구성되는가

**PeerAuthentication mode**:
- **DISABLE**: mTLS 안 함. 평문만 받음.
- **PERMISSIVE** (default): mTLS + 평문 둘 다 받음. 전환 기간용.
- **STRICT**: mTLS만 받음. 평문 거부.

**AuthorizationPolicy action**:
- **ALLOW**: 매칭 시 허용 (다른 ALLOW도 검사)
- **DENY**: 매칭 시 즉시 거부 (최우선)
- **AUDIT**: 매칭 시 로그만 남기고 통과 (테스트용)
- **CUSTOM**: 외부 authz service에 위임 (OPA 등)

**정책 평가 순서** (CUSTOM > DENY > ALLOW > 기본):
1. CUSTOM 매칭 있으면 → 외부 authz 결과
2. DENY 매칭 → 거부
3. ALLOW 매칭 → 허용
4. ALLOW 정책이 NS에 하나라도 있는데 매칭 안 됨 → 거부
5. ALLOW 정책이 NS에 없음 → 허용 (default-allow)

**SPIFFE Identity 형식**:
- `spiffe://<trust-domain>/ns/<namespace>/sa/<serviceaccount>`
- 예: `spiffe://cluster.local/ns/app/sa/login`
- Istio 내장 CA가 자동 발급, 24시간 만료, 자동 갱신

## 3. Mechanism — 어떻게 돌아가는가

**mTLS handshake** (Ambient mode 기준):
1. App A pod → Service B에 HTTP 요청 (평문)
2. ztunnel(A의 노드)가 트래픽 가로채기 (iptables/eBPF)
3. ztunnel A가 자기 SPIFFE 인증서로 TLS handshake 시작
4. ztunnel B와 mTLS 연결 (서로 인증서 검증)
5. 평문 HTTP 요청을 mTLS 터널로 전송 (HBONE 프로토콜)
6. ztunnel B가 평문 HTTP로 변환해서 B pod에 전달

**AuthorizationPolicy 평가**:
- L4 정책 (source IP/port 등): ztunnel이 평가
- L7 정책 (HTTP path/method 등): waypoint proxy가 평가 (Ambient에서)
- Sidecar mode에서는 sidecar envoy가 둘 다 평가

**STRICT 전환 시 효과**:
- ztunnel/sidecar가 평문 트래픽 거부 시작
- mesh 가입 안 된 pod(주입 안 됨)에서 mesh pod로의 통신 차단
- mesh pod간 통신은 자동 mTLS로 무중단

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Istio mTLS 의존 관계.

- **Istio control plane (istiod)** — SPIFFE 인증서 발급, 정책 push
- **ztunnel** (Ambient) — L4 mTLS 처리
- **waypoint proxy** (선택) — L7 AuthorizationPolicy 평가
- **monitoring NS** — Prometheus scrape이 STRICT NS에 도달하려면 mesh 가입 필수
- **strimzi (Kafka) NS** — sidecar/ztunnel 주입 제외 + PeerAuthentication DISABLE
- **모든 app NS** — STRICT mTLS 활성화

**핵심 제약**:
- mesh 가입 안 된 pod이 mesh pod에 평문으로 호출하면 STRICT에서 차단
- HTTP probes(liveness/readiness)도 mesh 가입 후엔 mTLS로 동작 — 별도 설정 필요할 수 있음

## 5. Usage — 어떻게 쓰는가

**Namespace를 mesh에 가입** (Ambient):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: app
  labels:
    istio.io/dataplane-mode: ambient
```

**Mesh-wide PERMISSIVE → 시작 권장**:

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system    # root config namespace
spec:
  mtls:
    mode: PERMISSIVE
```

**Namespace별 STRICT 전환**:

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: app
spec:
  mtls:
    mode: STRICT
```

**Strimzi NS는 DISABLE 별도 설정**:

```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: kafka
spec:
  mtls:
    mode: DISABLE
```

**AuthorizationPolicy 예시** (login service만 ingress gateway에서 호출 허용):

```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: login-from-gateway-only
  namespace: app
spec:
  selector:
    matchLabels:
      app: login
  action: ALLOW
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/istio-system/sa/istio-ingressgateway"]
    to:
    - operation:
        methods: ["GET", "POST"]
        paths: ["/api/*"]
```

**JWT 기반 인증** (Login Server → Core Server):

```yaml
# Login이 발급한 JWT 검증
apiVersion: security.istio.io/v1
kind: RequestAuthentication
metadata:
  name: jwt-validator
  namespace: app
spec:
  selector:
    matchLabels:
      app: core
  jwtRules:
  - issuer: "https://login.ggang.cloud"
    jwksUri: "https://login.ggang.cloud/.well-known/jwks.json"
---
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: core-require-jwt
  namespace: app
spec:
  selector:
    matchLabels:
      app: core
  action: ALLOW
  rules:
  - from:
    - source:
        requestPrincipals: ["*"]   # JWT 있어야 함
```

**검증** (`istioctl`):

```bash
# 현재 mTLS 정책 확인
istioctl x authz check <pod> -n app

# mTLS 상태 시각화
istioctl proxy-config secret <pod> -n app

# Kiali UI의 자물쇠 아이콘으로도 확인
```

## 6. Configuration — 어떤 설정이 있는가

**PeerAuthentication scope**:
- `istio-system` namespace: mesh-wide 적용
- 일반 namespace: 해당 NS 적용
- `selector` 추가: 특정 workload만

**AuthorizationPolicy source 종류**:
- `principals`: SPIFFE ID (서비스 단위, mTLS 필요)
- `requestPrincipals`: JWT subject (사용자 단위)
- `namespaces`: 호출자 namespace
- `ipBlocks`: IP CIDR
- `notPrincipals` 등 not* 변형 (negation)

**AuthorizationPolicy operation**:
- `methods`: HTTP 메서드
- `paths`: HTTP path (wildcard 가능, `/api/*`)
- `hosts`: HTTP host header
- `ports`: 대상 포트

**RequestAuthentication (JWT)**:
- `issuer`: 신뢰할 JWT 발급자
- `jwksUri`: 공개키 가져올 URL
- `audiences`: aud claim 검증
- `outputClaimToHeaders`: claim을 HTTP header로 변환

**Trust domain**:
- default `cluster.local`
- multi-cluster federation 시 변경 필요

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Istio 1.20+** (Gateway API + Ambient 안정. 본 프로젝트 1.24+)
- **Kubernetes 1.27+**
- **AuthorizationPolicy v1**: stable
- **RequestAuthentication v1**: stable
- **CUSTOM action**: external authz service(OPA, OAuth2-Proxy) 필요
- **Strimzi 비호환**: 별도 NS 제외 필수

## 8. 면접 예상 질문 & 답변

**Q1. mTLS를 자동으로 적용한다는 게 무슨 뜻이에요?**
> 앱 코드 변경 없이 ztunnel/sidecar가 트래픽을 가로채서 자동으로 TLS 암호화 + 양방향 인증서 검증을 수행한다는 뜻입니다. 앱은 평문 HTTP를 보내지만 실제 네트워크에서는 mTLS로 흐릅니다. 각 service account에 SPIFFE ID 기반 X.509 인증서가 자동 발급되고 24시간마다 갱신됩니다. 결과적으로 (1) 네트워크 sniffing으로 데이터 노출 방지, (2) compromised pod이 다른 service를 평문으로 호출 못 함, (3) "어느 service가 호출했는가" cryptographic하게 검증 가능합니다.

**Q2. PERMISSIVE에서 STRICT로 어떻게 안전하게 전환해요?**
> 네 단계로 갑니다. (1) Mesh-wide PERMISSIVE로 시작 — 기존 평문 통신 깨지지 않음. (2) 모든 NS의 pod에 sidecar/ztunnel이 주입됐는지 `istioctl proxy-status`로 확인. (3) Namespace별로 STRICT 전환 — `app` → `monitoring` → `cicd` → `external-dns/cert-manager` 순서. 각 NS 전환 후 30분 모니터링 (Kiali로 mTLS 자물쇠 + 4xx/5xx 메트릭 확인). 문제 발생 시 즉시 PERMISSIVE로 revert. (4) 모든 NS 안정 확인 후 mesh-wide STRICT. Strimzi NS는 절대 STRICT 적용하지 말고 DISABLE 유지.

**Q3. STRICT 전환 시 가장 흔한 사고 두 가지는?**
> (1) monitoring NS가 mesh에 안 가입된 상태에서 STRICT 전환하면 Prometheus가 app NS의 /metrics scrape 시 평문 거부당해서 모든 메트릭이 끊깁니다. (2) Strimzi Kafka NS에 ztunnel/sidecar가 주입되면 Kafka 자체 SSL과 이중 암호화로 핸드셰이크가 깨져 브로커-클라이언트 통신이 죽습니다. 첫 번째는 monitoring NS도 mesh 가입으로 해결, 두 번째는 Strimzi NS에 `istio.io/dataplane-mode: none` label + PeerAuthentication DISABLE로 mesh 자체에서 제외.

**Q4. AuthorizationPolicy ALLOW와 DENY 평가 순서는?**
> CUSTOM > DENY > ALLOW > default 입니다. (1) CUSTOM 매칭 있으면 외부 authz 결과 사용. (2) DENY 매칭이 하나라도 있으면 즉시 거부. (3) ALLOW 매칭 있으면 허용. (4) 해당 namespace에 ALLOW 정책이 하나라도 있는데 매칭 안 되면 거부(default-deny 효과). (5) ALLOW 정책 자체가 없는 namespace는 default-allow. 본 프로젝트는 각 service에 ALLOW 정책 명시해서 매칭 안 되면 자동 deny되는 default-deny 효과를 만듭니다.

**Q5. SPIFFE ID가 뭐고 왜 중요해요?**
> Secure Production Identity Framework for Everyone의 약자로, workload(pod, container 등)에 cryptographic identity를 부여하는 표준입니다. Istio는 SPIFFE ID를 `spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>` 형식으로 발급하고 X.509 인증서 SAN에 포함시킵니다. 중요한 이유는 (1) IP나 hostname 대신 cryptographic하게 검증 가능한 identity 사용, (2) AuthorizationPolicy에서 `principals` 필드로 특정 SA만 허용 가능, (3) 멀티 클러스터/멀티 클라우드에서도 동일한 identity 체계. IP 기반 정책이 비신뢰적인 클라우드 환경에서 표준이 되고 있습니다.

**Q6. AuthorizationPolicy로 JWT 검증은 어떻게 해요?**
> RequestAuthentication CR로 JWT 검증 정책을 정의하고 AuthorizationPolicy에서 활용합니다. RequestAuthentication에 `issuer`(JWT 발급자)와 `jwksUri`(공개키 URL)를 명시하면 ztunnel/waypoint가 모든 요청의 Authorization 헤더를 자동 검증합니다. AuthorizationPolicy의 `from.source.requestPrincipals: ["*"]`로 "JWT가 검증된 요청만 허용" 정책을 만듭니다. 본 프로젝트의 Login Server는 JWKS를 `/.well-known/jwks.json`에 노출하고, Core Server는 RequestAuthentication으로 Login JWT를 검증해서 앱 코드에 JWT 검증 미들웨어가 불필요해집니다.

**Q7. Ambient mode에서 L7 AuthorizationPolicy는 어떻게 적용돼요?**
> waypoint proxy가 필요합니다. Ambient의 ztunnel은 L4 mTLS만 처리하고, L7 정책(HTTP path, method, JWT 등)은 waypoint envoy가 평가합니다. waypoint는 필요한 NS/service에만 배포해서 자원 절감합니다. AuthorizationPolicy에 `targetRef`로 특정 waypoint를 지정하면 그 waypoint가 정책 평가를 수행합니다. 본 프로젝트는 app NS에 waypoint 1개 배포해서 L7 정책 처리.

**Q8. mTLS 자동인데 왜 인증서를 신경 써야 해요?**
> 보통은 신경 안 써도 됩니다. istiod 내장 CA가 자동 발급/갱신하고 만료는 24시간이지만 1시간 전 자동 갱신됩니다. 신경 써야 하는 경우는 (1) istiod CA를 Vault PKI engine으로 교체할 때 — 키 관리 위탁, (2) multi-cluster federation 시 trust domain 통일 필요, (3) external service와 mTLS 할 때 — Istio 내부 CA가 발급한 인증서를 외부에서 신뢰하지 않으므로 별도 CA bundle 필요. 본 프로젝트는 단일 클러스터 + 외부 mTLS 없음이라 기본 설정으로 충분합니다.

**Q9. AuthorizationPolicy로 default-deny 만들려면?**
> 빈 ALLOW 정책 또는 매칭 안 되는 ALLOW 정책 하나를 명시합니다. Istio는 "namespace에 ALLOW 정책이 하나라도 있는데 매칭 안 되면 거부" 규칙이라, 모든 service에 명시적 ALLOW 정책을 만들면 자동으로 default-deny 효과가 됩니다. 예: 각 service에 `app: <name>` selector + 정확한 principals/operations 명시. 매칭 안 되는 모든 요청은 거부. 더 명확하게 하려면 빈 spec의 DENY 정책 추가 가능하지만 보통 명시적 ALLOW만으로 충분.

**Q10. mTLS가 성능에 영향 주나요?**
> 약간 줍니다. TLS handshake CPU 비용 + 메모리 약간 + latency 1-3ms. 단, ztunnel은 매우 효율적이고 connection pooling 활용하므로 일반 트래픽에서 체감 어려운 수준입니다. Sidecar mode는 envoy 풀스택이라 약간 더 부담. 본 프로젝트는 Ambient mode 선택으로 mTLS overhead 최소화. 또 mTLS는 보안 가치 대비 성능 비용이 매우 작아서 production에서 거의 모든 경우에 권장됩니다.

**Q11. Istio mTLS 적용 후 디버깅 어떻게 해요?**
> 평문 통신이 안 되니까 일반 curl/wget이 안 됩니다. (1) `istioctl proxy-config secret <pod>`로 SPIFFE 인증서 확인. (2) Kiali UI의 자물쇠 아이콘으로 시각적 확인. (3) `istioctl x authz check <pod>`로 어느 정책이 적용 중인지. (4) mesh 가입된 다른 pod에서 호출 테스트. (5) ztunnel 로그 확인 — 거부된 connection 이유 표시. 가장 빠른 디버깅은 Kiali + ztunnel 로그 조합입니다.

**Q12. AuthorizationPolicy 너무 복잡해지면 어떻게 관리해요?**
> 본 프로젝트는 세 가지 원칙으로 단순화합니다. (1) NS 단위로 default-deny 정책 1개, (2) service 단위로 ALLOW 정책 1개씩 (해당 service에 들어올 수 있는 호출자 명시), (3) 외부 (gateway) 진입은 별도 ALLOW 정책. 결과적으로 service 5개면 정책 ~7개로 관리됩니다. 이걸 OPA(Open Policy Agent) Rego로 분리하는 패턴(CUSTOM action)도 있지만 복잡도가 더 커서 일반적인 환경에선 Istio AuthorizationPolicy로 충분합니다.
