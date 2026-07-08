# 16. NetworkPolicy

> 도메인: 서비스와 네트워킹 (20%)
> 시험 포인트: "네트워크 정책 정의와 적용"이 커리큘럼 명시 항목이자 매 시험 단골. **셀렉터 AND/OR 구분**과 **DNS(53) egress 허용**이 대표 함정.

---

## 1. 기본 동작 원리

- 정책이 하나도 없으면: **모든 트래픽 허용** (기본 개방)
- 어떤 Pod가 정책의 `podSelector`에 **선택되는 순간**: 그 방향(policyTypes)의 트래픽은 **명시적으로 허용된 것만** 통과 (기본 거부로 전환)
- 여러 정책이 한 Pod에 걸리면 **합집합(OR)** — 허용 규칙이 하나라도 맞으면 통과
- NetworkPolicy는 **CNI가 지원해야** 동작 (Calico, Cilium O / Flannel 단독 X — 적용해도 무시됨)

## 2. 구조 해부

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: api-policy
  namespace: prod              # 정책은 네임스페이스 스코프
spec:
  podSelector:                 # 이 정책이 적용될 대상 Pod
    matchLabels:
      app: api
  policyTypes:                 # 어느 방향을 통제할지 — 명시 습관!
  - Ingress
  - Egress
  ingress:
  - from:                      # 허용할 출발지
    - podSelector:             # 같은 네임스페이스의 app=web Pod
        matchLabels:
          app: web
    - namespaceSelector:       # env=prod 레이블이 붙은 네임스페이스의 모든 Pod
        matchLabels:
          env: prod
    - ipBlock:
        cidr: 10.0.0.0/16
        except: ["10.0.5.0/24"]
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: db
    ports:
    - protocol: TCP
      port: 5432
```

## 3. 최대 함정: AND vs OR

```yaml
# (A) OR — 배열 원소 2개: "ns가 prod인 모든 Pod" 또는 "이 ns의 app=web Pod"
  - from:
    - namespaceSelector:
        matchLabels: { env: prod }
    - podSelector:
        matchLabels: { app: web }

# (B) AND — 한 원소 안에 둘 다: "env=prod 네임스페이스의 app=web Pod"만
  - from:
    - namespaceSelector:
        matchLabels: { env: prod }
      podSelector:              # ← 대시(-)가 없다! 같은 원소
        matchLabels: { app: web }
```
**대시(-) 하나 차이로 의미가 완전히 달라진다.** 시험에서 요구사항을 정확히 읽고 선택할 것.

## 4. 자주 쓰는 패턴 (외워두면 조립만 하면 됨)

### deny-all (해당 ns의 모든 Pod, 양방향 차단)
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-all
  namespace: prod
spec:
  podSelector: {}              # 빈 셀렉터 = 네임스페이스의 모든 Pod
  policyTypes: [Ingress, Egress]
```

### 같은 네임스페이스 내부만 허용
```yaml
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
  - from:
    - podSelector: {}          # 같은 ns의 모든 Pod
```

### 모든 ingress 허용 (allow-all)
```yaml
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress:
  - {}                          # 빈 규칙 = 전부 허용
```

### egress 정책 시 DNS 허용 (필수 부속품!)
egress를 기본 거부로 만들면 **DNS도 막혀서** 서비스 이름 해석이 안 된다. 거의 항상 이 블록을 추가:
```yaml
  egress:
  - to: []                      # 모든 목적지 (또는 kube-system의 kube-dns로 좁혀도 됨)
    ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
```

## 5. 읽기 주의점

- `podSelector: {}` (빈 값) = **모두 선택** / 필드 자체가 없으면 문맥에 따라 다름
- `policyTypes`를 생략하면: ingress 규칙이 있으면 Ingress, egress 규칙이 있으면 Egress로 추론 — **Egress만 통제하려는데 policyTypes에 Egress를 안 쓰면 의도대로 안 됨**. 항상 명시하자.
- ipBlock의 cidr는 주로 클러스터 **외부** IP용 (Pod IP는 SNAT 등으로 신뢰 불가)
- 정책은 연결 기준(stateful): ingress를 허용하면 그 응답 트래픽은 egress 규칙과 무관하게 나간다

## 6. 작성/검증 루틴

```bash
kubectl get netpol -n prod
kubectl describe netpol api-policy -n prod    # 해석된 규칙 확인

# 레이블 확인 (정책이 실제로 그 Pod를 선택하는지!)
kubectl get pods -n prod --show-labels
kubectl get ns --show-labels                  # namespaceSelector용
# (참고: 모든 ns에는 kubernetes.io/metadata.name=<ns명> 레이블이 자동으로 있다)

# 연결 테스트
kubectl run tmp -n web --image=busybox --rm -it --restart=Never -- \
  wget -qO- --timeout=2 http://api-svc.prod:8080
```

> **시험 팁**: NetworkPolicy는 명령형 생성 명령이 없다. 문서에서 "Network Policies" 페이지의 전체 예제를 복사해 수정하는 것이 정석.

## 7. 체크리스트

- [ ] "선택되는 순간 기본 거부"로 바뀌는 동작 원리를 안다
- [ ] from/to 배열의 AND(한 원소) vs OR(여러 원소)를 구분한다
- [ ] deny-all, 같은 ns 허용, allow-all 패턴을 조립할 수 있다
- [ ] egress 정책엔 DNS 53(UDP/TCP) 허용을 붙이는 습관이 있다
- [ ] policyTypes를 항상 명시한다
- [ ] ns 자동 레이블 `kubernetes.io/metadata.name`을 활용할 수 있다
- [ ] CNI가 NetworkPolicy를 지원해야 함을 안다
