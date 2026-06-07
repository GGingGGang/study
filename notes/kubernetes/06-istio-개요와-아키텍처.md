# Istio 개요와 아키텍처 (Istio Overview & Architecture)

> 쿠버네티스 · Istio · 학습내용: 서비스 메시란 무엇이고 왜 필요한가, 컨트롤플레인(istiod)과 데이터플레인(Envoy/ztunnel)의 역할, 사이드카 모드와 Ambient 모드(ztunnel + waypoint)의 비교, xDS를 통한 설정 전달 흐름, 주요 CRD, 설치 개요

---

이 문서는 우리 프로젝트가 채택한 **Istio Ambient 모드**(ztunnel + waypoint)를 기준으로 서비스 메시의 전체 그림을 잡는다. 사이드카(sidecar) 모드는 비교·이해를 돕기 위한 대조군으로만 다룬다. 외부 노출은 Gateway API 기반으로 OCI NLB(네트워크 로드밸런서)를 거쳐 도메인 `ggang.cloud` 로 들어온다.

## 1. 서비스 메시란 무엇인가 — 왜 필요한가

**서비스 메시(service mesh)** 는 마이크로서비스 사이의 **서비스-투-서비스 통신**을 처리하는 전용 인프라 계층이다. 핵심 아이디어는 트래픽 제어·보안·관측 같은 **횡단 관심사(cross-cutting concern)** 를 애플리케이션 코드에서 떼어내 플랫폼이 일괄로 책임지는 것이다.

MSA로 서비스를 쪼개면 다음 문제들이 **모든 서비스에서 반복**된다.

- **트래픽 관리**: 재시도(retry), 타임아웃, 서킷 브레이커, 카나리 배포, 로드밸런싱.
- **보안**: 서비스 간 통신 암호화(mTLS), 신원 기반 인가, 인증서 발급·회전.
- **관측성(observability)**: 요청 수·지연·에러율 메트릭, 분산 트레이싱, 액세스 로그.

이걸 서비스마다 라이브러리로 직접 구현하면 ① 언어/프레임워크마다 다시 짜야 하고(polyglot 문제) ② 버전이 제각각이 되며 ③ 비즈니스 로직과 인프라 로직이 뒤섞인다.

> ★★★ **핵심**: 서비스 메시는 이 횡단 관심사를 **애플리케이션 바깥의 프록시 계층**으로 옮긴다. 개발자는 비즈니스 로직만 짜고, mTLS·재시도·트래픽 분할·메트릭은 메시가 **코드 변경 없이** 제공한다. "라이브러리가 아니라 인프라로 해결한다"가 한 문장 요지다.

### 1.1 데이터플레인 / 컨트롤플레인 분리

서비스 메시는 SDN과 같은 **control plane / data plane 분리** 철학을 따른다.

- **데이터플레인(data plane)**: 실제 패킷을 가로채 정책대로 처리(프록시). 사이드카 모드는 **Envoy**, Ambient 모드는 노드의 **ztunnel** + 필요 시 **waypoint(Envoy)**.
- **컨트롤플레인(control plane)**: 데이터플레인을 **설정·제어**하는 두뇌 = **istiod**. 직접 트래픽을 나르지는 않는다.

## 2. 컨트롤플레인 — istiod

**istiod** 는 Istio의 컨트롤플레인을 하나의 바이너리로 묶은 컴포넌트다(과거 Pilot/Citadel/Galley가 합쳐졌다). 주요 역할 세 가지만 기억하면 된다.

| 역할 | 내용 | 옛 컴포넌트 |
|------|------|------------|
| **설정 배포(Pilot)** | VirtualService 등 CRD와 쿠버네티스 서비스/엔드포인트를 읽어 **Envoy/ztunnel용 설정으로 변환**, xDS로 푸시 | Pilot |
| **인증서 발급(CA)** | 각 워크로드에 **SPIFFE 신원**을 담은 인증서(SVID)를 발급·회전 (mTLS의 뿌리) | Citadel |
| **설정 검증/변환** | CRD 스키마 검증(validating webhook), 사이드카 모드에서는 **자동 주입**(mutating webhook) | Galley |

> ★ 면접 포인트: "istiod가 무엇을 하나?" → ① 설정을 Envoy 언어(xDS)로 변환·배포 ② 워크로드 인증서(CA) 발급·회전 ③ 설정 검증. **트래픽은 직접 처리하지 않는다**(데이터플레인의 일). 컨트롤플레인이 잠깐 죽어도 이미 배포된 설정으로 데이터플레인은 계속 돈다(graceful degradation).

## 3. 데이터플레인 — Envoy와 ztunnel

**Envoy** 는 C++로 작성한 고성능 L7 프록시로, Istio 데이터플레인의 핵심 엔진이다. 동적 설정을 받는 표준 API가 **xDS**다.

