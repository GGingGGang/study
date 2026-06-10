# NetworkPolicy

## 1. Why — 왜 쓰는가

Kubernetes 표준 L3/L4 네트워크 정책 리소스. Pod 간 트래픽을 IP/포트 수준에서 제어.

**기본 k8s의 문제**:
- 모든 Pod이 모든 다른 Pod에 통신 가능 (default-allow)
- compromised pod이 클러스터 전체 스캔 + 다른 service 호출 가능
- 컴플라이언스(PCI-DSS, SOC2 등) 네트워크 분리 요구사항 미충족

**NetworkPolicy의 해결**:
- Pod selector 기반으로 ingress/egress 트래픽 제어
- "app 라벨이 X인 pod만 db 라벨이 Y인 pod에 5432 포트로 접근 가능" 같은 정책
- Default-deny 패턴으로 명시적 허용만 통신 가능

**Istio AuthorizationPolicy vs NetworkPolicy**:
- AuthorizationPolicy: L7 (HTTP method, path, JWT claim)
- NetworkPolicy: L3/L4 (IP, port)
- 보완 관계 — 본 프로젝트는 둘 다 적용 (defense in depth)
- L4 차단이 더 가볍고 빨라서 외부 공격자 차단에 유리

**CNI 의존성 (중요)**:
- NetworkPolicy 자체는 표준이지만 시행은 CNI 책임
- Flannel: 미지원 → NetworkPolicy 매니페스트가 무시됨
- Calico, Cilium, Weave: 지원
- 본 프로젝트는 **Cilium chaining mode**로 Flannel 위에 시행 레이어 추가

## 2. Architecture — 어떻게 구성되는가

**NetworkPolicy 구조**:
- **podSelector**: 정책을 적용할 대상 pod (label 기반)
- **policyTypes**: Ingress, Egress, 또는 둘 다
- **ingress**: 들어오는 트래픽 허용 룰
- **egress**: 나가는 트래픽 허용 룰

**Source/destination 종류**:
- **podSelector**: label로 매칭되는 같은 NS pod
- **namespaceSelector**: label로 매칭되는 namespace의 모든 pod
- **ipBlock**: IP CIDR (외부 IP, 또는 명시적 ranges)
- 위 세 가지 조합 가능 (AND 또는 OR)

**기본 동작**:
- NetworkPolicy 없는 pod: default-allow (모든 통신 허용)
- NetworkPolicy 매칭되는 pod: 명시된 ingress/egress만 허용 (나머지 deny)
- 여러 정책 매칭 시: union (OR)

## 3. Mechanism — 어떻게 돌아가는가

**Cilium chaining에서 NetworkPolicy 시행**:
1. 사용자가 NetworkPolicy CR 생성
2. cilium-agent가 watch → eBPF map에 룰 컴파일
3. Pod 트래픽 발생 시 eBPF 프로그램이 ingress/egress map 조회
4. 허용 매칭 있으면 통과, 없으면 drop
5. Hubble flow에 verdict 기록 (`ALLOWED` 또는 `DROPPED`)

**Default-deny 적용 방법**:

```yaml
# 모든 ingress 거부
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: app
spec:
  podSelector: {}              # 모든 pod 매칭
  policyTypes:
  - Ingress                    # ingress만 명시 → ingress 룰 없음 → 모두 거부
```

**Egress 정책의 함정**:
- Egress default-deny 시 **CoreDNS 접근도 차단** → DNS 조회 안 됨 → 모든 service discovery 실패
- 반드시 CoreDNS 허용 룰을 먼저 추가

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 NetworkPolicy 의존 관계.

- **Cilium chaining** (Phase 6 선행) — NetworkPolicy 시행 엔진
- **CoreDNS** — Egress 정책 시 명시적 허용 필수
- **Prometheus** (monitoring NS) — app NS의 /metrics scrape에 namespaceSelector 허용 필요
- **Vault Agent Injector** (vault NS) — app pod의 init container가 vault 호출 → 허용
- **ArgoCD** (cicd NS) — app NS에 배포 시 k8s API 호출 → 허용
- **Kafka (kafka NS)** — app NS가 broker 호출 → 허용
- **Istio mTLS** — L4 차단이 mTLS 핸드셰이크 전에 일어남, 정책 위반 시 connection 자체 안 됨

