# Kiali (Kiali)

> 쿠버네티스 · 인프라/옵저버빌리티 · 학습내용: 서비스 메시 콘솔의 역할, 메시 토폴로지 그래프, 메시 텔레메트리 기반 헬스·메트릭, Istio 설정 검증(validation), 트래픽 라우팅 UI, 트레이싱 연계와 의존성

---

## 1. Kiali가 뭐고 왜 쓰나

**Kiali**는 **Istio 서비스 메시를 위한 관리·관측 콘솔(웹 UI)**이다. 메시 안에서 **서비스들이 어떻게 연결되어 트래픽이 흐르는지, 무엇이 건강한지, Istio 설정이 올바른지**를 한 화면에서 보여 준다.

서비스 메시를 쓰면 서비스 간 통신·라우팅·보안(mTLS)을 사이드카/프록시가 처리하는데, 이게 **YAML 설정으로만 흩어져 있으면 전체 그림을 파악하기 어렵다.** Kiali는 메시의 상태를 **시각화**하고, **잘못된 Istio 설정을 검증**하며, 일부 트래픽 정책은 UI에서 바로 만질 수 있게 해 준다.

> Kiali는 메시 자체를 만들거나 트래픽을 직접 처리하지 않는다. **Istio가 만든 메시 위에서 "보고 검증하는" 콘솔**이다.

## 2. 메시 토폴로지 그래프

Kiali의 대표 기능. 메시 안 **서비스·워크로드·앱을 노드로, 그들 사이 실제 트래픽을 엣지로** 그린 실시간 그래프다.

- 노드 간 **요청률(RPS)·에러율·응답시간**을 엣지에 표시 → 어디서 트래픽이 막히고 에러가 나는지 한눈에 파악한다.
- 그래프 종류를 앱/서비스/워크로드 단위로 전환할 수 있다.
- **mTLS 적용 여부**, 트래픽 흐름 방향, 비정상 노드(빨강) 등을 색·아이콘으로 나타낸다.

★ "마이크로서비스 호출 관계와 병목을 어떻게 보나?" → Kiali 토폴로지 그래프로 **실측 트래픽 기반의 의존 관계와 에러 지점**을 본다.

## 3. 헬스 · 메트릭 (메시 텔레메트리 기반)

Kiali가 보여 주는 헬스·메트릭은 **자체 수집이 아니라 메시가 만든 텔레메트리(주로 Prometheus 메트릭)에 기댄다.** ★★★

- Istio의 사이드카/프록시(Envoy, Ambient에선 ztunnel/waypoint)가 트래픽 메트릭을 만든다 → **Prometheus가 수집** → **Kiali가 그걸 질의**해 그래프·헬스로 보여 준다.
- 따라서 **Prometheus가 없거나 메트릭이 안 쌓이면 Kiali 그래프·헬스가 비어 보인다.** → 면접·실무 단골 함정.
- 헬스는 에러율·요청 성공률 등을 종합해 앱/서비스/워크로드별 상태(정상/경고/장애)로 요약.

## 4. Istio 설정 검증 (Validation)

Kiali는 클러스터의 **Istio 리소스(VirtualService·DestinationRule·Gateway·PeerAuthentication 등)를 분석해 잘못된 설정을 경고**한다.

- 예: VirtualService가 **존재하지 않는 host/subset을 가리킴**, DestinationRule subset 누락, 라우팅 가중치 합이 100이 아님, 충돌하는 정책 등.
- UI에서 문제 리소스에 **경고 아이콘**과 설명을 붙여 보여 주므로, 적용 전후로 설정 오류를 빨리 잡는다. ★

> 이 검증 기능 덕분에 Istio YAML을 손으로 쓰다 흔히 내는 "타입은 맞지만 의미가 틀린" 오류를 잡아낸다.

## 5. 트래픽 라우팅 UI

Kiali는 일부 Istio 트래픽 정책을 **UI에서 직접 생성·수정**할 수 있는 마법사를 제공한다.

- **가중치 기반 라우팅**(예: v1 90% / v2 10% 카나리), 요청 매칭 라우팅, 타임아웃·재시도, 폴트 인젝션, mTLS 정책 등을 폼으로 설정 → 내부적으로 VirtualService/DestinationRule을 생성.
- 빠른 실험에는 편하지만, **운영에선 GitOps로 YAML을 버전관리**하는 게 정석이다(Kiali UI 변경은 클러스터에 직접 적용됨).

## 6. 트레이싱 연계

Kiali는 분산 트레이싱 백엔드(**Jaeger/Tempo** 등)와 연동해, 그래프·서비스에서 **해당 구간의 트레이스로 바로 점프**한다. 메트릭(어디가 느린가) → 트레이스(왜 느린가)로 파고드는 흐름을 잇는다.

## 7. Istio Ambient 메모

프로젝트는 **Istio Ambient 모드**(사이드카 없이 노드의 `ztunnel` + 필요 시 `waypoint` 프록시로 메시 구현)를 쓴다. Kiali는 Ambient 환경의 토폴로지·메트릭도 지원하지만, **표시되는 헬스·그래프는 결국 ztunnel/waypoint가 만들어 Prometheus에 쌓은 텔레메트리에 의존**한다는 원칙은 동일하다.

## 8. 의존 관계 요약

```
Istio(사이드카/ztunnel) --메트릭--> Prometheus --질의--> Kiali UI(그래프·헬스)
                                   트레이스 --> Jaeger/Tempo --연계--> Kiali
```

★ Kiali는 **독립 모니터링 도구가 아니라 "메시 텔레메트리의 프런트엔드"**다. Istio + Prometheus(+트레이싱)가 갖춰져야 제 기능을 한다.

### 한 줄 요약
Kiali는 **Istio 서비스 메시를 시각화·검증하는 콘솔**로, **실측 트래픽 기반 토폴로지 그래프**, **메시 텔레메트리(주로 Prometheus) 기반 헬스·메트릭**, **Istio 설정 검증**, **트래픽 라우팅 UI**, **트레이싱 연계**를 제공한다. 핵심은 Kiali가 데이터를 직접 만들지 않고 **Istio가 만든 텔레메트리에 의존**한다는 점이다.

### 참고 (공식 문서)
- Kiali 개요(What is Kiali): https://kiali.io/docs/
- 토폴로지 그래프: https://kiali.io/docs/features/topology/
- 설정 검증(Validations): https://kiali.io/docs/features/validations/
- 메트릭·헬스: https://kiali.io/docs/features/details/
- Istio 통합(전제 조건): https://kiali.io/docs/configuration/
