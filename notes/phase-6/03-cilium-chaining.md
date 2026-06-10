# Cilium Chaining Mode + Hubble

## 1. Why — 왜 쓰는가

**Cilium**: eBPF 기반 CNI(Container Network Interface). NetworkPolicy 시행 + 관측 + L4/L7 load balancing 통합.
**Hubble**: Cilium 내장 관측 도구. 네트워크 흐름 시각화.

**OKE Basic Cluster의 한계**:
- **Flannel만 지원** (OCI VCN-Native CNI는 Enhanced Cluster 전용 = 유료)
- Flannel은 **NetworkPolicy 미지원** → Phase 6 NetworkPolicy 자체가 no-op이 됨

**Cilium chaining의 해결**:
- Flannel 유지 + Cilium을 위에 얹어 NetworkPolicy + Hubble 기능만 추가
- Flannel이 계속 pod-to-pod 라우팅, Cilium이 보안/관측 레이어 담당
- OKE Basic 무료 유지하면서 NetworkPolicy 시행 가능

**대체재 비교**:
- **OCI VCN-Native CNI**: Enhanced Cluster 필수 → $0.10/hr 비용 발생 → Always Free 컨셉 위반
- **Cilium full replacement** (Flannel 제거): 위험. OKE 관리 plane이 Flannel 재배포 시도 가능. 마이그레이션 중 모든 통신 단절.
- **Calico**: NetworkPolicy 지원하지만 Cilium의 eBPF 관측력 부족
- **Cilium chaining**: 가장 안전. 롤백 = Cilium DaemonSet 삭제만으로 즉시 원복

**Hubble의 가치**:
- 네트워크 흐름을 service map으로 시각화 (Kiali와 유사하나 L4 + DNS)
- 거부된 connection 즉시 확인 (NetworkPolicy 디버깅)
- eBPF 기반이라 sidecar 같은 자원 부담 없음

## 2. Architecture — 어떻게 구성되는가

**Cilium 컴포넌트**:
- **cilium-agent**: 노드당 1개 DaemonSet. eBPF 프로그램 로드, NetworkPolicy 시행.
- **cilium-operator**: cluster-wide 관리 (IPAM, identity 등). Deployment.
- **cilium-cli**: 디버깅 CLI. 별도 binary.

**Hubble 컴포넌트**:
- **hubble-relay**: 모든 노드의 hubble 데이터 집계
- **hubble-ui**: 웹 UI
- **hubble peer**: cilium-agent 내장. flow 데이터 export.

**Chaining mode 동작**:
- Flannel이 CNI plugin chain의 첫 번째 → pod IP 할당, 라우팅 설정
- Cilium이 두 번째 → eBPF 프로그램 attach, NetworkPolicy 평가
- Pod 생성 시 두 plugin이 순차 호출됨

**eBPF (extended Berkeley Packet Filter)**:
- Linux kernel에서 동작하는 sandbox 가상 머신
- Network packet 처리, syscall 추적 등 가능
- iptables보다 빠름 (특히 룰 많을 때)
- Cilium의 핵심 기술

## 3. Mechanism — 어떻게 돌아가는가

**Pod 생성 시 chaining 흐름**:
1. kubelet이 새 Pod 생성 요청
2. CNI plugin chain 호출
3. Flannel이 pod에 IP 할당 + veth pair 생성 + 라우팅 설정
4. Cilium이 eBPF 프로그램을 veth interface에 attach
5. Pod 트래픽 발생 시 eBPF 프로그램이 NetworkPolicy 평가

**NetworkPolicy 시행**:
- Cilium이 모든 NetworkPolicy + CiliumNetworkPolicy CR watch
- eBPF map에 allow/deny 룰 컴파일
- Pod 트래픽 발생 시 eBPF 프로그램이 룰 평가
- 거부 시 packet drop + Hubble flow에 기록

**Cilium Identity**:
- Pod의 label 집합을 numeric identity로 압축 (예: `app=login,version=v1` → ID 1000)
- eBPF map에 identity별 정책 저장 → 메모리 효율
- Pod IP가 바뀌어도 identity는 label 기반이라 안정적

**Hubble flow capture**:
- eBPF 프로그램이 모든 connection의 metadata 수집
- source/dest identity + port + protocol + verdict(allow/deny)
- hubble-relay에 stream
- Hubble UI에서 service map으로 시각화

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Cilium chaining 의존 관계.

- **Flannel** (OKE Basic 기본 CNI) — chaining 첫 번째 plugin
- **Istio Ambient** — ztunnel과 Cilium chaining 공존 검증 필수
- **NetworkPolicy** — Phase 6의 다음 항목, Cilium 설치 후 시행 가능
- **Hubble UI** — 디버깅 시 임시 활성화 (평소 비활성으로 RAM 절감)
- **Prometheus** — Cilium 메트릭 수집

