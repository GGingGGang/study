# Kiali

## 1. Why — 왜 쓰는가

Istio 전용 관측 UI. service mesh의 트래픽 토폴로지 + mTLS 상태 + 정책 효과를 시각화.

**Istio만으로는 부족한 이유**:
- istioctl 명령으로는 정보가 텍스트로만 나옴
- "어느 service가 어느 service를 호출하는지" 그래프로 못 봄
- mTLS 상태(어느 호출이 암호화됐는지) 확인이 복잡
- AuthorizationPolicy가 실제로 효과 있는지 즉시 검증 어려움

**Kiali의 해결**:
- 트래픽 그래프 (service ↔ service 호출 + RPS + 에러율 + latency를 노드/엣지로 시각화)
- mTLS 상태 색상 표시 (암호화/평문/혼합)
- Istio CR 검증 (VirtualService, AuthorizationPolicy 등 구성 오류 즉시 발견)
- Prometheus 메트릭 기반 (Istio 자체 메트릭 활용)

**대체재**:
- **istioctl + 직접 PromQL**: 가능하나 시각화 부족
- **Grafana + Istio 대시보드**: 메트릭은 보이나 토폴로지 그래프 없음
- **commercial APM** (Datadog, New Relic): service map 있으나 비용 + SaaS
- **Kiali**: Istio 공식 도구. 무료. 시각화 강력.

## 2. Architecture — 어떻게 구성되는가

**단일 Deployment**. `kiali-server` Pod 하나.

**의존성**:
- **Prometheus** (필수): Istio 메트릭 수집 → Kiali가 PromQL로 조회해서 트래픽 그래프 그림
- **Istio**: control plane API와 통신해서 CR 정보 가져옴
- **Grafana** (선택): jump 링크
- **Tracing backend** (선택, Tempo/Jaeger): trace jump 링크

**핵심 기능**:
- **Graph**: namespace/app별 트래픽 토폴로지 (실시간)
- **Workloads / Services / Applications**: 리소스 목록 + 상세
- **Istio Config**: VirtualService, DestinationRule, Gateway, AuthorizationPolicy 등 CR 보기 + 검증
- **Mesh**: 전체 mesh 토폴로지

## 3. Mechanism — 어떻게 돌아가는가

**트래픽 그래프 생성**:

1. Istio sidecar/ztunnel/waypoint가 매 요청마다 `istio_requests_total`, `istio_request_duration_milliseconds` 같은 메트릭 생성
2. Prometheus가 scrape
3. Kiali UI 접속 시 사용자가 namespace 선택
4. Kiali가 Prometheus에 PromQL 쿼리:
   - `sum by (source_workload, destination_workload) (rate(istio_requests_total{...}[1m]))`
5. 응답을 노드(workload) + 엣지(호출 관계 + RPS)로 변환
6. mTLS 상태도 메트릭(`security_policy`)에서 추출
7. D3.js 기반 그래프 렌더링

**Istio config 검증**:
- Kiali가 Istio API에서 모든 CR 가져옴
- 내장 validator로 검증 (예: VirtualService가 존재하지 않는 host 가리킴, AuthorizationPolicy가 모든 트래픽 차단 등)
- UI에 경고 표시

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Kiali 의존 관계.

- **Prometheus** (kube-prometheus-stack) — 필수 DataSource
- **Istio** — control plane API 호출
- **Grafana** — jump 링크 (선택)
- **Tempo** — trace jump 링크 (선택)
- **Gateway API (HTTPRoute + Gateway)** — UI 외부 노출

**왜 Phase 2 → Phase 4로 이동했나**: Phase 2 시점에는 Prometheus가 없어서 Kiali가 트래픽 그래프 생성 불가. 메트릭 없으면 모든 노드가 비어있는 상태로 표시됨. Phase 4에서 Prometheus 설치 직후 Kiali 추가하는 게 정합.

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install kiali-server kiali/kiali-server \
  --namespace istio-system \
  --version 2.x \
  -f kiali-values.yaml
```

kiali-values.yaml:
```yaml
auth:
  strategy: token              # 또는 openshift, openid (GitHub OAuth 등)

deployment:
  ingress:
    enabled: false             # HTTPRoute로 별도 노출

external_services:
  prometheus:
    url: http://prometheus-operated.monitoring.svc:9090
    
  grafana:
    enabled: true
    in_cluster_url: http://prometheus-grafana.monitoring.svc:80
    external_url: https://grafana.ggang.cloud
    auth:
      type: basic
      username: admin
      password: <vault-injected>
  
  tracing:
    enabled: true
    provider: tempo
    in_cluster_url: http://tempo.monitoring.svc:3100
    
  istio:
    config_map_name: istio
    istiod_deployment_name: istiod