- **사이드카 모드**: 파드마다 Envoy 컨테이너가 함께 뜨고, iptables로 파드의 모든 인바운드/아웃바운드 트래픽을 가로챈다.
- **Ambient 모드**: 노드마다 **ztunnel**(Rust 작성 경량 데몬)이 L4 mTLS만 담당하고, L7 정책이 필요할 때만 **waypoint 프록시(Envoy)** 를 따로 둔다.

## 4. 사이드카 모드 vs Ambient 모드

Istio는 두 가지 데이터플레인 모드를 제공한다. 우리 프로젝트는 **Ambient 모드**를 사용한다.

| 구분 | 사이드카(Sidecar) | **Ambient(우리 선택)** |
|------|-------------------|------------------------|
| 프록시 배치 | **파드마다 Envoy 1개** | 노드마다 **ztunnel**(L4), 필요 시 **waypoint**(L7) |
| 리소스 비용 | 파드 수 × Envoy (높음) | 노드 수 × ztunnel (낮음) |
| 트래픽 가로채기 | 파드 내 iptables 리다이렉트 | 노드 레벨에서 ztunnel로 리다이렉트 |
| L4(mTLS/암호화) | Envoy가 처리 | **ztunnel**이 처리(HBONE 터널) |
| L7(라우팅/인가/리트라이) | Envoy가 처리 | **waypoint**가 처리(필요한 NS/서비스에만) |
| 메시 편입 | 파드에 사이드카 주입 + 재시작 필요 | 네임스페이스 라벨만 추가, **재시작 불필요** |
| 적용 단위 | 파드 단위 | L4는 전 워크로드, L7은 선택적 |
| 적합성 | 세밀한 per-pod 제어 | 비용 효율 + 점진 도입 |

```
[Ambient 데이터 경로]

  소스 파드
     │ (평문)
     ▼
  ztunnel(소스 노드)  ──HBONE(mTLS L4)──►  ztunnel(목적 노드)
     │                                          │
     │  (L7 정책 필요 시)                         ▼
     └──────────►  waypoint(Envoy, L7) ────►  목적 파드
```

> ★★★ **핵심**: Ambient의 핵심은 **L4와 L7의 분리**다. 암호화·신원 확인 같은 **L4 기본기는 ztunnel이 노드 단위로 항상** 제공하고, 라우팅·인가·리트라이 같은 **L7 기능은 waypoint를 둔 곳에서만** 적용한다. 그래서 "일단 모든 통신을 mTLS로 안전하게(저비용), 고급 기능은 필요한 곳에만(점진적)"이 가능하다.

### 4.1 HBONE이란

**HBONE(HTTP-Based Overlay Network Environment)** 은 ztunnel이 노드 간 트래픽을 실어 나르는 터널 방식이다. **mTLS로 보호된 HTTP/2 CONNECT** 위에 원래 트래픽을 캡슐화해 보낸다. ztunnel끼리는 HBONE 터널을 열어 L4 트래픽을 암호화·식별하며 전달한다.

## 5. xDS — 설정 전달 흐름

**xDS** 는 컨트롤플레인이 데이터플레인 프록시를 동적으로 설정하는 API 집합이다(Envoy 표준). 주요 서브-API는 아래와 같다.

| xDS | 풀네임 | 무엇을 설정 |
|------|--------|------------|
| **LDS** | Listener Discovery | 리스너(포트/필터 체인) |
| **RDS** | Route Discovery | HTTP 라우팅 규칙 |
| **CDS** | Cluster Discovery | 업스트림 클러스터(목적 서비스 집합) |
| **EDS** | Endpoint Discovery | 클러스터의 실제 엔드포인트(파드 IP) |
| **SDS** | Secret Discovery | TLS 인증서/키 |

설정 전달 흐름:

```
사용자가 CRD 적용 (kubectl apply VirtualService 등)
        │
        ▼
   istiod 가 감지 → 쿠버네티스 서비스/엔드포인트와 합쳐 변환
        │
        ▼
   xDS(gRPC 스트림)로 데이터플레인에 푸시
        │
        ├─ 사이드카 모드 → 각 Envoy
        └─ Ambient 모드 → ztunnel / waypoint
        │
        ▼
   프록시가 즉시 적용 (파드 재시작 없음)
```

> ★ 면접 포인트: "Istio 설정은 어떻게 프록시까지 가나?" → istiod가 CRD+쿠버네티스 상태를 합쳐 변환한 뒤 **xDS(gRPC) 스트림으로 푸시**한다. 폴링이 아니라 **푸시 기반**이라 변경이 빠르게 반영되고, 파드 재시작이 필요 없다.

## 6. 주요 CRD

Istio는 쿠버네티스 CRD(Custom Resource Definition)로 정책을 선언한다. 자세한 사용법은 트래픽/보안 문서에서 다루고, 여기서는 전체 지도를 잡는다.