**Sequencing의 중요성**:
- default-deny를 먼저 적용하면 모든 통신 즉시 차단
- 반드시 **명시적 allow 정책 먼저 작성 → audit mode 검증 → enforce**

## 5. Usage — 어떻게 쓰는가

**Step 0: Cilium policy audit mode 활성화** (NetworkPolicy 사고 방지):

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system --reuse-values \
  --set policyEnforcementMode=default
# audit이면 정책 평가하지만 차단 안 함, Hubble에만 verdict 기록
```

**Step 1: 명시적 allow 정책 작성** (default-deny 적용 전):

```yaml
# 1. DNS 허용 (가장 먼저, 항상 필요)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-dns
  namespace: app
spec:
  podSelector: {}
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: kube-system
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
```

```yaml
# 2. Prometheus scrape 허용
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-prometheus-scrape
  namespace: app
spec:
  podSelector:
    matchLabels:
      app: login    # 또는 모든 pod (podSelector: {})
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: monitoring
      podSelector:
        matchLabels:
          app.kubernetes.io/name: prometheus
    ports:
    - port: 9090
      protocol: TCP
```

```yaml
# 3. Istio ingress gateway → login 허용
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-gateway-to-login
  namespace: app
spec:
  podSelector:
    matchLabels:
      app: login
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: istio-system
      podSelector:
        matchLabels:
          app: istio-ingressgateway
    ports:
    - port: 8080
      protocol: TCP
```

```yaml
# 4. Login → MySQL (HeatWave는 외부, ipBlock 사용)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-login-to-mysql
  namespace: app
spec:
  podSelector:
    matchLabels:
      app: login
  policyTypes:
  - Egress
  egress:
  - to:
    - ipBlock:
        cidr: 10.0.201.0/28      # subnet-db CIDR
    ports:
    - port: 3306
      protocol: TCP
```

```yaml
# 5. Login → Vault (vault NS)
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-login-to-vault
  namespace: app
spec:
  podSelector:
    matchLabels:
      app: login
  policyTypes:
  - Egress
  egress:
  - to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: vault
      podSelector:
        matchLabels:
          app.kubernetes.io/name: vault
    ports:
    - port: 8200
      protocol: TCP
```

**Step 2: Audit mode로 검증**:

```bash
# 며칠간 audit mode로 운영하면서 차단될 트래픽 발견
cilium hubble observe --verdict DROPPED --namespace app

# 의도된 트래픽이 dropped면 allow 정책 추가
```

**Step 3: Default-deny enforce**:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: app
spec:
  podSelector: {}
  policyTypes:
  - Ingress
  - Egress
```

```bash
helm upgrade cilium cilium/cilium \
  --namespace kube-system --reuse-values \
  --set policyEnforcementMode=always
```

**검증 명령**:

```bash
# 현재 적용된 정책
kubectl get networkpolicy -n app

# 특정 pod에 적용되는 정책
kubectl describe networkpolicy -n app

# Hubble로 거부된 flow 확인
cilium hubble observe --verdict DROPPED

# Cilium endpoint identity 확인
kubectl exec -it -n kube-system cilium-xxx -- cilium endpoint list
```

## 6. Configuration — 어떤 설정이 있는가

**podSelector 패턴**:
- `{}` (빈 selector): namespace의 모든 pod
- `matchLabels: {app: login}`: 특정 label
- `matchExpressions`: 더 복잡한 selector (IN, NOT IN 등)

**ingress/egress 룰 구조**:
- `from` / `to`: source/destination 명시
- `ports`: 포트 + protocol
- `from` 안에 여러 항목: OR (어느 하나라도 매칭)
- 여러 ingress 룰: OR (어느 룰이라도 매칭)

**ipBlock 옵션**:
- `cidr`: 허용 CIDR
- `except`: 제외할 CIDR (cidr 안에서)
- 예: `cidr: 0.0.0.0/0, except: [10.0.0.0/8]` → 외부만 허용, 내부 차단

