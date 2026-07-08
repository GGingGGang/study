# 14. Ingress와 Gateway API

> 도메인: 서비스와 네트워킹 (20%)
> 시험 포인트: 2025 개정판에서 **Gateway API가 정식 항목**으로 추가됨 ("Gateway API를 사용해 Ingress 트래픽 관리" + "Ingress 컨트롤러와 Ingress 리소스 사용법"). 둘 다 나온다.

---

## 1. Ingress

HTTP/HTTPS 트래픽을 호스트/경로 기준으로 Service에 라우팅하는 L7 규칙.

- **Ingress 리소스** = 규칙 선언 (그 자체로는 아무것도 안 함)
- **Ingress 컨트롤러** = 규칙을 실제로 구현하는 프록시 (nginx, traefik 등) — **별도 설치 필요**

### 1-1. 기본 Ingress
```bash
kubectl create ingress web-ing \
  --rule="example.com/api*=api-svc:80" \
  --rule="example.com/*=web-svc:80" $do > ing.yaml
```
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ing
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /   # 컨트롤러별 기능은 어노테이션
spec:
  ingressClassName: nginx          # 어떤 컨트롤러가 처리할지
  rules:
  - host: example.com
    http:
      paths:
      - path: /api
        pathType: Prefix           # Prefix | Exact | ImplementationSpecific
        backend:
          service:
            name: api-svc
            port:
              number: 80
  defaultBackend:                  # 어떤 규칙에도 안 맞을 때 (선택)
    service:
      name: default-svc
      port:
        number: 80
```

### 1-2. TLS
```yaml
spec:
  tls:
  - hosts: ["example.com"]
    secretName: web-tls            # kubectl create secret tls 로 생성한 Secret
```

### 1-3. 확인/트러블슈팅
```bash
kubectl get ingressclass                  # 사용 가능한 클래스 확인 (이름 정확히!)
kubectl get ing
kubectl describe ing web-ing              # backends에 Pod IP가 잡히는지
# 백엔드가 <error: endpoints ...not found> 면 → Service 이름/포트 오타
curl -H "Host: example.com" http://<ingress-controller-주소>/api
```

| 증상 | 원인 |
|---|---|
| 404 | host/path 불일치, pathType 부적절 |
| 503 | 백엔드 Service의 Endpoints 비어 있음 |
| Ingress가 아예 무시됨 | ingressClassName 누락/오타, 컨트롤러 미설치 |

## 2. Gateway API — Ingress의 후계자

Ingress의 한계(어노테이션 지옥, L7 HTTP만, 역할 분리 불가)를 해결한 표준. `gateway.networking.k8s.io` 그룹의 **CRD로 제공**되며 구현체(컨트롤러)가 필요하다.

### 2-1. 역할 분리형 3계층 리소스

| 리소스 | 역할 담당 | 내용 |
|---|---|---|
| **GatewayClass** | 인프라 제공자 | 어떤 구현체(컨트롤러)인지 (IngressClass 대응) |
| **Gateway** | 클러스터 운영자 | 리스너(포트/프로토콜/호스트/TLS) 정의 — LB 인스턴스에 해당 |
| **HTTPRoute** | 앱 개발자 | 실제 라우팅 규칙 (+ GRPCRoute, TCPRoute, TLSRoute...) |

### 2-2. Gateway
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
  namespace: infra
spec:
  gatewayClassName: nginx              # kubectl get gatewayclass 로 확인
  listeners:
  - name: http
    protocol: HTTP
    port: 80
    hostname: "*.example.com"
    allowedRoutes:
      namespaces:
        from: All                      # Same(기본) | All | Selector
  - name: https
    protocol: HTTPS
    port: 443
    hostname: "secure.example.com"
    tls:
      mode: Terminate
      certificateRefs:
      - name: web-tls                  # TLS Secret
```

### 2-3. HTTPRoute
```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
spec:
  parentRefs:
  - name: web-gateway                  # 연결할 Gateway
    namespace: infra
  hostnames: ["app.example.com"]
  rules:
  - matches:
    - path:
        type: PathPrefix               # PathPrefix | Exact | RegularExpression
        value: /login
    backendRefs:
    - name: login-svc
      port: 80
  - matches:
    - path: { type: PathPrefix, value: / }
    backendRefs:                       # 가중치 트래픽 분할 (카나리)
    - name: web-v1
      port: 80
      weight: 90
    - name: web-v2
      port: 80
      weight: 10
```

### 2-4. filters — 헤더 조작/리다이렉트 등
```yaml
  rules:
  - matches: [...]
    filters:
    - type: RequestHeaderModifier
      requestHeaderModifier:
        add:
        - name: X-Env
          value: prod
    - type: RequestRedirect
      requestRedirect:
        scheme: https
        statusCode: 301
    backendRefs: [...]
```

### 2-5. 확인
```bash
kubectl get gatewayclass
kubectl get gateway -A
kubectl get httproute -A
kubectl describe gateway web-gateway     # Listeners 상태, Programmed 컨디션
kubectl describe httproute web-route     # parentRefs Accepted 여부
```

## 3. Ingress vs Gateway API 요약

| | Ingress | Gateway API |
|---|---|---|
| 리소스 | 1개 (Ingress) | 3계층 (Class/Gateway/Route) |
| 고급 기능 | 컨트롤러별 어노테이션 | **표준 스펙** (헤더, 가중치, 미러링) |
| 프로토콜 | HTTP(S) | HTTP, gRPC, TCP, TLS 등 |
| 역할 분리 | 없음 | 인프라/운영/개발 분리 |
| 상태 | 동결 (기능 추가 없음) | 현재 표준, GA(v1) |

## 4. 시험 팁

- Gateway/HTTPRoute YAML은 외우기보다 문서 검색: kubernetes.io/docs에서 "Gateway API" → 예제 복사가 빠르다.
- 문제에서 지정한 **gatewayClassName / ingressClassName을 정확히** 쓸 것 (`kubectl get gatewayclass`로 먼저 확인).
- HTTPRoute가 안 붙으면: parentRefs 이름/네임스페이스, Gateway의 allowedRoutes, hostname 교집합을 순서대로 확인.

## 5. 체크리스트

- [ ] Ingress 리소스와 컨트롤러의 관계를 안다
- [ ] pathType 3종과 ingressClassName을 안다
- [ ] `kubectl create ingress --rule` 문법을 안다
- [ ] GatewayClass/Gateway/HTTPRoute 3계층 구조를 안다
- [ ] HTTPRoute의 parentRefs/matches/backendRefs/weight를 쓸 수 있다
- [ ] TLS 설정 위치 (Ingress.spec.tls / Gateway listener.tls) 를 안다
