# 13. Pod 네트워킹과 Service

> 도메인: 서비스와 네트워킹 (20%)
> 시험 포인트: "Pod 간 연결 이해", "ClusterIP/NodePort/LoadBalancer 서비스 타입과 엔드포인트 사용". Service 생성과 연결 검증, 셀렉터-레이블 매칭이 단골.

---

## 1. 쿠버네티스 네트워크 모델

깨지면 안 되는 3가지 규칙 (CNI가 구현):
1. 모든 Pod는 클러스터 내에서 **고유한 IP**를 가진다
2. 모든 Pod는 **NAT 없이** 서로 직접 통신할 수 있다 (노드가 달라도)
3. 노드의 에이전트(kubelet 등)는 그 노드의 Pod와 통신할 수 있다

- 같은 Pod 안의 컨테이너들은 **네트워크 네임스페이스를 공유** → `localhost`로 서로 통신, 포트 충돌 주의
- Pod IP는 재시작하면 바뀐다 → 그래서 **Service**가 필요하다

## 2. Service 기본

레이블 셀렉터로 Pod 집합을 골라 **고정 가상 IP(ClusterIP)와 DNS 이름**을 부여.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  type: ClusterIP            # 생략 시 기본값
  selector:
    app: web                 # ← Pod의 레이블과 일치해야 함
  ports:
  - port: 80                 # Service가 여는 포트
    targetPort: 8080         # Pod 컨테이너 포트
    protocol: TCP
```

```bash
kubectl expose deploy web --name=web-svc --port=80 --target-port=8080
kubectl get svc,ep web-svc
kubectl get endpointslices -l kubernetes.io/service-name=web-svc
```

### Endpoints / EndpointSlice
- Service의 셀렉터에 매칭되고 **readinessProbe를 통과한** Pod IP 목록
- **Endpoints가 비어 있으면**: ① 셀렉터-레이블 불일치 ② Ready 안 된 Pod ③ Pod 없음 → 서비스 트러블슈팅의 출발점

```bash
kubectl describe svc web-svc     # Endpoints: 10.244.1.5:8080,... 확인
```

## 3. Service 타입 4가지

### ClusterIP (기본)
- 클러스터 **내부 전용** 가상 IP
- 내부 마이크로서비스 간 통신 표준

### NodePort
- ClusterIP 기능 + **모든 노드의 고정 포트(30000-32767)** 개방
- `<아무 노드 IP>:<nodePort>`로 외부 접근
```yaml
spec:
  type: NodePort
  ports:
  - port: 80
    targetPort: 8080
    nodePort: 30080        # 생략 시 자동 할당
```

### LoadBalancer
- NodePort 기능 + **외부 로드밸런서** 프로비저닝 (클라우드/MetalLB 필요)
- 온프레미스에서 구현체가 없으면 `EXTERNAL-IP: <pending>`에 머무름 (이것 자체가 문제 유형)

### ExternalName
- 셀렉터/IP 없이 **DNS CNAME**만 반환 (외부 서비스를 내부 이름으로)
```yaml
spec:
  type: ExternalName
  externalName: db.example.com
```

### Headless Service (타입이 아니라 변형)
```yaml
spec:
  clusterIP: None
```
- 가상 IP 없이 DNS가 **Pod IP들을 직접** 반환 — StatefulSet과 함께 사용

## 4. port 3형제 정리 (혼동 주의)

| 필드 | 의미 |
|---|---|
| `port` | Service 자신의 포트 (ClusterIP:port로 접근) |
| `targetPort` | Pod 컨테이너의 실제 포트 (생략 시 port와 동일) |
| `nodePort` | NodePort 타입에서 노드에 열리는 포트 (30000-32767) |

## 5. kube-proxy

- 각 노드에서 Service IP → Pod IP 변환 규칙을 유지 (DaemonSet)
- 모드: **iptables**(기본), ipvs, nftables
- ClusterIP는 인터페이스에 붙은 실제 IP가 아니라 **iptables/ipvs 규칙**이다 → ping이 안 되는 게 정상, curl로 검증할 것

```bash
kubectl get pods -n kube-system -l k8s-app=kube-proxy
kubectl logs -n kube-system <kube-proxy-pod>
```

## 6. 셀렉터 없는 Service (수동 엔드포인트)

외부 IP를 서비스 뒤에 수동으로 두는 패턴:
```yaml
apiVersion: v1
kind: Service
metadata:
  name: external-db
spec:
  ports:
  - port: 3306
---
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: external-db-1
  labels:
    kubernetes.io/service-name: external-db    # 이 레이블로 연결
addressType: IPv4
ports:
- port: 3306
endpoints:
- addresses: ["192.168.1.100"]
```

## 7. 연결 검증 루틴 (시험 필수 습관)

```bash
# 1) Service와 Endpoints 확인
kubectl get svc web-svc
kubectl describe svc web-svc          # Endpoints 비었는지!

# 2) 임시 Pod에서 접근 테스트
kubectl run tmp --image=busybox --rm -it --restart=Never -- wget -qO- --timeout=2 http://web-svc:80

# 3) DNS 확인
kubectl run tmp --image=busybox --rm -it --restart=Never -- nslookup web-svc

# 4) NodePort면 노드에서
curl http://<nodeIP>:30080
```

## 8. sessionAffinity (참고)

```yaml
spec:
  sessionAffinity: ClientIP        # 같은 클라이언트는 같은 Pod로
  sessionAffinityConfig:
    clientIP:
      timeoutSeconds: 10800
```

## 9. 체크리스트

- [ ] 네트워크 모델 3규칙(모든 Pod NAT 없이 통신)을 안다
- [ ] ClusterIP/NodePort/LoadBalancer/ExternalName의 차이와 용도를 안다
- [ ] port/targetPort/nodePort를 절대 헷갈리지 않는다
- [ ] Endpoints가 비는 3가지 원인을 안다
- [ ] `kubectl expose`로 서비스를 만들고 임시 Pod로 검증할 수 있다
- [ ] ClusterIP에 ping이 안 되는 이유(kube-proxy 규칙)를 안다
- [ ] Headless Service(clusterIP: None)의 용도를 안다
