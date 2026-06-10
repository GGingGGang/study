# external-dns

## 1. Why — 왜 쓰는가

Kubernetes 리소스(Service, Ingress, Gateway, HTTPRoute)의 hostname을 보고 DNS 제공자(Cloudflare, Route53 등)에 자동으로 DNS 레코드를 생성/갱신/삭제하는 컨트롤러다.

**수동 DNS 관리의 문제**: LB IP가 바뀌거나 새 hostname을 추가할 때마다 DNS 콘솔에서 수동 수정. 환경이 늘어나면 누락 사고가 잦다.

**external-dns의 해결**: Kubernetes 리소스가 source of truth가 됨. `HTTPRoute`에 `login.ggang.cloud` 적으면 Cloudflare A 레코드가 자동 생성, LB IP 변경 시 자동 업데이트, 리소스 삭제 시 DNS도 자동 정리.

**대체재**:
- 수동: 운영 부담 크고 누락 위험
- CoreDNS Custom plugin: 내부 DNS만, 외부 트래픽 처리 불가
- Cloudflare Operator: Cloudflare 종속, 다른 provider 불가
- external-dns: 다양한 provider 지원 + Kubernetes-native + 표준

## 2. Architecture — 어떻게 구성되는가

단일 controller deployment로 구성. 멀티 인스턴스는 leader election 또는 namespace 분할로 운영.

**Source**: 어떤 k8s 리소스를 watch할지
- `service`: LoadBalancer/NodePort Service의 hostname annotation
- `ingress`: Ingress 리소스
- `gateway-httproute`, `gateway-grpcroute`, `gateway-tlsroute`: Gateway API 리소스 (v0.14+)
- `crd`: 커스텀 DNSEndpoint CRD

**Provider**: DNS 제공자
- `cloudflare`: 본 프로젝트 사용
- `aws` (Route53), `google`, `azure`, `digitalocean`, ...

**Registry**: external-dns가 자기가 만든 레코드를 추적하는 방식
- `txt` (default): 각 레코드에 TXT 레코드를 함께 생성해서 "내가 만든 것" 표시
- `noop`: 추적 없음 (위험, 다른 도구의 레코드도 건드릴 수 있음)
- `dynamodb`, `aws-sd`: AWS 특화

## 3. Mechanism — 어떻게 돌아가는가

1. external-dns가 k8s API를 polling 또는 watch (default 1분)
2. 설정한 source(예: `gateway-httproute`)에서 hostname 추출
3. Provider에 현재 DNS 레코드 조회
4. 차이점 계산: 만들어야 할 레코드, 업데이트할 레코드, 삭제할 레코드
5. Provider API 호출로 변경 적용
6. 각 레코드에 TXT 레코드 추가 (`heritage=external-dns,external-dns/owner=<owner-id>`)

**TXT registry의 역할**: external-dns가 같은 zone에 다른 사람(수동 또는 다른 도구)이 만든 레코드를 건드리지 않기 위해 자기가 만든 것만 추적. `owner-id`가 다르면 무시.

**Gateway API 통합** (v0.14+):
- `--source=gateway-httproute` 활성화
- HTTPRoute의 `spec.hostnames` 읽기
- 연결된 Gateway의 LoadBalancer Service IP 또는 hostname 추출
- A 레코드 또는 CNAME 생성

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 external-dns 의존 관계.

- **Cloudflare** — `ggang.cloud` zone 관리, API token으로 인증
- **Gateway API HTTPRoute** — hostname을 source로 사용
- **OCI LB** — LB의 외부 IP를 A 레코드로 등록
- **cert-manager와 token 분리** — 같은 Cloudflare token 재사용 가능하나 권한 분리 권장(external-dns용 token, cert-manager용 token 별도)

**Cloudflare API token 권한**:
- `Zone:Zone:Read`: zone 정보 조회
- `Zone:DNS:Edit`: 레코드 추가/수정/삭제
- **Zone scope: `ggang.cloud`만** (전체 account 권한 token 금지 — 사고 시 폭발 반경 큼)

## 5. Usage — 어떻게 쓰는가

**Cloudflare token Secret**:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: external-dns
type: Opaque
stringData:
  api-token: "<Zone:DNS:Edit + Zone:Zone:Read, scope: ggang.cloud>"
```

**Helm 설치**:

```bash
helm install external-dns external-dns/external-dns \
  --namespace external-dns --create-namespace \
  --set provider=cloudflare \
  --set sources={service,gateway-httproute} \
  --set txtOwnerId=oci-cluster-1 \
  --set domainFilters={ggang.cloud} \
  --set policy=sync \
  --set cloudflare.apiToken=<token> \
  --set cloudflare.proxied=false