**Istio Ambient ↔ Cilium chaining 공존**:
- 둘 다 노드 레벨 네트워크 평면을 다룸 — 충돌 가능성
- Cilium kube-proxy 대체 모드 vs Istio ztunnel iptables 룰 — 호환 검증 필요
- 일반적으로 Cilium standard mode + Istio Ambient는 가능, 추가 설정 약간 필요
- 공식 docs 빈약 — 본 프로젝트는 검증 step 박아둠

## 5. Usage — 어떻게 쓰는가

**Cilium 설치** (chaining mode, Helm):

```bash
helm install cilium cilium/cilium \
  --namespace kube-system \
  --version 1.17+ \
  -f cilium-values.yaml
```

cilium-values.yaml:
```yaml
# Chaining mode — Flannel 위에 얹기
cni:
  chainingMode: generic-veth
  customConf: true
  exclusive: false             # Flannel CNI config 유지

# eBPF kube-proxy 대체 비활성 (kube-proxy 유지)
kubeProxyReplacement: false

# 본 프로젝트는 NetworkPolicy + Hubble만 필요
bpf:
  masquerade: false            # Flannel이 처리

# Hubble
hubble:
  enabled: true
  relay:
    enabled: true
  ui:
    enabled: false             # 평소 비활성, 필요 시 enable

# Pod CIDR (Flannel과 동일하게 — autoDetect)
ipam:
  mode: kubernetes             # k8s가 IP 관리

# 자원
resources:
  requests: { cpu: 100m, memory: 256Mi }
operator:
  resources:
    requests: { cpu: 50m, memory: 128Mi }
```

**설치 후 검증**:

```bash
# cilium-cli 설치
curl -L --remote-name-all https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz
tar xzf cilium-linux-amd64.tar.gz
sudo mv cilium /usr/local/bin

# 상태 확인
cilium status

# Flannel과 공존 확인
kubectl get pods -n kube-system -l app.kubernetes.io/name=cilium-agent
kubectl get pods -n kube-system -l app=flannel
# 둘 다 Running

# Connectivity 테스트
cilium connectivity test
```

**Hubble UI 임시 활성화** (디버깅):

```bash
# values.yaml 수정 또는 helm upgrade
helm upgrade cilium cilium/cilium \
  --namespace kube-system \
  --reuse-values \
  --set hubble.ui.enabled=true

# UI port-forward
cilium hubble ui
# → http://localhost:12000
```

**Hubble CLI로 flow 관찰**:

```bash
# 전체 flow stream
cilium hubble observe

# 특정 namespace
cilium hubble observe --namespace app

# Drop된 packet만 (정책 위반)
cilium hubble observe --verdict DROPPED

# 특정 pod
cilium hubble observe --pod login-xxx
```

**Cilium 제거 (롤백)**:

```bash
# Cilium 삭제만으로 Flannel만 남아서 정상 동작
helm uninstall cilium -n kube-system
# 또는 selective: cilium agent pod만 삭제
kubectl delete daemonset cilium -n kube-system
```

## 6. Configuration — 어떤 설정이 있는가

**Chaining mode 옵션**:
- `generic-veth`: 일반 chaining. 본 프로젝트.
- `aws-cni`, `gke`, `azure`: 클라우드별 chaining
- `none`: chaining 없음 (Cilium standalone)

**Hubble 옵션**:
- `hubble.enabled`: 핵심 활성화
- `hubble.relay.enabled`: 노드간 flow 집계
- `hubble.ui.enabled`: 웹 UI
- `hubble.metrics.enabled`: Prometheus 메트릭

**NetworkPolicy 시행 옵션**:
- `policyEnforcementMode`:
  - `default`: NetworkPolicy 있으면 deny by default, 없으면 allow
  - `always`: 항상 deny by default (가장 안전, 본 프로젝트 권장)
  - `never`: NetworkPolicy 무시

**Cilium specific**:
- `bpf.masquerade`: NAT 처리 (Flannel과 충돌 → false)
- `kubeProxyReplacement`: kube-proxy 완전 대체 (chaining에서 비활성)
- `ipv6.enabled`: IPv6 지원
- `endpointRoutes.enabled`: 라우팅 최적화

