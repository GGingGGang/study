# Istio (Ambient Mode)

## 1. Why — 왜 쓰는가

Service mesh는 마이크로서비스 간 통신을 인프라 레이어에서 추상화하는 도구다. 본 프로젝트가 Istio를 채택한 사유:

**Service mesh가 필요한 이유**: MSA 환경에서 mTLS 암호화, 트래픽 라우팅, 재시도/타임아웃, 관측성(트레이스/메트릭/로그), 인증/인가를 **앱 코드에 박지 않고** 인프라가 자동 처리하게 하는 것. 앱이 늘어날수록 이 cross-cutting concern을 라이브러리로 관리하는 비용이 폭증하므로 service mesh로 빼는 게 표준.

**왜 Istio인가 (대체재 비교)**:
- **Linkerd**: 더 가볍고 단순하나 기능이 적음(예: traffic mirroring 제한, multi-cluster 약함). CNCF graduated.
- **Consul Connect**: HashiCorp 종속, BSL 라이선스 영향
- **AWS App Mesh**: AWS 종속, OCI에서 사용 불가
- **Istio**: 가장 광범위한 기능 + Gateway API 가장 빠른 채택 + 2024-11 Ambient mode GA로 자원 효율 개선. 토스 스택 정합

**왜 Ambient mode인가**:
- Sidecar mode: 모든 앱 pod에 envoy sidecar 주입 → 파드당 40-50MB RAM × 앱 파드 10개 = 400-500MB
- Ambient mode: 노드당 ztunnel 1개 + 필요 시 waypoint → 노드 2개 = ~160MB 베이스. 70%+ RAM 절감
- Always Free 24GB RAM 환경에 정합

## 2. Architecture — 어떻게 구성되는가

**컨트롤플레인**:
- `istiod`: 핵심 컨트롤러. xDS 프로토콜로 데이터플레인에 설정 push. mTLS 인증서 발급(SPIFFE/SPIRE 기반). 정책 평가.

**데이터플레인 (Ambient mode)**:
- `ztunnel` (Zero Trust Tunnel): 노드당 1개 DaemonSet. L4 mTLS 처리, HBONE 프로토콜로 노드 간 암호화 터널 생성. eBPF/iptables로 pod 트래픽을 redirect.
- `waypoint proxy`: 선택적. L7 정책(AuthorizationPolicy 등)이 필요한 namespace/service에만 배포. 일반 envoy 프록시.

**Gateway**:
- `istio-ingressgateway`: 외부 진입점. Gateway API의 `Gateway` 리소스에 의해 자동 배포. envoy 기반.

**비교 (Sidecar mode와 차이)**:
- Sidecar mode: 앱 pod 안에 envoy sidecar 컨테이너 주입. L4/L7 모두 sidecar가 처리.
- Ambient mode: L4는 ztunnel(전 노드), L7은 waypoint(필요한 곳만). 책임 분리로 자원 절감.

## 3. Mechanism — 어떻게 돌아가는가

**Ambient mode 트래픽 흐름**:

1. App pod A가 service B에 요청 전송
2. ztunnel(A의 노드)이 트래픽을 가로채서 SPIFFE 기반 mTLS로 암호화
3. HBONE 터널로 B의 노드에 전달
4. ztunnel(B의 노드)이 복호화, B에 평문으로 전달
5. L7 정책이 필요하면 → waypoint를 거쳐 평가 후 B로 전달

**핵심 메커니즘**:
- **iptables redirect**: ztunnel이 노드의 iptables 룰을 조작해서 pod outbound 트래픽을 자신을 거치도록 함
- **HBONE (HTTP/2-based Overlay Network Environment)**: 노드 간 mTLS 터널 프로토콜. HTTP/2 CONNECT 메서드 사용
- **SPIFFE Identity**: 각 service account에 `spiffe://cluster.local/ns/<ns>/sa/<sa>` 형식 ID 부여. mTLS 인증서의 SAN에 포함

