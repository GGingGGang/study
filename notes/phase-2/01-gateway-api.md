xx# Gateway API

## 1. Why — 왜 쓰는가

Kubernetes의 기존 `Ingress` 리소스를 대체하는 차세대 트래픽 진입 표준이다. **2023-11에 v1.0이 GA**(General Availability)되었고, 2024년부터 모든 주요 service mesh와 ingress controller가 표준 구현체로 채택했다. 본 프로젝트가 `Ingress` 대신 Gateway API를 선택한 사유는 다음과 같다.

**Ingress의 한계**: Ingress는 HTTP/HTTPS만 표준 지원하고 TCP/UDP, mTLS, header 기반 라우팅 같은 고급 기능은 각 controller 벤더의 annotation(`nginx.ingress.kubernetes.io/*`)에 의존한다. 결과적으로 nginx-ingress 매니페스트를 traefik으로 옮길 때 거의 다시 짜야 한다. 또 단일 `Ingress` 리소스가 routing + TLS + LB 설정을 모두 가지므로 RBAC 분리가 안 된다.

**Gateway API의 해결**: 표준 명세로 헤더/메서드/쿼리 기반 라우팅, traffic splitting(canary), TCP/UDP/TLS route, 외부 서비스 reference 등을 정의한다. 리소스를 역할별로 분리: `GatewayClass`(인프라 관리자), `Gateway`(클러스터 관리자), `HTTPRoute`/`TCPRoute`(앱 개발자). 결과적으로 RBAC(Role-Based Access Control)가 자연스럽게 분리되고 controller 교체가 매니페스트 변경 거의 없이 가능하다.

## 2. Architecture — 어떻게 구성되는가

3-tier 리소스 구조가 핵심이다.

```
GatewayClass (cluster-scoped)
   └─> Gateway (namespace-scoped)
          └─> HTTPRoute / TCPRoute / TLSRoute (namespace-scoped)
```

`GatewayClass`는 어떤 구현체가 이 클래스를 처리할지 정의한다(예: `istio`, `envoy-gateway`, `kong`). `Gateway`는 실제 listener 정의(어느 포트, 어느 프로토콜, 어느 호스트). `HTTPRoute`는 들어온 트래픽을 어느 백엔드 서비스로 라우팅할지 정의한다. 한 `Gateway`에 여러 `HTTPRoute`를 attach 가능하고, 한 `HTTPRoute`가 여러 `Gateway`에 동시 attach도 가능하다(cross-namespace 사용 시 `ReferenceGrant` 필수).

본 프로젝트에서는 Istio가 `GatewayClass`의 controller 역할을 한다. 즉 Gateway API는 표준 명세고, Istio는 그 구현체.

## 3. Mechanism — 어떻게 돌아가는가

1. 사용자가 `Gateway` 리소스를 생성하면 controller(Istio)가 이를 watch
2. Controller가 `GatewayClass`의 `controllerName`을 보고 자신의 책임인지 확인
3. 자신의 책임이면 실제 데이터플레인(Istio의 경우 envoy ingress gateway pod)을 배포 또는 설정
4. OCI LB Service가 자동 생성되고 외부 IP 할당
5. `HTTPRoute`가 생성되면 controller가 envoy에 라우팅 룰 push
6. 외부 요청 → OCI LB → envoy gateway pod → HTTPRoute 룰 매칭 → 백엔드 서비스 → pod

핵심은 **데이터플레인(envoy)과 컨트롤플레인(Istio istiod)이 분리**되어 있다는 점. Gateway API 리소스가 변경되면 컨트롤플레인이 envoy에 xDS 프로토콜로 설정을 push.

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Gateway API 의존 관계는 다음과 같다.

- **Istio가 controller로 동작** — Phase 2에서 Istio 설치 시 `istio` GatewayClass가 자동 생성됨
- **cert-manager가 TLS 인증서 발급** — `Gateway`의 `tls.certificateRefs`로 Secret 참조, cert-manager가 자동으로 해당 Secret을 채움
- **external-dns가 DNS 레코드 생성** — `Gateway` 또는 `HTTPRoute`의 hostname을 보고 Cloudflare에 A 레코드 자동 생성
- **OCI LB가 외부 진입점** — `Gateway` 리소스의 listener는 LoadBalancer 타입 Service로 노출, OCI cloud-controller-manager가 LB 자동 프로비저닝