**Hubble flow retention**:
- `hubble.eventBufferCapacity`: 메모리 buffer 크기 (default 4096)
- 더 길게 보려면 외부 storage(Loki 등) 통합

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **Cilium 1.16+** (chaining mode 안정). 본 프로젝트 1.17+
- **Linux kernel 5.4+** (eBPF 일부 기능). OKE Oracle Linux 기본 만족
- **Flannel chaining 호환**: cilium의 `generic-veth` mode
- **Istio Ambient 공존**: 검증된 패턴 (공식 docs 있음, 추가 설정 필요)
- **OKE Basic Cluster**: 가능 (NetworkPolicy 관점), 단 OKE add-on이 아니라 직접 Helm 설치

## 8. 면접 예상 질문 & 답변

**Q1. Cilium chaining mode가 뭐고 왜 골랐어요?**
> Cilium을 기존 CNI(본 프로젝트는 Flannel) 위에 얹어서 NetworkPolicy 시행과 Hubble 관측 기능만 추가하는 방식입니다. Flannel은 pod-to-pod 라우팅을 계속 담당하고, Cilium은 보안/관측 레이어만 책임집니다. 본 프로젝트가 chaining을 선택한 이유는 OKE Basic Cluster가 **Flannel만 지원**(OCI VCN-Native CNI는 Enhanced Cluster 전용 = 유료)이고, Flannel은 NetworkPolicy 미지원이라 Phase 6의 NetworkPolicy 자체가 no-op이 됩니다. Cilium chaining으로 Always Free 유지하면서 NetworkPolicy 시행 가능합니다.

**Q2. Flannel 완전히 제거하고 Cilium standalone 쓰면 안 돼요?**
> 위험합니다. OKE Basic의 Flannel은 OKE 관리 plane이 자동 배포하므로 강제 제거하면 OKE가 재배포 시도할 수 있습니다. 또 마이그레이션 중 모든 통신이 1-2분 단절됩니다. Oracle 공식 learn 가이드에 절차는 있지만 best-effort 범위로 production 비권장입니다. Chaining mode는 (1) Flannel을 안 건드림 — OKE add-on 표준 유지, (2) 롤백 = Cilium DaemonSet 삭제로 즉시 원복, (3) 마이그레이션 단절 없음 — 세 가지 안전성 이점이 있어서 선택했습니다.

**Q3. Chaining mode의 단점은?**
> eBPF kube-proxy 대체 같은 Cilium 고급 기능을 활용 못 합니다. (1) 성능 — Cilium standalone은 iptables 대신 eBPF map 사용으로 더 빠른데, chaining은 Flannel의 iptables를 그대로 씁니다. (2) BGP, L4 load balancing, egress gateway 같은 고급 기능 사용 불가. (3) IPv6 등 일부 기능 제약. 본 프로젝트는 NetworkPolicy 시행 + Hubble 관측만 필요하므로 이런 trade-off는 수용 가능합니다. 면접에서 "성능 최우선이고 OKE Enhanced로 갈 수 있으면 Cilium standalone이 더 강력"이라 답할 수 있습니다.

**Q4. eBPF가 뭐고 왜 중요해요?**
> extended Berkeley Packet Filter. Linux kernel에 안전한 sandbox VM으로 코드를 attach하는 기술입니다. 원래 packet filtering용이었지만 지금은 system call 추적, observability, 네트워크 처리 등 다양하게 활용됩니다. 중요한 이유는 (1) **kernel 레벨 성능** — userspace로 context switch 없이 처리, (2) **안전한 sandbox** — verifier가 코드 검증, kernel crash 위험 낮음, (3) **동적 attach** — kernel rebuild 없이 동작 변경. Cilium은 NetworkPolicy 평가를 eBPF로 해서 iptables 룰 수천 개 환경에서도 빠르게 동작합니다.

**Q5. Hubble이 Kiali와 어떻게 달라요?**
> 레이어가 다릅니다. Kiali는 **L7 service mesh** 시각화 — HTTP RPS, latency, error rate, JWT 등 application 메트릭 중심입니다. Hubble은 **L4 network flow** 시각화 — connection 단위로 source/dest pod, port, protocol, allow/deny verdict 보여줍니다. 둘은 보완 관계라 Kiali로 service간 호출 관계 보다가 의심스러운 패턴 발견 시 Hubble로 네트워크 레벨 검증. 본 프로젝트는 둘 다 씁니다 — Kiali는 일상 모니터링, Hubble은 NetworkPolicy 디버깅 시 임시 활성화.

