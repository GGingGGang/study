# cert-manager

## 1. Why — 왜 쓰는가

Kubernetes에서 TLS 인증서 발급/갱신/배포를 자동화하는 표준 도구다. 본 프로젝트가 사용하는 사유:

**수동 인증서 관리의 문제**: Let's Encrypt 인증서는 90일 만료라 수동 갱신은 운영 사고의 단골 원인. 인증서 만료가 새벽 3시에 발생하면 서비스 중단으로 직결.

**cert-manager의 해결**: `Certificate` CR 하나로 발급 요청 → cert-manager가 ACME 프로토콜로 Let's Encrypt에 요청 → DNS-01 또는 HTTP-01 challenge 자동 완료 → Secret으로 저장 → 만료 30일 전 자동 갱신.

**대체재**: 
- 수동 + openssl: 운영 부담 큼
- AWS ACM: AWS 종속, OCI 사용 불가
- Vault PKI: 자체 CA 운영 시 사용. 외부 trust(브라우저 신뢰)는 안 됨
- Caddy 자동 TLS: 단일 바이너리 환경에서만 가능, k8s 환경 부적합

본 프로젝트는 외부 사용자 트래픽을 받는 `ggang.cloud` 도메인이므로 **브라우저가 신뢰하는 Let's Encrypt** 인증서가 필요 → cert-manager + Let's Encrypt 조합이 표준.

## 2. Architecture — 어떻게 구성되는가

**컴포넌트**:
- `cert-manager-controller`: 핵심 컨트롤러. `Certificate`, `Issuer`, `ClusterIssuer` watch
- `cert-manager-webhook`: validating/mutating admission webhook. CR 검증
- `cert-manager-cainjector`: webhook과 API service에 CA 번들 자동 주입

**CRD 리소스**:
- `Issuer` (namespace-scoped) / `ClusterIssuer` (cluster-scoped): 인증서 발급자 정의. Let's Encrypt, Vault, SelfSigned 등
- `Certificate`: 발급받을 인증서 정의(도메인, 만료 기간, 저장 Secret 이름 등)
- `CertificateRequest`: cert-manager가 내부적으로 생성. ACME 요청 진행 상태 추적
- `Order`, `Challenge`: ACME 프로토콜 진행 상태

본 프로젝트는 **`ClusterIssuer`로 Let's Encrypt production** + 도메인별 `Certificate` 리소스 패턴.

## 3. Mechanism — 어떻게 돌아가는가

**ACME DNS-01 challenge 흐름** (와일드카드 인증서):

1. `Certificate` CR 생성 (`*.ggang.cloud` 요청)
2. cert-manager가 `CertificateRequest` 생성
3. ACME `Order` 생성, Let's Encrypt에 요청
4. Let's Encrypt가 `_acme-challenge.ggang.cloud` TXT 레코드 요청
5. cert-manager가 Cloudflare API에 TXT 레코드 추가
6. Let's Encrypt가 DNS 조회 → 검증 성공
7. 인증서 발급 → Secret으로 저장
8. cert-manager가 TXT 레코드 정리

**자동 갱신**:
- 인증서 만료 30일 전 자동 갱신 시도
- `Certificate.spec.renewBefore`로 조정 가능
- 갱신 실패 시 만료 7일 전부터 매일 재시도 + 알람

**왜 DNS-01인가 (HTTP-01 vs DNS-01)**:
- HTTP-01: `_acme-challenge` 경로에 파일 노출. 와일드카드 불가
- DNS-01: TXT 레코드 검증. **와일드카드 가능** + 외부 노출 불필요
- 본 프로젝트는 `*.ggang.cloud` 와일드카드라 DNS-01 필수

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 cert-manager 의존 관계.

- **Gateway API** — `Gateway` 리소스의 `tls.certificateRefs`가 cert-manager가 만든 Secret 참조
- **Cloudflare DNS** — DNS-01 challenge용 API token이 k8s Secret으로 저장됨
- **external-dns** — 별개 컴포넌트, 같은 Cloudflare token 재사용 가능(권한 분리 권장)

**Secret 흐름**:
```
ClusterIssuer (Cloudflare API token 참조)
    ↓
Certificate (도메인 요청)
    ↓
cert-manager가 ACME 진행
    ↓
Secret (tls.crt + tls.key)
    ↓
Gateway.tls.certificateRefs로 참조
    ↓
Istio envoy가 Secret 읽어서 listener에 로드
```

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace \
  --version v1.18.0 \
  --set crds.enabled=true
```

**Cloudflare token Secret**:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: "<Zone:DNS:Edit + Zone:Zone:Read, scope: ggang.cloud>"
```

