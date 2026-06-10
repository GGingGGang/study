# Gateway API 철학과 아키텍처 (Gateway API Philosophy & Architecture)

> 쿠버네티스 · 네트워킹/Gateway API · 학습내용: Ingress의 한계와 Gateway API 등장 배경, 역할 지향(role-oriented) 설계 철학, 리소스 모델(GatewayClass/Gateway/HTTPRoute 등 Route 종류/ReferenceGrant)과 소유권·바인딩, Ingress 대비 무엇이 달라졌는가

---

이 문서는 "심화"다. Gateway API를 **왜** 만들었고, 그 설계 철학(역할 분리)과 리소스 모델이 **어떻게 맞물리는지**까지 깊게 본다. 이 프로젝트는 외부 트래픽을 **Gateway API → OCI NLB → 도메인 `ggang.cloud`** 로 받고, 메시 내부는 **Istio Ambient**(ztunnel + waypoint)로 처리한다. Gateway API는 그 입구(north-south 트래픽)의 표준 모델이다.

## 1. Ingress의 한계 — 왜 새 API가 필요했나

쿠버네티스의 기존 L7 진입 리소스는 **Ingress** 였다. Ingress는 "호스트/경로 → 백엔드 Service" 라우팅을 한 장의 리소스로 표현한다. 문제는 그 표현력이 **호스트와 경로 매칭 수준에 머물렀다**는 데 있다. 실무에서 필요한 거의 모든 고급 기능이 Ingress 표준에 없었다.

### 1.1 표현력 부족 (under-specified)

Ingress 스펙으로 표준화된 것은 사실상 **호스트 + 경로 매칭 + TLS** 정도다. 다음은 Ingress 표준에 **없다**.

- **헤더/메서드/쿼리 기반 라우팅** (예: `X-Canary: true` 헤더면 다른 백엔드로)
- **트래픽 가중치 분할** (예: v1 90% / v2 10% 카나리)
- **요청/응답 헤더 조작, 리다이렉트, URL 재작성**
- **트래픽 미러링**, 가중 백엔드, 다중 프로토콜(TCP/TLS/gRPC)

### 1.2 어노테이션 난립 (annotation hell)

표준에 없으니 구현체(NGINX, Traefik, HAProxy, 클라우드 LB 컨트롤러…)들은 **저마다 어노테이션으로 기능을 끼워 넣었다**.

```yaml
# Ingress의 전형적 모습: 핵심 동작이 전부 벤더 어노테이션에 숨음
metadata:
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$1
    nginx.ingress.kubernetes.io/canary: "true"
    nginx.ingress.kubernetes.io/canary-weight: "10"
    # ↑ 컨트롤러를 바꾸면 전부 다시 써야 함(이식성 0, 검증 불가, 오타 무방비)
```

> ★ "어노테이션 지옥"의 본질적 문제: ① **이식성 없음**(컨트롤러 종속) ② **타입 검증 안 됨**(문자열이라 오타·잘못된 값이 런타임에 터짐) ③ **문서가 제각각**이라 학습 비용 큼.

### 1.3 역할 분리 불가 (no role separation)

Ingress는 **모든 정보가 한 리소스에 뭉쳐** 있다. 인프라(LB 설정), 라우팅 정책(경로 규칙), 앱(백엔드)이 한 YAML에 섞인다. 그래서 **플랫폼 팀과 앱 팀의 권한을 분리할 수 없다**. 앱 개발자에게 라우팅을 맡기려면 Ingress 전체 수정 권한을 줘야 하는데, 거기엔 LB·TLS 같은 인프라 설정까지 들어 있다.

### 1.4 그 외

- **확장 포인트 부재**: 표준 확장 방법이 없어 결국 어노테이션으로 회귀.
- **다른 프로토콜 미지원**: HTTP/HTTPS 중심. TCP/UDP/TLS 패스스루/gRPC는 표준 밖.