**Q6. Istio Ambient ztunnel과 Cilium chaining이 충돌 안 해요?**
> 잠재적 충돌 가능성 있어서 검증이 필요합니다. 둘 다 노드 레벨 네트워크 평면에 영향을 줍니다 — Cilium은 eBPF로 packet 처리, Istio ztunnel은 iptables redirect로 트래픽 가로채기. 일반적으로 (1) Cilium chaining + Flannel + Istio Ambient는 동작하는 검증된 패턴, (2) Cilium standalone + Istio Ambient는 추가 설정 필요. 본 프로젝트는 chaining mode 선택으로 위험 최소화하고, 설치 후 `istioctl proxy-status`와 `cilium status` 둘 다 정상 확인하는 step을 박아둡니다.

**Q7. Hubble UI를 평소에 안 켜놓는 이유는?**
> 자원 절감입니다. Hubble UI는 ~100MB RAM 추가 사용하고, Hubble Relay도 ~50MB. 디버깅 시에만 의미가 있어서 평소엔 cilium-agent의 hubble peer만 활성화하고 UI는 비활성. 필요할 때 `helm upgrade --set hubble.ui.enabled=true`로 임시 켜고, 사용 후 다시 disable. Always Free 24GB RAM 환경에서 매번 ~150MB 절감이 의미 있습니다.

**Q8. Cilium 설치 후 어떻게 동작 검증해요?**
> 네 단계로 갑니다. (1) `cilium status` — 모든 cilium-agent Pod이 OK인지. (2) `cilium connectivity test` — 자동 e2e 테스트, 다른 namespace 통신, NetworkPolicy 시행 등 검증. (3) Flannel pod도 같이 Running 확인 (`kubectl get pods -n kube-system -l app=flannel`). (4) 기존 앱 통신이 정상인지 — Cilium 설치 후 통신 깨지면 chaining 설정 문제. 본 프로젝트는 이 네 단계를 Cilium 설치 직후 runbook으로 박아둡니다.

**Q9. NetworkPolicy 시행에서 default-deny 패턴은 어떻게 적용해요?**
> 두 옵션이 있습니다. (1) Cilium의 `policyEnforcementMode: always` 설정 — Cilium이 cluster-wide로 default-deny 강제, NetworkPolicy 없으면 통신 차단. 가장 안전. (2) NetworkPolicy로 명시적 `policyTypes: [Ingress, Egress]` + `from: []` 빈 룰 — 해당 namespace만 default-deny. 본 프로젝트는 (2) 권장 — namespace별 점진 적용 가능. Phase 6의 NetworkPolicy 항목에서 sequencing(allow 정책 먼저 작성 → audit mode 검증 → enforce) 강제.

**Q10. Cilium이 죽으면 어떻게 되나요?**
> Chaining mode라 Flannel은 정상 동작하므로 **기존 통신은 영향 없습니다**. NetworkPolicy 시행만 멈춥니다 — 차단되어야 할 트래픽이 통과할 수 있어서 보안 영향 있음. 또 새 pod 생성 시 Cilium이 eBPF 프로그램을 attach 못 해서 pod 시작이 늦어지거나 NetworkPolicy 미적용 상태로 시작. Prometheus 알람으로 cilium-agent DaemonSet ready 부족 즉시 감지. Cilium은 stateless라 재기동만으로 회복.

**Q11. Cilium chaining에서 CiliumNetworkPolicy(CNP)도 쓸 수 있나요?**
> 네, 가능합니다. CiliumNetworkPolicy는 표준 NetworkPolicy의 확장으로 L7 정책(HTTP method/path), DNS 기반 정책, service identity 기반 정책 등 추가 기능을 제공합니다. Chaining mode에서도 cilium-agent가 eBPF 프로그램을 attach하므로 CNP 모두 동작합니다. 본 프로젝트는 (1) cross-cutting 정책은 표준 NetworkPolicy로 (k8s 표준성 우선), (2) L7 정책이 필요하면 Istio AuthorizationPolicy로 — Istio가 이미 있으므로 — 분리해서 단순성 유지합니다. CNP는 사용 안 함.

**Q12. cilium connectivity test가 fail하면 어떻게 디버깅해요?**
> 출력 메시지가 어느 test에서 실패했는지 명시합니다. 흔한 원인: (1) Flannel chaining 설정 오류 → `kubectl logs -n kube-system -l app.kubernetes.io/name=cilium-agent`에서 CNI conflict 로그 확인. (2) Pod CIDR 충돌 → Cilium IPAM과 Flannel 같은 CIDR 사용 확인. (3) NetworkPolicy가 test pod 통신 차단 → `cilium hubble observe --verdict DROPPED`로 거부된 packet 확인. (4) Istio sidecar가 test pod에 주입되어 통신 막힘 → test namespace에 sidecar 주입 disable. 본 프로젝트 OKE 환경에서는 (1) chaining 설정이 가장 흔한 원인.