server:
  port: 20001

resources:
  requests: { cpu: 100m, memory: 200Mi }
  limits: { cpu: 500m, memory: 400Mi }
```

**HTTPRoute로 노출**:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: kiali
  namespace: istio-system
spec:
  parentRefs:
  - name: app-gateway
  hostnames:
  - kiali.ggang.cloud
  rules:
  - matches:
    - path:
        type: PathPrefix
        value: /
    backendRefs:
    - name: kiali
      port: 20001
```

**Token 기반 로그인** (간단):
```bash
# ServiceAccount token 생성
kubectl create serviceaccount kiali-user -n istio-system
kubectl create clusterrolebinding kiali-user-admin \
  --clusterrole=kiali \
  --serviceaccount=istio-system:kiali-user

kubectl create token kiali-user -n istio-system
# 출력된 token으로 UI 로그인
```

**검증**:
- Kiali UI 접속 → Graph → namespace 선택
- 트래픽이 있어야 그래프가 보임 → 없으면 curl로 요청 발생시키기
- mTLS 상태: 그래프 엣지가 자물쇠 아이콘이면 mTLS 적용 중

## 6. Configuration — 어떤 설정이 있는가

**Auth strategy**:
- `anonymous`: 인증 없음 (dev only)
- `token`: ServiceAccount token (단순)
- `openid`: OIDC (GitHub, Google 등)
- `header`: 프록시 인증 헤더

**Graph display 옵션**:
- `namespace`: 한 NS만 vs 여러 NS
- `traffic`: requests/sec, bytes, latency
- `node graph`: workload / service / app
- `edge labels`: error rate, latency

**Validation 룰**:
- Kiali 내장 validator가 모든 Istio CR 자동 검사
- 검증 비활성 옵션 없음 (default on)

**대시보드**:
- Kiali 자체 대시보드 — workload별 메트릭
- Grafana 대시보드 jump 옵션

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Istio 1.20+** (2026-05 권장: Istio 1.24+)
- **Kiali 2.x+** (Istio 1.24 호환)
- **Prometheus 2.x ~ 3.x**
- **Grafana 10+** (jump 링크용)
- **Kubernetes 1.27+**

Istio와 Kiali 버전은 매우 밀접 — Kiali 공식 호환성 매트릭스 확인 필수. 본 프로젝트 Istio 1.24 + Kiali 2.x 조합.

## 8. 면접 예상 질문 & 답변

**Q1. Kiali가 왜 필요해요? Grafana 대시보드로 충분하지 않나요?**
> Grafana 대시보드는 메트릭을 차트로 보여주지만 **service간 호출 관계 토폴로지**는 못 그립니다. Kiali는 Istio 메트릭의 source_workload, destination_workload label을 보고 노드(service)와 엣지(호출)로 변환한 그래프를 실시간으로 그립니다. "어느 service가 어느 service를 부르고 있나"가 한눈에 보이고, mTLS 상태(자물쇠 아이콘)도 동시에 표시되어 보안 정책 검증이 즉시 됩니다. 또 Istio CR 검증(예: AuthorizationPolicy 오류) UI를 제공해서 istioctl 텍스트 출력보다 디버깅이 빠릅니다.

**Q2. Kiali를 Phase 2에서 안 만들고 Phase 4로 미룬 이유는?**
> Kiali의 핵심 기능(트래픽 그래프, 메트릭)이 **Prometheus 의존**입니다. Phase 2 시점에는 kube-prometheus-stack이 없어서 메트릭이 없고, Kiali UI를 띄워도 모든 노드가 비어있는 상태로 보입니다. Phase 4에서 Prometheus 설치 직후 Kiali 추가하는 게 의존성 측면에서 정합니다. Phase 2의 Istio 설치 검증은 `istioctl analyze`, `istioctl proxy-status` 같은 CLI 도구로 대체합니다.

**Q3. Kiali와 Grafana Istio 대시보드 차이는요?**
> Grafana Istio 대시보드는 미리 정의된 차트(RPS, latency, error rate)를 시간축으로 보여줍니다. Kiali는 **실시간 토폴로지** + 메트릭 + Istio CR 통합 뷰입니다. 둘은 보완 관계라 본 프로젝트는 둘 다 씁니다. 일상 모니터링은 Grafana, mesh 디버깅(특히 새 서비스 추가나 정책 변경 시)은 Kiali로 갑니다. Grafana는 시간 축, Kiali는 공간 축이라고 비유 가능합니다.