**Cilium 추가 기능** (CiliumNetworkPolicy 사용 시):
- L7 정책 (HTTP method/path)
- DNS 기반 정책 (`toFQDNs`)
- Service identity 기반 (Cilium identity)
- 본 프로젝트는 표준 NetworkPolicy만 사용 (k8s 표준성 우선)

**Namespace label 자동 추가**:
- k8s 1.21+ 부터 모든 namespace에 `kubernetes.io/metadata.name: <ns-name>` label 자동
- namespaceSelector에 이 label 활용 가능 (별도 label 추가 불필요)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **CNI**: Cilium, Calico, Weave 등 NetworkPolicy 지원 CNI
- **Flannel 단독**: 시행 안 됨 → Cilium chaining 필수
- **NetworkPolicy API**: `networking.k8s.io/v1` (stable since 1.7)
- **policyTypes**: Egress는 k8s 1.8+, 표준화됨
- **CiliumNetworkPolicy**: Cilium 1.x+ 필요 (확장 기능)

## 8. 면접 예상 질문 & 답변

**Q1. NetworkPolicy가 왜 필요해요? Istio AuthorizationPolicy로 충분하지 않나요?**
> 보완 관계입니다. NetworkPolicy는 L3/L4(IP, port) 차단, Istio AuthorizationPolicy는 L7(HTTP method, JWT) 차단입니다. 외부 공격자가 컨테이너 escape 또는 compromised pod에서 다른 service를 스캔하려고 할 때, L4 차단이 더 가볍고 빠르게 막습니다. 또 Istio mesh 가입 안 된 pod(예: Strimzi Kafka NS)은 AuthorizationPolicy 적용 안 되지만 NetworkPolicy는 모든 pod에 적용됩니다. 본 프로젝트는 두 레이어를 같이 둬서 defense in depth 패턴을 구축합니다.

**Q2. Default-deny 적용할 때 가장 흔한 사고는?**
> **DNS 차단**입니다. Egress default-deny 적용하면 CoreDNS(`kube-dns.kube-system`) 접근도 막혀서 service discovery 자체가 안 됩니다. 모든 service-to-service 호출이 "no such host" 에러로 실패. 본 프로젝트는 가장 먼저 `allow-dns` 정책을 작성해서 CoreDNS UDP/TCP 53 허용을 보장하고, 그 다음 default-deny를 적용합니다. 두 번째 흔한 사고는 Prometheus scrape 차단 — monitoring NS → app NS ingress 허용 정책 누락.

**Q3. Cilium audit mode가 뭐고 왜 써요?**
> Cilium의 `policyEnforcementMode: default` 옵션입니다. NetworkPolicy를 평가하지만 차단은 안 하고 Hubble에 verdict만 기록합니다. 본 프로젝트의 NetworkPolicy 적용 sequencing은 (1) 명시적 allow 정책 모두 작성, (2) audit mode로 며칠 운영하면서 Hubble에서 `DROPPED` verdict 추적, (3) 의도된 트래픽이 dropped면 allow 정책 추가, (4) 모든 정상 트래픽 통과 확인 후 enforce mode로 전환. 이 순서를 안 지키고 바로 enforce하면 서비스 중단 사고가 거의 확실합니다.

**Q4. NetworkPolicy 시행이 안 돼요. 왜요?**
> 가장 흔한 원인은 **CNI가 NetworkPolicy 미지원**입니다. Flannel은 NetworkPolicy 매니페스트를 받지만 시행 안 합니다. `kubectl describe networkpolicy`는 정상으로 보이지만 실제로 차단 안 됨. 본 프로젝트는 Cilium chaining을 Flannel 위에 얹어서 시행 레이어를 추가합니다. 확인 방법: `cilium status`로 cilium-agent 동작 + `kubectl get cep` (CiliumEndpoint) 출력 확인. 또 다른 원인은 namespaceSelector의 label 오타.

