# cert-manager (cert-manager)

> 쿠버네티스 · 인프라/TLS·DNS · 학습내용: 인증서 자동 발급·갱신의 원리, Issuer/ClusterIssuer·Certificate 등 핵심 리소스, ACME(Let's Encrypt)와 DNS-01 vs HTTP-01 챌린지, Cloudflare DNS-01 와일드카드 발급, Gateway/Ingress 연동과 흔한 함정

---

## 1. cert-manager가 뭐고 왜 쓰나

**cert-manager**는 쿠버네티스 안에서 **TLS 인증서를 자동으로 발급·갱신·교체**해 주는 컨트롤러다. 인증서를 `Certificate`라는 **쿠버네티스 리소스**로 선언하면, cert-manager가 발급 기관(CA)과 통신해 실제 인증서를 받아 **Secret**에 저장하고, **만료 전에 알아서 갱신**한다.

인증서를 직접 받으려면 사람이 90일마다 갱신·재배포해야 하고(Let's Encrypt 인증서 유효기간이 90일), 이걸 잊으면 사이트가 죽는다. cert-manager는 이 과정을 **선언형(declarative)으로 자동화**한다. "이 도메인의 유효한 인증서가 항상 Secret에 있어야 한다"고 선언하면 cert-manager가 그 상태를 유지한다.

- 발급원: **ACME(Let's Encrypt 등)**, **HashiCorp Vault/OpenBao**, **Venafi**, **사설 CA(self-signed/CA Issuer)** 등 다양한 백엔드 지원.
- 결과물: 표준 `kubernetes.io/tls` 타입 **Secret**(`tls.crt` + `tls.key`). Ingress/Gateway가 이 Secret을 그대로 참조.

## 2. 핵심 리소스

cert-manager는 여러 **CRD(커스텀 리소스)** 로 동작한다. 발급 요청이 들어오면 아래 리소스들이 **순서대로 줄줄이 만들어진다**.

| 리소스 | 역할 |
|--------|------|
| **Issuer / ClusterIssuer** | **발급자(CA) 설정**. 어떤 백엔드(ACME/Vault…)로 어떻게 발급할지 정의. Issuer는 네임스페이스 한정, **ClusterIssuer는 클러스터 전역** |
| **Certificate** | "이 도메인용 인증서를 이 Secret에 둬라"는 **사용자 의도 선언**. dnsNames·발급자·갱신 기준 등 명시 |
| **CertificateRequest** | Certificate로부터 만들어지는 **1회성 발급 요청**(PEM CSR 포함). 컨트롤러 내부용 |
| **Order** | ACME 전용. 하나의 ACME **주문(order)** 을 표현 |
| **Challenge** | ACME 전용. 도메인 소유 증명 **챌린지 1건**(DNS-01 또는 HTTP-01) |

흐름: `Certificate` → `CertificateRequest` → (ACME면) `Order` → `Challenge`(들) → 검증 통과 시 인증서 발급 → **Secret 저장**.

★ 면접 포인트: **Issuer vs ClusterIssuer 차이**(네임스페이스 vs 클러스터 전역)와 **리소스 연쇄(Certificate→Order→Challenge)** 를 설명할 수 있어야 한다.

## 3. ACME와 도메인 소유 증명(챌린지)

**ACME**(Automatic Certificate Management Environment)는 Let's Encrypt가 쓰는 자동 발급 프로토콜이다. CA는 인증서를 내주기 전에 "**네가 정말 이 도메인의 주인이냐**"를 검증하는데, 이 검증 방식이 **챌린지**다.

### DNS-01 vs HTTP-01 ★★★

| 구분 | HTTP-01 | DNS-01 |
|------|---------|--------|
| 증명 방법 | `http://도메인/.well-known/acme-challenge/...` 경로에 토큰 노출 | DNS에 **TXT 레코드**(`_acme-challenge.도메인`) 생성 |
| 필요 조건 | 80포트로 **외부에서 접근 가능**해야 함 | **DNS 프로바이더 API 권한** 필요 |
| **와일드카드** (`*.ggang.cloud`) | **불가** | **가능 (와일드카드는 DNS-01 필수)** |
| 방화벽 뒤/내부 도메인 | 어려움(외부 노출 필요) | 가능(아웃바운드만 있으면 됨) |
| 대표 함정 | 80포트 막힘·리다이렉트 꼬임 | DNS 전파 지연, API 토큰 권한 부족 |

★★★ **와일드카드 인증서가 필요하면 무조건 DNS-01**이다. HTTP-01로는 와일드카드를 발급하지 못한다. 이 차이는 단골 면접 질문이다.

## 4. Cloudflare DNS-01 예시 (프로젝트 스택)

도메인 `ggang.cloud`를 Cloudflare DNS로 운영하면서 Let's Encrypt에서 와일드카드까지 포함한 인증서를 받는 구성이다. 먼저 Cloudflare API 토큰을 Secret으로 넣고, ClusterIssuer에 DNS-01 솔버를 지정한다.

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-api-token
  namespace: cert-manager
type: Opaque
stringData:
  api-token: <CLOUDFLARE_API_TOKEN>   # Zone:DNS:Edit 권한
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: dajuco11@gmail.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key   # ACME 계정 키 저장 위치
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
```

발급 받을 인증서 선언(와일드카드 포함):

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: ggang-cloud-tls
  namespace: default
spec:
  secretName: ggang-cloud-tls       # 결과 인증서가 저장될 Secret
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  dnsNames:
    - ggang.cloud
    - "*.ggang.cloud"               # 와일드카드 → DNS-01이라 가능
```

> **테스트는 staging부터.** 운영 ACME 서버는 강한 **rate limit**이 있으므로, 설정 검증 단계에서는 `acme-staging-v02.api.letsencrypt.org`를 쓰고 잘 되면 prod로 바꾼다.

## 5. 자동 갱신과 Ingress/Gateway 연동

- **자동 갱신**: cert-manager는 만료 시점(기본값은 유효기간의 **2/3 경과 시**, Let's Encrypt 90일 기준 약 30일 전)에 자동으로 재발급해 같은 Secret을 갱신한다. 사람이 손댈 필요가 없다.
- **Ingress 연동(ingress-shim)**: Ingress에 `cert-manager.io/cluster-issuer: letsencrypt-prod` 어노테이션을 달고 `tls` 블록에 호스트·secretName을 적으면, cert-manager가 **Certificate를 자동 생성**해 준다.

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  tls:
    - hosts: ["app.ggang.cloud"]
      secretName: app-ggang-cloud-tls   # cert-manager가 채워줌
  rules:
    - host: app.ggang.cloud
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port: { number: 80 }
```

- **Gateway API 연동**: Gateway 리소스에도 어노테이션 방식으로 연동하거나(experimental 기능 활성화 필요), `Certificate`를 직접 만들어 Gateway listener의 `certificateRefs`에 Secret을 연결한다.

## 6. 흔한 함정 ★

- **Rate limit**: Let's Encrypt 운영 서버는 동일 등록 도메인당 주간 발급 한도가 있다. 잘못된 설정으로 반복 실패하면 한도를 소진해 한동안 발급이 막힌다 → **반드시 staging에서 먼저 검증**.
- **챌린지 실패(DNS-01)**: API 토큰 권한 부족(Zone:DNS:Edit 필요), DNS 전파 지연, 잘못된 zone 선택. `kubectl describe challenge`로 상태/사유를 확인.
- **챌린지 실패(HTTP-01)**: 80포트 차단, HTTPS 강제 리다이렉트로 `.well-known` 경로 접근 불가.
- **Secret 미생성**: `kubectl get certificate` → `READY=False`면 `describe`로 CertificateRequest/Order/Challenge를 따라 내려가며 원인 추적.
- **DNS-01인데 namecheap/wildcard만 보고 HTTP-01 솔버를 쓰는 실수** → 와일드카드는 DNS-01만 된다.

### 한 줄 요약
cert-manager는 `Certificate` 선언만으로 **TLS 인증서를 자동 발급·갱신**하는 컨트롤러로, ACME(Let's Encrypt) 사용 시 도메인 소유를 **DNS-01/HTTP-01 챌린지**로 증명하며 **와일드카드는 DNS-01 필수**다. 프로젝트는 Cloudflare DNS-01로 `*.ggang.cloud`를 발급하고, 운영 전 **staging으로 rate limit을 피한다**.

### 참고 (공식 문서)
- cert-manager 개요: https://cert-manager.io/docs/
- ACME / 챌린지(HTTP-01·DNS-01): https://cert-manager.io/docs/configuration/acme/
- Cloudflare DNS-01 솔버: https://cert-manager.io/docs/configuration/acme/dns01/cloudflare/
- Certificate 리소스: https://cert-manager.io/docs/usage/certificate/
- Ingress 연동(ingress-shim): https://cert-manager.io/docs/usage/ingress/