설치 순서 의존성: **Gateway API CRD → Istio → cert-manager + external-dns → Gateway 리소스 생성**. CRD가 먼저 없으면 Istio가 자기 컨트롤러를 등록 못 함.

## 5. Usage — 어떻게 쓰는가

CRD 설치 (반드시 Istio보다 먼저).

```bash
kubectl apply -k github.com/kubernetes-sigs/gateway-api/config/crd/standard?ref=v1.2.0
```

`Gateway` 정의 예시.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: app-gateway
  namespace: istio-system
spec:
  gatewayClassName: istio
  listeners:
  - name: https
    port: 443
    protocol: HTTPS
    hostname: "*.ggang.cloud"
    tls:
      mode: Terminate
      certificateRefs:
      - name: ggang-cloud-tls   # cert-manager가 채움
    allowedRoutes:
      namespaces:
        from: Selector
        selector:
          matchLabels:
            shared-gateway-access: "true"
```

`HTTPRoute` 정의 예시.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: login-route
  namespace: app
spec:
  parentRefs:
  - name: app-gateway
    namespace: istio-system
  hostnames:
  - login.ggang.cloud
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /api
    backendRefs:
    - name: login-service
      port: 8080
```

Cross-namespace reference는 `ReferenceGrant` 필요. 예를 들어 `app` namespace의 `HTTPRoute`가 `istio-system`의 `Gateway`에 attach하려면 `istio-system` 측에 `ReferenceGrant` 생성해야 한다.

## 6. Configuration — 어떤 설정이 있는가

**Gateway listener 옵션**:
- `port`, `protocol` (HTTP/HTTPS/TLS/TCP/UDP)
- `hostname` (와일드카드 가능, 예: `*.ggang.cloud`)
- `tls.mode`: `Terminate`(LB에서 TLS 종료) vs `Passthrough`(TCP로 통과)
- `tls.certificateRefs`: 인증서 Secret 참조
- `allowedRoutes.namespaces.from`: `All` / `Same` / `Selector`

**HTTPRoute 매칭 옵션**:
- `path.type`: `Exact` / `PathPrefix` / `RegularExpression`
- `headers`, `queryParams`, `method` 기반 매칭
- `backendRefs`에 weight 부여 → canary 배포 가능
- `filters`: RequestHeaderModifier, RequestMirror, URLRewrite, RequestRedirect

**Traffic splitting (canary)**:
```yaml
backendRefs:
- name: app-v1
  port: 8080
  weight: 90
- name: app-v2
  port: 8080
  weight: 10
```

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.25 이상** (CRD가 v1로 promote된 시점)
- **Istio 1.20+** (Gateway API v1 GA 지원). 2026-05 기준 Istio 1.24+ 권장
- **cert-manager 1.15+** — Gateway API 통합 default 활성화 (그 이전 버전은 feature gate 필요)
- **external-dns v0.14+** — Gateway API source 활성화 옵션 (`--source=gateway-httproute`)
- **CRD 버전 호환**: 표준 채널(`standard`)과 실험 채널(`experimental`)이 있음. `standard`만 사용. ListenerSet 등 일부 기능은 v1.5(2026)부터 stable

## 8. 면접 예상 질문 & 답변

**Q1. 왜 Ingress가 아니라 Gateway API를 골랐어요?**
> Ingress는 HTTP/HTTPS만 표준 지원하고 고급 기능은 controller 벤더의 annotation에 의존해서 nginx에서 traefik으로 옮길 때 매니페스트를 거의 다시 짜야 합니다. Gateway API는 표준 명세에 header/method 기반 라우팅, traffic splitting, mTLS 등을 다 포함하고 있어서 controller 교체가 자유롭고, GatewayClass / Gateway / HTTPRoute로 역할이 분리되어 있어서 인프라 관리자와 앱 개발자 권한도 자연스럽게 나눠집니다. 2023-11에 v1 GA되면서 2024년부터 사실상 표준이라 미래 호환성도 더 좋습니다.

