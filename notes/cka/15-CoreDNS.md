# 15. CoreDNS

> 도메인: 서비스와 네트워킹 (20%)
> 시험 포인트: "CoreDNS 이해 및 사용"이 커리큘럼에 명시. DNS 이름 규칙 + DNS 안 될 때 진단 흐름이 핵심.

---

## 1. CoreDNS란

- 클러스터 내부 DNS 서버. kube-system에 **Deployment**(replicas 2)로 배포
- 모든 Pod의 `/etc/resolv.conf`가 CoreDNS의 Service(`kube-dns`) IP를 가리킴
- Service/Pod가 생기면 자동으로 DNS 레코드 제공

```bash
kubectl get deploy -n kube-system coredns
kubectl get svc -n kube-system kube-dns        # 이름은 kube-dns (역사적 이유)
kubectl get configmap -n kube-system coredns   # 설정(Corefile)
```

## 2. DNS 이름 규칙 (암기 필수)

### Service
```
<service>.<namespace>.svc.cluster.local
```
- 같은 네임스페이스: `web-svc` 만으로 OK
- 다른 네임스페이스: `web-svc.prod` 또는 FQDN `web-svc.prod.svc.cluster.local`
- SRV 레코드: `_<port명>._<프로토콜>.<svc>.<ns>.svc.cluster.local`

### Pod (기본 생성 안 됨, headless 서비스 경유가 일반적)
```
<a-b-c-d(IP의 점을 대시로)>.<namespace>.pod.cluster.local     # 예: 10-244-1-5.default.pod.cluster.local
<pod명>.<headless-svc>.<ns>.svc.cluster.local                  # StatefulSet 패턴
```

### Pod의 resolv.conf
```bash
kubectl exec mypod -- cat /etc/resolv.conf
# nameserver 10.96.0.10        ← kube-dns Service IP
# search default.svc.cluster.local svc.cluster.local cluster.local
# options ndots:5
```
- `search` 도메인 덕분에 짧은 이름(`web-svc`)이 자동 완성된다

## 3. Corefile (CoreDNS 설정)

```bash
kubectl get cm coredns -n kube-system -o yaml
```
```
.:53 {
    errors
    health { lameduck 5s }
    ready
    kubernetes cluster.local in-addr.arpa ip6.arpa {    # k8s 리소스 → DNS
        pods insecure
        fallthrough in-addr.arpa ip6.arpa
    }
    prometheus :9153
    forward . /etc/resolv.conf { max_concurrent 1000 }  # 외부 도메인은 업스트림으로
    cache 30
    loop
    reload                                              # ConfigMap 변경 자동 반영
    loadbalance
}
```

- **kubernetes 플러그인**: 클러스터 도메인(cluster.local) 질의 처리
- **forward 플러그인**: 나머지(외부) 질의를 노드의 resolv.conf 업스트림으로 전달
- ConfigMap 수정 후 `reload` 플러그인이 자동 반영 (몇 분). 즉시 반영하려면:
  ```bash
  kubectl -n kube-system rollout restart deploy coredns
  ```

## 4. Pod의 dnsPolicy / dnsConfig

```yaml
spec:
  dnsPolicy: ClusterFirst        # 기본값: 클러스터 도메인은 CoreDNS, 나머지 업스트림
  # Default: 노드의 resolv.conf 상속 (클러스터 DNS 안 씀)
  # None: 아래 dnsConfig로 완전 수동
  # ClusterFirstWithHostNet: hostNetwork Pod에서 클러스터 DNS 쓸 때
  dnsConfig:
    nameservers: ["1.1.1.1"]
    searches: ["my.domain"]
    options:
    - name: ndots
      value: "2"
```

> 함정: `hostNetwork: true`인 Pod의 기본 dnsPolicy 동작은 노드 DNS를 따른다. 클러스터 서비스 이름을 쓰려면 `ClusterFirstWithHostNet` 지정.

## 5. DNS 트러블슈팅 (시험 빈출 흐름)

```bash
# 0) 테스트 Pod
kubectl run dnstest --image=busybox --rm -it --restart=Never -- nslookup kubernetes.default

# 실패 시 순서대로:
# 1) CoreDNS Pod 살아있나
kubectl get pods -n kube-system -l k8s-app=kube-dns
kubectl logs -n kube-system -l k8s-app=kube-dns

# 2) kube-dns Service와 Endpoints
kubectl get svc,ep kube-dns -n kube-system     # Endpoints 비어 있으면 CoreDNS Pod 문제

# 3) 대상 Pod의 resolv.conf가 kube-dns IP를 가리키나
kubectl exec mypod -- cat /etc/resolv.conf

# 4) Corefile 문법 오류 확인
kubectl get cm coredns -n kube-system -o yaml
kubectl describe pod -n kube-system -l k8s-app=kube-dns   # CrashLoop이면 Corefile 오류 가능성

# 5) kube-proxy / NetworkPolicy가 53 포트를 막는지 (16단원)
```

| 증상 | 유력 원인 |
|---|---|
| 모든 DNS 실패 | CoreDNS 다운, kube-dns Endpoints 비음 |
| 외부 도메인만 실패 | forward 설정/업스트림 문제 |
| 특정 네임스페이스에서만 실패 | NetworkPolicy가 egress 53 차단 |
| 서비스 이름만 실패 (FQDN은 됨) | resolv.conf search/ndots 문제 |

## 6. 체크리스트

- [ ] `svc.ns.svc.cluster.local` 이름 규칙을 안 보고 쓴다
- [ ] Service 이름은 kube-dns, 구현은 CoreDNS임을 안다
- [ ] Corefile의 kubernetes/forward 플러그인 역할을 안다
- [ ] dnsPolicy 4종(특히 ClusterFirstWithHostNet)을 안다
- [ ] busybox nslookup → CoreDNS Pod → Endpoints → resolv.conf 진단 순서가 몸에 배었다