```

또는 values.yaml로 GitOps 관리.

**HTTPRoute에 hostname 명시 (external-dns가 자동 감지)**:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: login-route
  namespace: app
spec:
  hostnames:
  - login.ggang.cloud   # external-dns가 보고 A 레코드 자동 생성
  parentRefs:
  - name: app-gateway
    namespace: istio-system
```

**검증**:

```bash
kubectl logs -n external-dns deploy/external-dns
# 로그에 "CREATE login.ggang.cloud A → <LB IP>" 출력 확인

dig login.ggang.cloud @1.1.1.1
```

## 6. Configuration — 어떤 설정이 있는가

**핵심 옵션**:
- `--source`: 감시할 리소스 타입 (다중 지정 가능)
- `--provider`: DNS provider
- `--domain-filter`: 관리할 도메인 (다른 도메인의 레코드 변경 금지)
- `--zone-id-filter`: 특정 zone만 처리
- `--policy`:
  - `sync` (권장): 추가/수정/삭제 모두 수행
  - `upsert-only`: 삭제하지 않음 (안전)
  - `create-only`: 생성만, 수정/삭제 없음
- `--registry`: `txt` (권장)
- `--txt-owner-id`: 멀티 인스턴스 환경에서 owner 구분
- `--interval`: 동기화 주기 (default 1분)
- `--log-level`: `info` / `debug`

**Cloudflare 옵션**:
- `cloudflare.proxied`: Cloudflare proxy(CDN+WAF) 통과 여부. 본 프로젝트는 `false` (Istio Gateway가 직접 트래픽 받음)
- `cloudflare.apiToken`: token-based 인증 (API key 아닌 token 권장)

**Gateway API 옵션** (v0.14+):
- `--source=gateway-httproute`: HTTPRoute에서 hostname 추출
- `--gateway-name=app-gateway`: 특정 Gateway에 연결된 Route만 처리 (선택)
- `--gateway-namespace=istio-system`: Gateway namespace 필터

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **external-dns v0.14+**: Gateway API source 지원
- **external-dns v0.15+** (2026-05 기준 권장)
- **Cloudflare API**: token-based 인증 (Global API Key는 deprecated, 사용 금지)
- **provider별 차이**: Cloudflare는 wildcard 레코드 지원, 일부 provider는 미지원
- **DNS provider rate limit**: Cloudflare는 분당 1200 요청 제한, external-dns 기본 polling 1분은 안전

## 8. 면접 예상 질문 & 답변

**Q1. external-dns가 왜 필요해요?**
> 마이크로서비스 환경에서는 hostname이 계속 늘어나고 LB IP도 가끔 바뀝니다. 이걸 DNS 콘솔에서 수동 관리하면 누락 사고가 반드시 납니다. external-dns는 Kubernetes 리소스(HTTPRoute, Service 등)를 source of truth로 보고 DNS provider에 자동으로 레코드를 만들고 업데이트합니다. 결과적으로 개발자는 `HTTPRoute`에 hostname만 적으면 끝이고, DNS 콘솔을 열 일이 없습니다.

**Q2. external-dns가 다른 사람이 만든 DNS 레코드를 건드리지 않는 메커니즘이 있나요?**
> TXT registry 패턴입니다. external-dns는 자기가 만든 모든 A/CNAME 레코드에 대응되는 TXT 레코드를 함께 생성해서 `heritage=external-dns,external-dns/owner=<my-owner-id>` 같은 표식을 남깁니다. 동기화할 때 이 표식이 있는 레코드만 자기 것으로 인식하고, 표식이 없거나 다른 owner-id의 레코드는 무시합니다. 그래서 운영자가 수동으로 만든 레코드는 안전합니다. 멀티 클러스터 환경에서는 각 클러스터마다 다른 `txtOwnerId`를 줘서 충돌을 방지합니다.

**Q3. Cloudflare proxied를 false로 둔 이유는?**
> Cloudflare proxy(CDN + WAF)를 통과시키면 Cloudflare가 TLS 종료를 하고 백엔드로 다시 HTTPS 또는 HTTP로 보냅니다. 본 프로젝트는 Istio Gateway가 직접 TLS 종료를 하고 그 뒤에 ztunnel mTLS로 내부 통신을 보호하는 구조라, Cloudflare proxy를 거치면 (1) TLS 종료가 두 군데에서 되고, (2) cert-manager가 발급한 Let's Encrypt 인증서가 사용되지 않으며 Cloudflare 인증서로 대체되고, (3) Cloudflare가 SNI 정보를 못 보기도 합니다. 단순성 + 명확한 TLS 흐름을 위해 proxy off로 갑니다. 운영 환경에서 DDoS 방어가 필요하면 proxy on을 검토합니다.