**Q5. egress 정책에서 외부 service(예: HeatWave MySQL)는 어떻게 허용해요?**
> ipBlock으로 명시합니다. HeatWave는 같은 VCN 내 private subnet의 다른 IP라 namespaceSelector로 매칭 불가. `to.ipBlock.cidr: 10.0.201.0/28`처럼 subnet CIDR을 명시합니다. 외부 인터넷 API 호출이 필요하면 `cidr: 0.0.0.0/0`에 `except`로 internal 제외하는 패턴 — 단 너무 광범위해서 보안 약함. 본 프로젝트는 외부 API 호출 거의 없으므로 외부 egress는 최소화하고 필요 시 명시적 CIDR.

**Q6. NetworkPolicy 매칭 안 되는 pod은 default-allow인데 왜 default-deny가 됐어요?**
> NetworkPolicy의 동작은 두 가지를 합칩니다. (1) podSelector에 매칭되는 pod의 ingress/egress는 명시된 룰만 허용. (2) 매칭 안 되는 pod은 기본 정책 따름(default-allow). default-deny를 만들려면 `podSelector: {}`(빈 selector = 모든 pod 매칭) + `policyTypes: [Ingress, Egress]` + ingress/egress 룰 비워두기. 이 매니페스트가 모든 pod에 매칭되어 모든 ingress/egress 거부. 이렇게 명시적으로 적용된 default-deny + 다른 정책의 allow union이 최종 룰.

**Q7. NetworkPolicy와 Cilium NetworkPolicy(CNP) 어느 걸 써요?**
> 본 프로젝트는 표준 NetworkPolicy만 씁니다. CNP는 (1) L7 HTTP method/path 정책, (2) DNS FQDN 기반 정책 (`toFQDNs: api.github.com`), (3) Cilium identity 기반 정책 등 추가 기능을 제공합니다. 본 프로젝트는 (1) L7은 이미 Istio AuthorizationPolicy로 처리, (2) DNS FQDN은 매력적이지만 표준 외, (3) k8s 표준성 우선이라 마이그레이션 용이성 — 이런 이유로 표준 NetworkPolicy만 사용. 면접에서 "CNP의 toFQDNs 같은 기능이 강력하지만 표준성 trade-off로 후순위"라 답합니다.

**Q8. NetworkPolicy 테스트는 어떻게 해요?**
> 세 가지 방법. (1) Hubble flow observation — `cilium hubble observe --verdict DROPPED`로 거부된 packet 실시간 확인, (2) 임시 pod로 connectivity test — `kubectl run debug --rm -it --image=nicolaka/netshoot -- curl <target>`, (3) `cilium connectivity test` — 자동 e2e test. 본 프로젝트는 enforce 전에 audit mode + Hubble로 며칠 검증하는 게 가장 신뢰성 있습니다. 임시 pod 테스트는 NetworkPolicy 시행 후 정상 동작 확인용.

**Q9. Multi-namespace 통신에서 namespaceSelector 어떻게 써요?**
> 두 가지 패턴. (1) 매니페스트에서 `kubernetes.io/metadata.name: <ns-name>` label 사용 (k8s 1.21+ 자동 추가) — 별도 label 안 줘도 됨. 본 프로젝트 권장. (2) namespace에 명시적 label 추가 (`kubectl label namespace monitoring purpose=monitoring`) 후 selector에서 사용 — 추가 단계 필요. 본 프로젝트의 모든 NetworkPolicy는 (1) 패턴으로 통일.

**Q10. NetworkPolicy 너무 많아져서 관리 어려운데 어떻게 해요?**
> 본 프로젝트는 세 가지 원칙으로 정리합니다. (1) namespace당 `default-deny` 1개 + `allow-dns` 1개 (모든 NS 공통). (2) service별 ingress 정책 1개 (해당 service에 들어올 수 있는 source 명시). (3) service별 egress 정책 1개 (해당 service가 호출할 수 있는 destination 명시). 결과적으로 service N개면 정책 ~2N+2개로 관리 가능 수준. ArgoCD ApplicationSet으로 service template에서 NetworkPolicy도 자동 생성하면 누락 없습니다.