→ 결론: Ingress는 "되긴 되는데 표준이 너무 빈약해서 실무는 전부 비표준 어노테이션으로 굴러간다." 이걸 **표준화된 타입(typed)·확장 가능·역할 분리** 구조로 다시 설계한 것이 **Gateway API** 다.

## 2. 역할 지향 설계 (Role-Oriented Design)

Gateway API의 핵심 철학은 **"하나의 리소스에 다 넣지 말고, 책임 주체별로 리소스를 쪼갠다"** 는 것이다. 공식 문서는 세 가지 역할(persona)을 전제한다.

| 역할 | 누구 | 책임 | 담당 리소스 |
|------|------|------|-------------|
| **Infrastructure Provider** | 클라우드/플랫폼 벤더 | 어떤 게이트웨이 "종류(class)"가 가능한지, 어떤 컨트롤러가 구현하는지 | **GatewayClass** |
| **Cluster Operator** | 플랫폼/인프라 팀 | 실제 게이트웨이(리스너·포트·TLS·LB) 운영, 어떤 네임스페이스의 Route를 붙일지 정책 | **Gateway** |
| **Application Developer** | 앱 개발팀 | 자기 앱의 라우팅 규칙(경로·헤더·가중치)만 선언 | **HTTPRoute** 등 Route |

> ★★★ 면접 핵심: "Gateway API가 Ingress와 가장 다른 점은 **역할 분리**다. 인프라 설정(Gateway)과 라우팅 규칙(Route)을 **다른 리소스로 분리**해서, 플랫폼 팀은 Gateway를, 앱 팀은 Route를 각자 RBAC로 소유한다. Ingress는 다 섞여 있어 이게 불가능했다."

이 분리가 주는 실질 이득:

- **최소 권한**: 앱 팀에게 LB/TLS 권한을 줄 필요 없이 Route만 줄 수 있다.
- **안전한 위임**: Gateway 소유자가 "어떤 네임스페이스의 Route를 붙일 수 있는지" 정책으로 통제한다(3.4절).
- **이식성**: 라우팅 규칙이 typed 스펙이라 컨트롤러를 바꿔도(예: 클라우드 LB ↔ Istio) 그대로 쓸 수 있다.

## 3. 리소스 모델

Gateway API는 여러 리소스가 **위에서 아래로 참조**하며 한 그래프를 이룬다.

```
GatewayClass   (인프라 제공자: "이 컨트롤러가 게이트웨이를 구현한다")
     ▲ gatewayClassName
     │
  Gateway      (클러스터 운영자: 리스너/포트/TLS, allowedRoutes 정책)
     ▲ parentRefs
     │
  HTTPRoute    (앱 개발자: 호스트/경로/헤더 매칭 → 백엔드)
     │ backendRefs
     ▼
  Service (백엔드 파드)
```

### 3.1 GatewayClass

**GatewayClass** 는 "이런 종류의 Gateway는 **이 컨트롤러**가 구현한다"를 선언하는 **클러스터 범위(cluster-scoped)** 리소스다. `controllerName` 필드로 어떤 구현체가 책임지는지 지정한다. (Ingress의 `IngressClass`에 대응)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: istio
spec:
  controllerName: istio.io/gateway-controller
```

이 프로젝트는 Istio가 Gateway API를 구현하므로 Istio가 제공하는 GatewayClass를 쓴다. 클라우드 LB 컨트롤러가 제공하는 별도 GatewayClass를 쓸 수도 있다.

### 3.2 Gateway

**Gateway** 는 실제 트래픽 진입점이다. **리스너(listener)** 목록으로 "어떤 포트/프로토콜/호스트네임/TLS로 받을지"를 정의한다. Gateway가 생성되면 컨트롤러가 그에 맞는 실제 데이터플레인(이 프로젝트에선 **OCI NLB** + Istio 게이트웨이 프록시)을 프로비저닝한다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web-gateway
  namespace: gateway-system
spec:
  gatewayClassName: istio
  listeners:
    - name: https
      protocol: HTTPS
      port: 443
      hostname: "*.ggang.cloud"
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: ggang-cloud-tls   # cert-manager가 DNS-01로 발급
      allowedRoutes:
        namespaces:
          from: Selector
          selector:
            matchLabels:
              gateway-access: "allowed"
```