| CRD | 분류 | 역할 |
|------|------|------|
| **VirtualService** | 트래픽 | 라우팅 규칙(가중치 분할·헤더 매칭·타임아웃·리트라이·폴트 인젝션) |
| **DestinationRule** | 트래픽 | 목적지 정책(서브셋 정의·로드밸런싱·서킷 브레이커·TLS) |
| **Gateway** | 트래픽 | 메시 경계의 L4~L6 진입/출구 포트·프로토콜·TLS |
| **ServiceEntry** | 트래픽 | 메시 외부 서비스를 내부 레지스트리에 등록 |
| **Sidecar** | 트래픽 | (사이드카 모드) 프록시가 보는 서비스 범위 제한 |
| **PeerAuthentication** | 보안 | 워크로드 간 mTLS 모드(STRICT/PERMISSIVE/DISABLE) |
| **AuthorizationPolicy** | 보안 | 신원·속성 기반 접근 인가(ALLOW/DENY/AUDIT/CUSTOM) |
| **RequestAuthentication** | 보안 | 최종 사용자 JWT 검증 |
| **Telemetry** | 관측 | 메트릭·트레이싱·액세스 로그 동작 제어 |
| **WasmPlugin** | 확장 | WebAssembly 기반 데이터플레인 확장 |

> ★ Gateway 리소스에는 두 가지 계보가 있다. 전통적 Istio **Gateway** CRD와, 쿠버네티스 표준인 **Gateway API**(Gateway/HTTPRoute 등)다. 우리 프로젝트는 외부 노출에 **Gateway API**를 쓰고, 그 트래픽이 OCI NLB를 거쳐 `ggang.cloud` 로 들어온다. 둘은 같은 데이터플레인을 설정하는 서로 다른 선언 방식이다.

## 7. 설치 개요

Istio 설치 방법은 크게 두 가지다.

### 7.1 istioctl (권장)

```bash
# 1) istioctl 다운로드 후 프로파일로 설치 (ambient 프로파일)
istioctl install --set profile=ambient -y

# 2) 설치 검증
istioctl verify-install

# 3) 네임스페이스를 Ambient 메시에 편입 (사이드카 주입과 달리 재시작 불필요)
kubectl label namespace my-app istio.io/dataplane-mode=ambient
```

> ★ Ambient 모드 편입은 사이드카처럼 `istio-injection=enabled` 라벨로 파드를 다시 만드는 게 아니라 `istio.io/dataplane-mode=ambient` 라벨만 붙이면 된다. 기존 파드를 **재시작하지 않고** 메시에 들어온다.

### 7.2 Helm

```bash
# base(CRD/클러스터 권한) → istiod(컨트롤플레인) → ztunnel/cni 순서로 설치
helm install istio-base istio/base -n istio-system --create-namespace
helm install istiod istio/istiod -n istio-system --set profile=ambient
helm install istio-cni istio/cni -n istio-system --set profile=ambient
helm install ztunnel istio/ztunnel -n istio-system
```

| 방법 | 장점 | 단점 |
|------|------|------|
| **istioctl** | 검증·업그레이드 명령 내장, 프로파일 간단 | 별도 바이너리 관리 |
| **Helm** | GitOps/CI 파이프라인과 통합 쉬움, 세밀한 values 제어 | 컴포넌트 설치 순서 직접 관리 |

> ★ 면접 포인트: "Ambient를 쓰려면 무엇이 필요한가?" → istiod + **istio-cni**(트래픽을 ztunnel로 리다이렉트) + **ztunnel**(L4 데이터플레인), L7이 필요하면 **waypoint**를 별도 배포. 사이드카 모드의 사이드카 주입 webhook은 Ambient에서 쓰지 않는다.

### 한 줄 요약
Istio는 서비스 간 통신의 트래픽·보안·관측을 애플리케이션 밖 프록시 계층으로 분리하는 서비스 메시로, 두뇌인 **istiod**(설정 변환·인증서 발급·검증)가 **xDS**로 데이터플레인을 설정한다. 우리는 **Ambient 모드**를 써서 노드의 **ztunnel**이 L4 mTLS를, 필요한 곳의 **waypoint**가 L7 정책을 맡으며, 외부 노출은 Gateway API + OCI NLB로 `ggang.cloud` 에 연결한다.

### 참고 (공식 문서)
- Istio 개요: https://istio.io/latest/docs/overview/what-is-istio/
- 데이터플레인 모드(사이드카/Ambient): https://istio.io/latest/docs/overview/dataplane-modes/
- Ambient 아키텍처: https://istio.io/latest/docs/ambient/architecture/
- istiod / 아키텍처: https://istio.io/latest/docs/ops/deployment/architecture/
- istioctl로 설치: https://istio.io/latest/docs/setup/install/istioctl/
- Helm으로 설치: https://istio.io/latest/docs/setup/install/helm/