**Gateway 트래픽**:
- 외부 요청 → OCI Network LB (L4 TCP passthrough) → istio-ingressgateway pod의 envoy (TLS 종료) → HTTPRoute 매칭 → 백엔드 service의 ztunnel → 백엔드 pod
- **NLB 선택 사유**: envoy가 TLS 종료 + L7 라우팅을 단독 책임하므로 LB는 단순 TCP 진입점이면 충분. L7 LB(Flexible LB) 앞단 시 라우팅 책임 중복 + 인증서 두 군데 관리 + TLS 재암호화 발생.

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Istio 의존 관계.

- **Gateway API CRD** — Istio 설치 전 선행. Istio가 GatewayClass `istio` 자동 등록
- **cert-manager** — Gateway listener의 TLS 인증서를 cert-manager가 발급, Istio가 envoy에 로드
- **external-dns** — Gateway hostname을 보고 DNS 자동 등록
- **kube-prometheus-stack** — istiod, ztunnel, gateway 메트릭을 ServiceMonitor로 수집
- **Tempo** — Istio 자동 trace span 생성, OTLP로 Tempo로 전송
- **Kiali** — Prometheus 메트릭 기반 트래픽 토폴로지 시각화
- **Vault** — Phase 6에서 Istio CA를 Vault PKI engine으로 교체 가능(고급 옵션, 본 프로젝트는 Istio 내장 CA 사용)

**Strimzi Kafka와의 충돌**: Kafka 자체 SSL/SASL 프로토콜이 있어 Istio mTLS가 가로채면 이중 암호화. Strimzi NS에는 ztunnel 주입 제외 필수(Phase 6).

## 5. Usage — 어떻게 쓰는가

**설치 (Helm, Ambient profile)**:

```bash
# 1. Gateway API CRD (선행)
kubectl apply -k github.com/kubernetes-sigs/gateway-api/config/crd/standard?ref=v1.2.0

# 2. Istio base CRD
helm install istio-base istio/base -n istio-system --create-namespace

# 3. istiod (control plane)
helm install istiod istio/istiod -n istio-system \
  --set profile=ambient

# 4. CNI plugin (ztunnel redirect 위해)
helm install istio-cni istio/cni -n istio-system \
  --set profile=ambient

# 5. ztunnel
helm install ztunnel istio/ztunnel -n istio-system

# 6. ingress gateway (Gateway API로 자동 생성됨, 또는 명시적)
helm install istio-ingress istio/gateway -n istio-system
```

**namespace를 ambient mesh에 가입시키기**:

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: app
  labels:
    istio.io/dataplane-mode: ambient
```

**L7 정책 필요 시 waypoint 배포**:

```bash
kubectl label namespace app istio.io/use-waypoint=app-waypoint
istioctl waypoint apply --namespace app --name app-waypoint
```

**검증**:

```bash
istioctl analyze              # 구성 정합성
istioctl proxy-status         # ztunnel/sidecar 상태
istioctl ztunnel-config service --workload-namespace app
```

## 6. Configuration — 어떤 설정이 있는가

**Mesh 전체 설정 (`IstioOperator` 또는 Helm values)**:
- `meshConfig.defaultConfig.holdApplicationUntilProxyStarts`: 앱이 ztunnel 준비 전 시작 방지
- `meshConfig.outboundTrafficPolicy.mode`: `ALLOW_ANY`(default) vs `REGISTRY_ONLY`(명시된 서비스만 외부 호출 허용)
- `meshConfig.accessLogFile`: envoy access log 위치

**PeerAuthentication (mTLS 정책)**:
```yaml
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: app
spec:
  mtls:
    mode: STRICT    # PERMISSIVE / STRICT / DISABLE
```

**AuthorizationPolicy (L7 ACL, waypoint 필요)**:
```yaml
apiVersion: security.istio.io/v1
kind: AuthorizationPolicy
metadata:
  name: login-only-from-gateway
  namespace: app
spec:
  selector:
    matchLabels:
      app: login
  rules:
  - from:
    - source:
        principals: ["cluster.local/ns/istio-system/sa/istio-ingressgateway"]