- **listener**: 포트·프로토콜·hostname·TLS를 묶은 단위. 한 Gateway에 여러 리스너(예: 80·443)를 둘 수 있다.
- **allowedRoutes**: **어떤 네임스페이스의 Route가 이 리스너에 붙을 수 있는지** 정하는 정책(`Same`/`All`/`Selector`). 위임 통제의 핵심.

### 3.3 Route 종류

라우팅 규칙은 프로토콜별 Route 리소스로 표현한다. 백엔드(`backendRefs`)와 매칭·필터를 가진다.

| Route | 프로토콜 | 무엇을 라우팅 |
|-------|----------|---------------|
| **HTTPRoute** | HTTP/HTTPS(L7) | 호스트·경로·헤더·메서드·쿼리 매칭, 헤더 조작, 가중치 분할 — 가장 많이 씀 |
| **GRPCRoute** | gRPC | service/method 단위 매칭 (HTTP/2 기반) |
| **TLSRoute** | TLS (SNI) | SNI 호스트네임 기반, TLS **패스스루** 라우팅 |
| **TCPRoute** | TCP(L4) | 리스너→백엔드 단순 전달(매칭 규칙 없음) |
| **UDPRoute** | UDP(L4) | UDP 전달 |

- **HTTPRoute / GRPCRoute** 는 표준 채널(GA에 가까운 안정 트랙), **TLSRoute / TCPRoute / UDPRoute** 는 실험적(experimental) 채널에 속한다. 그래서 L4·패스스루 기능은 별도 설치와 주의가 필요하다.

### 3.4 소유권과 바인딩 — parentRefs ↔ allowedRoutes (양방향 합의)

Gateway와 Route의 연결은 **양쪽이 동의해야** 성립한다. 이것이 안전한 위임의 메커니즘이다.

- **Route → Gateway (자식이 부모를 지목)**: Route가 `parentRefs`로 "나는 이 Gateway(의 이 리스너)에 붙겠다"고 선언한다.
- **Gateway → Route (부모가 자식을 허용)**: Gateway의 리스너가 `allowedRoutes`로 "이런 네임스페이스/종류의 Route만 붙여라"고 허용한다.

> ★ **양방향 핸드셰이크**: Route가 붙겠다고 해도(`parentRefs`), Gateway가 허용(`allowedRoutes`)하지 않으면 붙지 않는다. 반대도 마찬가지. 그래서 **앱 팀이 마음대로 인프라 게이트웨이에 라우팅을 끼워 넣을 수 없다.** 플랫폼 팀(Gateway 소유자)이 통제권을 갖는다.

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web
  namespace: app
spec:
  parentRefs:
    - name: web-gateway
      namespace: gateway-system   # 다른 네임스페이스의 Gateway에 붙음
  hostnames:
    - "app.ggang.cloud"
  rules:
    - backendRefs:
        - name: web
          port: 80
```

### 3.5 ReferenceGrant — 네임스페이스 경계를 넘는 참조 허용

기본적으로 Gateway API는 **다른 네임스페이스의 리소스를 함부로 참조하지 못하게** 막는다(보안 기본값). 그런데 정당하게 경계를 넘어야 하는 경우가 있다. 예를 들어 **Route가 다른 네임스페이스의 Service를 backendRef로 가리키거나**, Gateway가 다른 네임스페이스의 TLS Secret을 쓰는 경우다.

이때 **참조당하는 쪽(대상 네임스페이스)** 에 **ReferenceGrant** 를 두어, "이 종류/네임스페이스에서 내 리소스를 참조해도 좋다"고 **명시적으로 허락**한다.

```yaml
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-app-to-backend
  namespace: backend          # ← 참조 "당하는" 쪽에 둔다
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: app          # app 네임스페이스의 HTTPRoute가
  to:
    - group: ""
      kind: Service           # 이 네임스페이스의 Service를 참조해도 OK