**Q4. Gateway API source는 어떻게 동작하나요?**
> external-dns v0.14부터 `--source=gateway-httproute` 옵션이 추가됐습니다. external-dns가 HTTPRoute의 `spec.hostnames`를 읽고, 그 HTTPRoute가 attach된 `Gateway`를 찾아서 그 Gateway가 노출되는 LoadBalancer Service의 외부 IP를 가져옵니다. 그 IP를 hostname의 A 레코드로 등록합니다. 즉 HTTPRoute → Gateway → Service → LB IP → DNS 레코드 흐름입니다. Gateway가 IP 대신 hostname을 가지면 CNAME으로 등록됩니다.

**Q5. policy=sync vs upsert-only 차이는?**
> sync는 추가/수정/삭제 다 수행하는 모드라 k8s 리소스가 삭제되면 DNS 레코드도 자동 삭제됩니다. upsert-only는 생성과 업데이트만 하고 삭제는 안 합니다. 본 프로젝트는 sync를 씁니다. 이유는 GitOps 환경에서 k8s 리소스가 source of truth라 DNS도 그에 따라야 일관성이 유지되기 때문입니다. upsert-only는 안전하지만 좀비 DNS 레코드가 쌓여서 운영 부담이 증가합니다.

**Q6. cert-manager와 같은 Cloudflare token을 재사용해도 되나요?**
> 기술적으로는 가능하지만 권한 분리 차원에서 별도 token을 권장합니다. external-dns는 `Zone:DNS:Edit + Zone:Zone:Read` 권한이 zone 전체에 필요하고, cert-manager DNS-01은 `_acme-challenge.*` TXT 레코드만 만들면 되므로 더 제한적인 token을 발급할 수 있습니다. token이 유출됐을 때 폭발 반경을 줄이기 위함입니다. 단, 본 프로젝트는 둘 다 같은 zone에 강한 권한이 필요해서 큰 차이는 없고 권장 사항입니다.

**Q7. external-dns가 죽으면 어떻게 되나요?**
> 이미 등록된 DNS 레코드는 그대로 살아있고 트래픽은 정상입니다. 다만 새 HTTPRoute가 추가되거나 LB IP가 바뀌면 DNS가 갱신되지 않아서 새 hostname이 동작하지 않거나 트래픽이 잘못된 IP로 갑니다. 그래서 external-dns 다운을 Prometheus가 감지하고 Alertmanager가 즉시 알림을 보내도록 룰을 박아둡니다. external-dns 자체는 stateless라 재기동만으로 회복됩니다.

**Q8. 같은 hostname을 여러 HTTPRoute가 선언하면 어떻게 되나요?**
> external-dns는 모든 매칭되는 HTTPRoute에서 hostname을 수집하고 중복 제거합니다. 만약 두 HTTPRoute가 같은 hostname을 가지지만 다른 Gateway에 attach되어서 LB IP가 다르다면, external-dns는 하나의 hostname에 두 개의 A 레코드를 등록합니다(round-robin DNS). 의도된 동작이 아니면 HTTPRoute 정의가 잘못된 거라 경고 로그가 나옵니다. 본 프로젝트는 단일 Gateway 사용이라 충돌 없습니다.

**Q9. domain-filter를 설정 안 하면 어떻게 되나요?**
> external-dns가 token 권한 내의 모든 zone을 관리하려고 시도합니다. Cloudflare account에 여러 도메인이 있고 token이 account-wide 권한이면, 다른 도메인의 레코드까지 건드릴 수 있습니다. 사고 위험이 크므로 항상 `--domain-filter=ggang.cloud`로 명시하고, token도 zone-scoped로 발급합니다. 이중 안전장치입니다.

**Q10. interval(polling 주기)을 줄이면 더 빨라지나요?**
> 빨라지지만 DNS provider rate limit과 트레이드오프입니다. Cloudflare는 분당 1200 요청 제한인데, zone에 레코드가 100개면 한 번 sync에 100+ 요청이 발생하므로 interval 10초로 줄이면 분당 600 요청으로 한도에 가까워집니다. default 1분이 안전하고, HTTPRoute 변경 직후 즉시 반영이 필요하면 `kubectl annotate`로 external-dns를 강제 트리거하는 방식이 더 적절합니다.