**Q2. Gateway API와 Istio VirtualService 둘 다 쓰면 안 되나요?**
> 가능하지만 권장하지 않습니다. 본 프로젝트는 트래픽 분리 원칙을 명시적으로 두고 있어서, 남북 트래픽(외부 진입)은 Gateway API의 `HTTPRoute`만 쓰고 동서 트래픽(내부 정책)은 Istio CR(`PeerAuthentication`, `AuthorizationPolicy`)만 씁니다. VirtualService를 같이 쓰면 라우팅 룰이 두 군데로 흩어져서 디버깅이 어려워지고, Istio 측에서도 향후 Gateway API로 통합한다는 로드맵이 있어서 VirtualService는 legacy 영역으로 보고 있습니다.

**Q3. GatewayClass, Gateway, HTTPRoute 셋의 책임 차이는요?**
> `GatewayClass`는 클러스터 전체에 하나만 있는 인프라 정의로, 어느 controller가 이 클래스를 처리할지를 정합니다(예: Istio). `Gateway`는 실제 listener — 어느 포트에서 어느 프로토콜로 받을지, TLS 인증서가 무엇인지 — 를 정하는 클러스터 관리자 책임 리소스고, `HTTPRoute`는 들어온 트래픽을 어느 서비스로 보낼지 정하는 앱 개발자 책임 리소스입니다. 이 분리 덕분에 앱 팀이 자기 namespace의 `HTTPRoute`만 만들면 되고 `Gateway`를 만질 권한은 없게 RBAC을 짤 수 있습니다.

**Q4. cross-namespace로 HTTPRoute를 attach하려면 어떻게 해야 하나요?**
> `Gateway`가 있는 namespace에 `ReferenceGrant`를 만들어서 자신을 참조해도 되는 namespace 또는 리소스를 명시해야 합니다. 보안상 default-deny 모델이라 명시적 허용이 없으면 차단됩니다. 예를 들어 `istio-system`의 `Gateway`에 `app` namespace의 `HTTPRoute`를 attach하려면, `istio-system` 측에 `from.namespace: app`을 허용하는 `ReferenceGrant`를 만들어야 합니다.

**Q5. Canary 배포는 어떻게 구현하나요?**
> `HTTPRoute`의 `backendRefs`에 weight를 부여하면 됩니다. 예를 들어 v1에 weight 90, v2에 weight 10을 주면 envoy가 트래픽을 9:1로 분배합니다. 점진적으로 v2 weight를 올리고 v1을 내리는 식으로 progressive delivery를 구현하고, Argo Rollouts 같은 도구와 연동하면 메트릭 기반 자동 promotion까지 가능합니다.

**Q6. TLS Terminate와 Passthrough 차이는요?**
> Terminate는 Gateway에서 TLS를 종료하고 내부로는 평문 HTTP로 전달하는 방식이고, Passthrough는 TLS를 풀지 않고 TCP 그대로 백엔드까지 전달하는 방식입니다. Terminate는 L7 라우팅과 인증서 중앙 관리가 가능한 대신 내부 통신이 평문(본 프로젝트는 Istio mTLS가 다시 감쌈)이고, Passthrough는 백엔드가 자체 TLS를 관리해야 하지만 진짜 종단간 암호화가 됩니다. 본 프로젝트는 Terminate + Istio mTLS 조합으로 갑니다.

**Q7. 라우팅 룰 우선순위는 어떻게 결정되나요?**
> Gateway API 명세는 매칭 정확도가 높은 룰을 우선합니다: (1) 정확한 hostname 매칭 우선(`*.ggang.cloud`보다 `login.ggang.cloud`), (2) PathPrefix는 더 긴 path 우선, (3) header/query/method 매칭은 더 많이 매칭되는 룰 우선. 같은 정확도면 생성 시각이 빠른 룰 우선. 명확한 우선순위 규칙 덕분에 룰 충돌 디버깅이 Ingress보다 훨씬 쉽습니다.

**Q8. Gateway API CRD를 Istio Helm chart의 bundled 옵션으로 설치하지 않고 별도 설치한 이유는?**
> CRD 관리 책임을 분리하기 위해서입니다. Istio가 CRD를 같이 관리하면 Istio를 업그레이드/제거할 때 CRD도 영향을 받고, 다른 controller(예: 추후 envoy-gateway로 전환)로 마이그레이션할 때도 CRD가 같이 사라져서 cert-manager나 external-dns가 영향받습니다. CRD는 Kubernetes API의 일부라는 관점으로 별도 lifecycle로 관리하면 controller 교체가 자유로워집니다.