```

> ★★★ 면접 포인트: "왜 ReferenceGrant가 필요한가?" → **혼란된 대리자(confused deputy) 공격 방지**. ReferenceGrant가 없으면 임의의 네임스페이스 Route가 남의 Service/Secret을 마음대로 가리켜 트래픽을 빼돌릴 수 있다. **참조당하는 쪽이 명시적으로 허락해야만** 교차 네임스페이스 참조가 성립한다. 허락이 그쪽에 있다는 점(소유자가 통제)이 핵심이다.

## 4. Ingress 대비 — 정리표

| 항목 | Ingress | Gateway API |
|------|---------|-------------|
| 표현력 | 호스트/경로 + TLS 수준 | 헤더·메서드·쿼리 매칭, 가중치, 필터, 다중 프로토콜 |
| 고급 기능 구현 | **벤더 어노테이션**(비표준) | **typed 스펙 필드**(표준·검증됨) |
| 역할 분리 | 불가(한 리소스에 다 섞임) | **GatewayClass/Gateway/Route로 역할별 분리** |
| 교차 네임스페이스 | 사실상 미지원 | **ReferenceGrant**로 명시적 허용 |
| 프로토콜 | HTTP/HTTPS 중심 | HTTP/gRPC/TLS/TCP/UDP |
| 확장성 | 어노테이션으로 임시 확장 | **Policy Attachment** 등 표준 확장 모델 |
| 이식성 | 컨트롤러 종속 | 컨트롤러 바꿔도 Route 재사용 |

> ★ 한 문장 정리: **"Ingress의 어노테이션을 정식 타입 필드로 끌어올리고, 한 리소스에 뭉쳐 있던 것을 역할별 리소스로 쪼갠 것"** 이 Gateway API다.

## 5. 이 프로젝트에서의 위치

- **외부 트래픽 입구**: 사용자가 `*.ggang.cloud` 로 들어오면 **OCI NLB → Gateway(리스너 443, TLS Terminate) → HTTPRoute → Service** 순으로 흐른다.
- **TLS 인증서**: 리스너의 `certificateRefs`가 가리키는 Secret은 **cert-manager가 DNS-01 챌린지**로 자동 발급·갱신한다.
- **DNS**: Gateway/Service의 외부 주소는 **external-dns** 가 **Cloudflare** 에 레코드로 등록한다.
- **메시 연계**: Istio가 Gateway API를 구현하므로, 같은 GatewayClass/Gateway/Route 모델로 north-south(외부 진입)와 메시 정책을 일관되게 다룬다.

### 한 줄 요약
Gateway API는 **표현력 부족·어노테이션 난립·역할 분리 불가**라는 Ingress의 한계를 풀기 위해, 기능을 **typed 스펙**으로 표준화하고 리소스를 **역할별(GatewayClass=인프라/Gateway=운영/Route=앱)** 로 쪼갠 차세대 진입 API다. Gateway↔Route는 **parentRefs↔allowedRoutes 양방향 합의**로, 교차 네임스페이스 참조는 **ReferenceGrant**(참조당하는 쪽의 명시 허락)로 안전하게 통제한다.

### 참고 (공식 문서)
- Gateway API 개요: https://gateway-api.sigs.k8s.io/
- API 개념/리소스 모델: https://gateway-api.sigs.k8s.io/concepts/api-overview/
- 역할과 페르소나: https://gateway-api.sigs.k8s.io/concepts/roles-and-personas/
- 보안 모델(ReferenceGrant): https://gateway-api.sigs.k8s.io/concepts/security-model/
- Gateway / GatewayClass: https://gateway-api.sigs.k8s.io/api-types/gateway/
- Ingress 마이그레이션: https://gateway-api.sigs.k8s.io/guides/migrating-from-ingress/