```

**Resource limits (istiod, ztunnel)**:
- istiod: 보통 200-500MB RAM (클러스터 크기에 비례)
- ztunnel: 노드당 40-80MB RAM (DaemonSet)
- waypoint: 100-200MB RAM (배포한 곳만)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+** (Ambient mode GA 기준)
- **Istio 1.24+** (Ambient stable 채널). 2026-05 기준 1.24 또는 1.25 권장
- **CNI 호환성**: Ambient는 자체 CNI plugin 사용 → 기존 CNI와 chaining 필요. OKE Flannel + Istio CNI chaining은 검증됨. **Cilium chaining mode와의 공존은 별도 검증 필수**(Phase 6).
- **Gateway API**: v1 (1.0) GA 채널만 사용. experimental 채널은 비권장.
- **Strimzi 비호환**: Strimzi NS는 ztunnel 주입 제외 필수
- **Helm 3.x** 필수
- **kernel 4.19+** (ztunnel의 iptables redirect 요구사항). OKE Oracle Linux 8 기본 만족

## 8. 면접 예상 질문 & 답변

**Q1. Service mesh가 왜 필요해요?**
> MSA 환경에서 서비스 간 통신을 안전하고 관측 가능하게 만들려면 mTLS, 재시도, 타임아웃, 트레이스, 인증/인가 같은 cross-cutting concern을 처리해야 하는데, 이걸 모든 앱 코드에 라이브러리로 박으면 언어/프레임워크별로 구현이 흩어지고 업그레이드가 지옥이 됩니다. Service mesh는 이걸 인프라 레이어로 빼서 envoy 같은 사이드카가 자동 처리하게 만드는 패턴이고, 결과적으로 앱 코드는 비즈니스 로직에만 집중하고 SRE는 정책을 중앙에서 관리할 수 있게 됩니다.

**Q2. Sidecar mode 대신 Ambient mode 고른 이유는?**
> 자원 효율 때문입니다. Sidecar는 모든 앱 pod에 envoy를 주입해서 파드당 40-50MB가 추가로 잡히는데, Always Free 24GB RAM 환경에서 앱 파드 10개면 500MB가 envoy로만 증발합니다. Ambient는 노드당 ztunnel 1개로 L4를 처리하고 L7 정책이 필요한 곳만 waypoint를 추가 배포하는 구조라, 본 환경 2노드 기준 ~160MB로 거의 70% 절감됩니다. 2024-11에 GA됐고 토스급 환경에서도 production 채택 사례가 생기고 있어서 trend 측면에서도 유리합니다.

**Q3. ztunnel은 어떻게 동작하나요?**
> 노드당 1개씩 DaemonSet으로 떠있는 L4 프록시고, iptables 또는 eBPF로 pod outbound 트래픽을 자기 자신을 거치게 redirect합니다. 트래픽을 받으면 SPIFFE 기반 mTLS로 암호화하고 HBONE이라는 HTTP/2 CONNECT 기반 터널 프로토콜로 목적지 노드의 ztunnel에 전송합니다. 목적지 ztunnel이 복호화해서 대상 pod에 평문으로 전달합니다. L4만 처리하므로 envoy 풀스택 대비 매우 가볍습니다.

**Q4. Ambient에서 L7 정책은 어떻게 적용하나요?**
> waypoint proxy를 따로 배포해야 합니다. L7이 필요한 namespace나 service에 label로 waypoint를 지정하면, 해당 트래픽이 ztunnel을 거친 후 waypoint envoy를 통과합니다. waypoint는 일반 envoy라서 AuthorizationPolicy, traffic mirroring, 헤더 조작 같은 L7 기능이 다 동작합니다. 모든 곳에 waypoint를 배포하지 않고 필요한 곳에만 배포하는 게 핵심이라 자원 절감이 유지됩니다.

**Q5. PERMISSIVE에서 STRICT로 전환할 때 주의할 점은?**
> 전환 자체는 instant고, STRICT를 적용한 순간부터 sidecar/ztunnel이 평문 트래픽을 거부합니다. 그래서 모든 통신 주체가 mesh에 가입되어 있는지 먼저 확인해야 합니다. 본 프로젝트에서 가장 흔한 함정 두 가지가 있습니다. 첫째는 monitoring NS가 mesh에 안 들어가 있으면 Prometheus scrape이 STRICT NS에 못 닿아 메트릭이 끊깁니다. 둘째는 Strimzi Kafka입니다. Kafka는 자체 SSL을 쓰는데 ztunnel이 가로채면 이중 암호화 핸드셰이크가 깨져서 브로커-클라이언트 통신이 죽습니다. 그래서 mesh-wide STRICT 전 monitoring NS 가입과 Strimzi NS 제외를 먼저 해야 합니다.

**Q6. Istio가 발급하는 mTLS 인증서는 어떻게 관리되나요?**
> istiod가 내장 CA로 동작하면서 각 워크로드(pod)에 SPIFFE 기반 X.509 인증서를 자동 발급합니다. 인증서 SAN에는 `spiffe://cluster.local/ns/<namespace>/sa/<serviceaccount>` 형식의 ID가 들어가서 어느 서비스 어카운트인지 식별 가능합니다. 기본 만료는 24시간이고 만료 1시간 전 자동 갱신됩니다. 더 강력한 보안이 필요하면 istiod의 CA를 Vault PKI engine으로 교체해서 키 보관과 회전을 Vault에 위임할 수 있는데, 본 프로젝트는 단순성 우선으로 내장 CA를 사용합니다.