**Q4. Kiali에서 mTLS 상태가 어떻게 보여요?**
> 트래픽 그래프의 엣지에 자물쇠 아이콘이 표시됩니다. (1) 잠긴 자물쇠: mTLS로 암호화. (2) 열린 자물쇠: 평문. (3) 자물쇠 위에 슬래시: 일부 mTLS, 일부 평문 (PERMISSIVE 모드 영향). (4) 자물쇠 없음: 트래픽 정보 없음 (Istio sidecar/ztunnel 미주입). 본 프로젝트는 STRICT 모드로 전환하면 모든 엣지가 잠긴 자물쇠가 되어야 정상이고, 아니면 mesh 가입 안 된 namespace 있다는 신호입니다.

**Q5. Kiali가 죽으면 영향은?**
> 트래픽 그래프 시각화만 사라지고 실제 서비스 mesh는 정상 동작합니다. Kiali는 read-only UI라 Istio 정책에 영향 없습니다. 운영 디버깅이 어려워지므로 Prometheus 알람으로 Kiali Pod 다운 감지하지만, critical 알람은 아닙니다. Kiali 자체는 stateless라 재기동만으로 회복됩니다.

**Q6. AuthorizationPolicy를 만들었는데 효과가 있는지 어떻게 확인해요?**
> Kiali가 가장 빠른 방법입니다. (1) AuthorizationPolicy 적용 전 트래픽 그래프 캡처, (2) 정책 적용 후 그래프에서 차단된 엣지가 빨간색으로 표시되고 RPS가 0이 되거나 4xx로 바뀜, (3) Kiali UI의 Workload 상세에서 inbound 트래픽 거부 metric 확인. Prometheus PromQL로도 `istio_requests_total{response_code="403"}` 메트릭 보면 알 수 있지만 그래프가 직관적입니다.

**Q7. Kiali UI 인증은 어떻게 해요?**
> 본 프로젝트는 token strategy로 시작하고 OIDC SSO로 확장 가능합니다. token은 ServiceAccount token을 생성해서 UI 로그인 시 입력하는 방식이라 단순하나, 운영 환경에서는 GitHub OAuth(OIDC) 같은 SSO로 사용자별 인증이 표준입니다. Kiali RBAC는 ClusterRole `kiali` 또는 `kiali-viewer`로 권한 분리하고, 사용자별로 SA를 다르게 매핑합니다. 면접에서 가산점 영역입니다.

**Q8. Kiali의 Istio config validation은 어떤 오류를 잡나요?**
> 흔한 오류 5가지: (1) VirtualService가 존재하지 않는 host를 가리킴, (2) DestinationRule subset이 Service 뒤 Pod에 없음, (3) AuthorizationPolicy가 모든 트래픽을 차단(action: DENY + 매칭되는 from 없음), (4) PeerAuthentication STRICT인데 sidecar 미주입 Pod 존재, (5) Gateway가 참조하는 Secret이 없음(인증서 미발급). Kiali UI의 Istio Config 페이지에 빨간 X로 표시되고 클릭하면 상세 설명이 나옵니다. istioctl analyze와 비슷한 기능이나 UI라 더 직관적입니다.

**Q9. Kiali가 Prometheus에 부담을 주나요?**
> 약간 줍니다. Kiali UI가 열려있는 동안 PromQL을 주기적으로 실행(1분 단위 default)하므로 트래픽 그래프 갱신마다 5-10개 쿼리가 발생합니다. 본 프로젝트는 트래픽이 작아서 부담 없지만, 대규모 환경에서는 (1) 그래프 갱신 주기를 길게 설정, (2) Kiali 자체 caching 사용, (3) Prometheus의 query timeout 설정으로 보호합니다.

**Q10. Kiali로 보이는 정보 중 가장 자주 보는 게 뭐예요?**
> 본 프로젝트 운영 시 자주 보는 3가지: (1) Graph 페이지에서 트래픽이 정상적으로 흐르는지 확인 + mTLS 자물쇠 상태, (2) Workload 페이지에서 특정 서비스의 inbound/outbound 트래픽 + 에러율, (3) Istio Config 페이지에서 정책 변경 후 검증 오류 확인. 디버깅 시 가장 강력한 도구는 Graph의 시간 범위 조정 + filter (예: 5xx만)로 문제 패턴을 시각적으로 추적하는 것입니다.