**ClusterIssuer** (Let's Encrypt production + Cloudflare DNS-01):

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@ggang.cloud
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - dns01:
        cloudflare:
          apiTokenSecretRef:
            name: cloudflare-api-token
            key: api-token
      selector:
        dnsZones:
        - ggang.cloud
```

**Certificate** (와일드카드):

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ggang-cloud-wildcard
  namespace: istio-system
spec:
  secretName: ggang-cloud-tls
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  commonName: "*.ggang.cloud"
  dnsNames:
  - "*.ggang.cloud"
  - "ggang.cloud"
  duration: 2160h     # 90일
  renewBefore: 720h   # 30일 전 갱신
```

**검증**:

```bash
kubectl describe certificate ggang-cloud-wildcard -n istio-system
kubectl get challenge -A   # 진행 중인 challenge
kubectl logs -n cert-manager deploy/cert-manager
```

## 6. Configuration — 어떤 설정이 있는가

**Issuer 옵션**:
- `acme.server`: production vs staging URL (개발 시 staging — rate limit 회피)
- `acme.email`: 만료 알림 수신
- `solvers`: DNS-01 (와일드카드 가능) vs HTTP-01 (단일 도메인)

**Certificate 옵션**:
- `duration`: 인증서 유효기간 (default 90일, Let's Encrypt 최대)
- `renewBefore`: 갱신 시점 (default 만료 1/3 시점)
- `privateKey.algorithm`: `RSA` / `ECDSA` (ECDSA가 더 가볍고 빠름, 권장)
- `privateKey.rotationPolicy`: `Never` / `Always`(갱신 시 키도 회전)
- `usages`: `server auth`, `client auth` 등

**Gateway API 통합** (cert-manager 1.15+ default 활성화):
- Helm values: `config.enableGatewayAPI: true` 또는 chart 버전별 동등 키
- 옛 버전(1.14 이하)은 `--feature-gates=ExperimentalGatewayAPISupport=true` 필요했으나 1.15+ 불필요

**Rate Limit (Let's Encrypt)**:
- production: 도메인당 주 5개 인증서, account당 시간당 300 요청
- staging: rate limit 매우 느슨 → 개발/테스트는 staging 권장

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+** (cert-manager 1.15+ 요구사항)
- **cert-manager 1.18+** (2026-05 기준 권장). 1.15부터 Gateway API integration default 활성화
- **Gateway API v1** (standard 채널)
- **Helm 3.x** 필수
- **인증서 issuer 호환성**: Let's Encrypt, Buypass, ZeroSSL, Vault PKI, AWS ACM Private CA 등 다양. 본 프로젝트는 Let's Encrypt만
- **DNS provider 호환성**: Cloudflare, Route53, Google Cloud DNS, Azure DNS 등. webhook 방식으로 커스텀 provider 추가 가능

## 8. 면접 예상 질문 & 답변

**Q1. 왜 cert-manager를 쓰나요?**
> Let's Encrypt 인증서는 90일 만료라 수동 관리하면 만료 사고가 반드시 납니다. cert-manager는 `Certificate` CR 하나로 발급/갱신/Secret 배포를 전부 자동화하고, 만료 30일 전 자동 갱신을 하므로 운영 부담이 사라집니다. 또 Kubernetes-native 리소스라 GitOps로 인증서 정의를 코드로 관리할 수 있어서 ArgoCD와 자연스럽게 연동됩니다.

**Q2. HTTP-01 대신 DNS-01 challenge를 고른 이유는?**
> 와일드카드 인증서 발급 때문입니다. `*.ggang.cloud`처럼 와일드카드 도메인은 HTTP-01로는 불가능하고 DNS-01만 가능합니다. 또 DNS-01은 외부 HTTP 엔드포인트를 노출할 필요가 없어서 LB나 Ingress 설정이 인증서 갱신에 영향받지 않습니다. 단점은 DNS provider API 권한이 필요하다는 거고, Cloudflare API token을 zone-scoped(`ggang.cloud`만)으로 발급해서 권한 폭발 반경을 제한했습니다.

**Q3. ClusterIssuer와 Issuer 차이는요?**
> Scope 차이입니다. `Issuer`는 namespace-scoped라 해당 namespace의 `Certificate`만 사용할 수 있고, `ClusterIssuer`는 cluster-wide라 모든 namespace에서 참조 가능합니다. 본 프로젝트는 `ggang.cloud` 도메인이 모든 컴포넌트(Grafana, ArgoCD, Jenkins UI 등)에서 쓰이므로 `ClusterIssuer`로 통합 관리합니다. Issuer 분리가 의미 있는 경우는 namespace별로 다른 CA를 써야 할 때입니다.

**Q4. ECDSA vs RSA 어느 걸 쓰나요?**
> ECDSA를 권장합니다. ECDSA 256-bit가 RSA 3072-bit와 동등한 보안 강도인데 키 크기는 1/10 수준이라 TLS 핸드셰이크가 빠르고 메모리도 적게 씁니다. 다만 일부 레거시 클라이언트가 ECDSA 미지원이라 호환성이 걸리면 RSA fallback 필요한데, 본 프로젝트는 모던 브라우저/모바일만 대상이라 ECDSA로 갑니다.

**Q5. 인증서 갱신 실패 시 어떻게 알림 받나요?**
> 두 가지 레이어로 갑니다. 첫째는 Let's Encrypt가 만료 20일/7일/1일 전 발급 시 등록한 이메일로 알림을 보냅니다. 둘째는 Prometheus가 `certmanager_certificate_expiration_timestamp_seconds` 메트릭을 수집하고 Alertmanager가 만료 14일 전 Slack으로 경고를 보내도록 룰을 박아둡니다. cert-manager 자체 메트릭이 풍부해서 발급 실패, ACME 에러 등을 세분화해서 알람 가능합니다.

**Q6. cert-manager 1.15부터 Gateway API 통합이 어떻게 바뀌었나요?**
> 1.14 이하는 `--feature-gates=ExperimentalGatewayAPISupport=true`를 명시해야 Gateway API 리소스를 인식했는데, 1.15부터는 default로 활성화돼서 별도 옵션이 불필요합니다. 대신 Helm chart에서 Gateway API 통합 활성화 키(`config.enableGatewayAPI: true` 등 버전별 차이)를 켜야 하고, Gateway API CRD가 클러스터에 미리 설치되어 있어야 합니다. cert-manager는 `Gateway` 리소스의 `tls.certificateRefs`를 watch해서 자동으로 `Certificate`를 생성하는 식으로 동작합니다.

**Q7. Certificate CR을 명시적으로 만드는 것 vs Gateway annotation으로 자동 생성하는 것 중 뭐가 나은가요?**
> 본 프로젝트는 명시적 `Certificate` CR을 권장합니다. 이유는 GitOps declarative 일관성 때문입니다. annotation 방식은 `Gateway`만 보면 인증서가 어떻게 발급되는지 분명하지 않지만, 명시적 CR이 있으면 ArgoCD diff에서 인증서 변경이 명확하게 추적됩니다. 또 인증서 lifecycle을 Gateway lifecycle과 분리해서 관리할 수 있어서, Gateway를 재생성해도 인증서가 사라지지 않습니다.

**Q8. Let's Encrypt rate limit에 걸리지 않으려면?**
> 개발 단계에서는 반드시 `acme-staging-v02.api.letsencrypt.org` staging endpoint를 사용합니다. staging은 rate limit이 매우 느슨해서 실수로 인증서 100번 발급해도 안전합니다. production은 도메인당 주 5개 제한이 있어서 디버깅하다 막힐 수 있습니다. ClusterIssuer를 production용과 staging용 두 개 만들어두고 매니페스트에서 issuerRef만 바꿔서 전환합니다.

**Q9. cert-manager 자체가 죽으면 어떻게 되나요?**
> 이미 발급된 인증서는 Secret에 저장되어 있고 envoy가 Secret을 watch하므로 cert-manager가 죽어도 즉시 영향은 없습니다. 다만 인증서 만료 30일 전 갱신 작업이 멈추므로 cert-manager 다운이 30일 이상 지속되면 인증서가 만료되어 서비스가 죽습니다. 그래서 cert-manager 다운을 Prometheus가 감지하고 Alertmanager가 즉시 알림을 보내도록 룰을 박아두는 게 표준 패턴입니다.

**Q10. Vault PKI engine으로 cert-manager 대체 가능하지 않나요?**
> Vault PKI는 내부 CA 운영용입니다. Istio mTLS 같은 내부 서비스 간 통신은 Vault PKI로 충분하지만, `ggang.cloud` 같은 외부 사용자 트래픽은 브라우저가 신뢰하는 public CA가 필요해서 Let's Encrypt가 필수입니다. 따라서 본 프로젝트는 cert-manager + Let's Encrypt를 외부 인증서용으로, Istio 내장 CA를 내부 mTLS용으로 분리해서 씁니다. Vault PKI는 고급 시나리오로 검토만 했습니다.