**Q7. AuthorizationPolicy와 NetworkPolicy 차이는요?**
> 레이어가 다릅니다. NetworkPolicy(또는 Cilium policy)는 L3/L4 IP/포트 기반 차단이고, AuthorizationPolicy는 L7 HTTP 메서드, 경로, 헤더, JWT claim 같은 것까지 평가합니다. 두 개는 보완 관계라 본 프로젝트는 둘 다 씁니다. 외부 공격자가 L4에서 막히면 Cilium NetworkPolicy, 인증된 사용자가 권한 없는 API 호출하면 Istio AuthorizationPolicy로 차단되는 구조입니다.

**Q8. istioctl 대신 Helm으로 설치한 이유는?**
> ArgoCD GitOps 환경 정합성 때문입니다. istioctl은 imperative 명령으로 설치/업그레이드를 수행하는데, 이러면 ArgoCD가 현재 상태를 source of truth로 추적할 수 없어서 drift가 발생합니다. Helm chart는 Git에 values를 두고 ArgoCD가 sync하면 끝이라 declarative하게 관리됩니다. istioctl은 데모나 디버깅용으로만 사용합니다.

**Q9. Istio Ambient를 OKE Basic Cluster의 Flannel CNI 위에서 돌릴 때 주의할 점은?**
> Ambient는 자체 Istio CNI plugin이 필요해서 기존 Flannel과 chaining mode로 동작해야 합니다. Flannel은 pod-to-pod 라우팅을 계속 담당하고, Istio CNI는 iptables redirect 룰만 추가하는 식입니다. 본 프로젝트는 추가로 Phase 6에서 Cilium chaining까지 얹는데, Flannel + Istio CNI + Cilium chaining 3중 구조가 정상 동작하는지 `istioctl proxy-status`와 `cilium status` 양쪽 모두로 검증하는 step을 박아뒀습니다.

**Q10. 트래픽 분리 원칙이 뭐고 왜 지키나요?**
> 남북 트래픽(외부→내부)은 Gateway API의 `HTTPRoute`로만, 동서 트래픽(내부→내부)은 Istio의 `PeerAuthentication`/`AuthorizationPolicy`로만 관리하는 원칙입니다. Istio의 구 `VirtualService`나 `Gateway`(Istio CR) 신규 작성은 금지합니다. 이유는 (1) Istio 로드맵상 Gateway API로 통합 중이라 VirtualService는 legacy가 되고 있고, (2) 라우팅 룰이 두 군데(HTTPRoute와 VirtualService)로 흩어지면 디버깅이 끔찍해지며, (3) 책임 분리(인프라 vs 정책)가 명확해져서 RBAC 설계가 쉬워집니다.
