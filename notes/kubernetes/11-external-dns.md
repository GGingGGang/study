# ExternalDNS (external-dns)

> 쿠버네티스 · 인프라/TLS·DNS · 학습내용: 쿠버네티스 리소스를 외부 DNS 레코드로 동기화하는 원리, 소스(Service/Ingress/Gateway)와 프로바이더, TXT 레지스트리 기반 소유권 관리, Cloudflare 설정·정책·어노테이션과 함정

---

## 1. ExternalDNS가 뭐고 왜 쓰나

**ExternalDNS**는 쿠버네티스의 **Service·Ingress·Gateway 같은 리소스를 보고, 거기에 적힌 호스트명을 외부 DNS 프로바이더(Cloudflare·Route53 등)에 자동으로 레코드로 등록·갱신**해 주는 컨트롤러다(kubernetes-sigs 프로젝트).

원래는 Ingress를 만들 때마다 사람이 DNS 콘솔에 들어가 `app.ggang.cloud → LB IP` A 레코드를 손으로 추가했다. 서비스가 늘면 이게 누락·오타·삭제 누락의 온상이 된다. ExternalDNS는 **쿠버네티스 리소스를 단일 진실 공급원(source of truth)** 으로 삼아 DNS를 **자동으로 맞춘다**. 리소스를 지우면 레코드도 따라서 정리된다.

> ExternalDNS는 **DNS 레코드만** 관리한다. 인증서(cert-manager)나 트래픽 라우팅(Ingress 컨트롤러)과는 역할이 분리된다.

## 2. 동작 원리 — 소스 → 프로바이더

ExternalDNS는 주기적으로(reconcile loop) 아래를 수행한다.

1. **소스(source)** 에서 원하는 DNS 상태를 읽는다.
   - **Service**(`type: LoadBalancer`의 외부 IP, 또는 어노테이션의 hostname)
   - **Ingress**(`spec.rules[].host` + 로드밸런서 주소)
   - **Gateway API**(`Gateway`, `HTTPRoute` 등)
2. 원하는 레코드 집합을 계산한다(예: `app.ggang.cloud → 203.0.113.10`).
3. **프로바이더 API**(Cloudflare 등)에서 현재 레코드를 읽어 **차이(diff)** 를 구한다.
4. 차이만큼 **생성/수정/삭제** 호출을 보내 동기화한다.

정리하면 "쿠버네티스에 선언된 호스트명"과 "실제 DNS 레코드"를 **계속 맞춰 두는 컨트롤러**다.

## 3. TXT 레지스트리 — 소유권 관리 ★★★

ExternalDNS에서 가장 신경 쓰이는 부분은 **"내가 만든 레코드만 건드려야 한다"** 는 점이다. 같은 zone에 사람이 손으로 만든 레코드나 다른 시스템 레코드가 섞여 있는데, ExternalDNS가 함부로 지우면 사고다.

그래서 ExternalDNS는 **TXT 레지스트리(registry)** 를 쓴다. A/CNAME 레코드를 만들 때 **동반 TXT 레코드**를 같이 만들어 "이건 ExternalDNS가, 이 인스턴스(`txt-owner-id`)가 관리한다"는 **소유권 표식**을 남긴다.

- 동기화 시 ExternalDNS는 **자기 owner-id가 적힌 TXT가 붙은 레코드만** 관리 대상으로 본다.
- 손으로 만든(=TXT 표식이 없는) 레코드는 **건드리지 않는다**.
- 그래서 `--txt-owner-id`(클러스터/인스턴스 식별자)는 **반드시 고유하게** 설정해야 한다. 두 클러스터가 같은 owner-id로 같은 zone을 보면 서로의 레코드를 지운다.

★★★ 면접 포인트: "ExternalDNS가 어떻게 자기 레코드만 안전하게 관리하나?" → **TXT 레지스트리 + txt-owner-id**.

## 4. 정책(policy)과 어노테이션

### 동기화 정책 (`--policy`)

| 정책 | 동작 | 쓰임 |
|------|------|------|
| **sync** | 생성·수정·**삭제 모두** 반영(완전 동기화) | 쿠버네티스를 진실 공급원으로 완전 위임할 때 |
| **upsert-only** | 생성·수정만, **삭제 안 함** | 실수로 레코드가 지워지는 사고 방지(보수적). 초기 도입 시 안전 |

> 처음 도입할 때는 **upsert-only**로 시작해 동작을 확인하고, 믿을 만해지면 **sync**로 넘어가는 편이 안전하다.

### 자주 쓰는 어노테이션

- `external-dns.alpha.kubernetes.io/hostname: app.ggang.cloud` — Service에 직접 호스트명 지정(LoadBalancer Service에서 흔히 사용).
- `external-dns.alpha.kubernetes.io/ttl: "300"` — 레코드 TTL(초) 지정.
- `external-dns.alpha.kubernetes.io/target: ...` — 가리킬 대상(IP/CNAME)을 강제 지정.

## 5. Cloudflare 설정 예시 (프로젝트 스택)

`ggang.cloud` zone을 Cloudflare로 운영하는 구성. API 토큰을 환경변수로 주입하고, Ingress를 소스로 삼는다.

```yaml
# 배포(Deployment) 핵심 인자 발췌
args:
  - --source=ingress
  - --source=service
  - --provider=cloudflare
  - --domain-filter=ggang.cloud      # 이 zone만 관리(안전장치)
  - --policy=upsert-only             # 처음엔 보수적으로
  - --registry=txt
  - --txt-owner-id=prod-cluster      # 소유권 식별자(클러스터마다 고유)
env:
  - name: CF_API_TOKEN
    valueFrom:
      secretKeyRef:
        name: cloudflare-api-token   # Zone:DNS:Edit + Zone:Read 권한
        key: api-token
```

```yaml
# Ingress만 만들면 app.ggang.cloud 레코드가 자동 생성됨
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
spec:
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

> **Cloudflare 프록시(주황 구름)**: 어노테이션 `external-dns.alpha.kubernetes.io/cloudflare-proxied: "true"`로 프록시 on/off를 제어한다.

## 6. 흔한 함정 ★

- **txt-owner-id 중복**: 여러 클러스터가 같은 owner-id로 같은 zone을 관리하면 서로 레코드를 삭제한다. **반드시 고유하게**.
- **domain-filter 누락**: 필터 없이 폭넓은 권한 토큰을 주면 의도치 않은 zone의 레코드까지 건드릴 위험이 있다.
- **policy=sync로 바로 시작**: 초기 오설정으로 멀쩡한 레코드가 삭제될 수 있다 → **upsert-only로 검증 후 전환**.
- **API 토큰 권한 부족**: Cloudflare는 `Zone:DNS:Edit` + `Zone:Read`가 필요. 권한 부족 시 동기화 실패.
- **레코드가 안 생김**: Service가 외부 IP를 못 받았거나(LB 미할당), Ingress에 host가 비었거나, 소스(`--source`)에 해당 타입이 빠진 경우. 로그를 확인.

### 한 줄 요약
ExternalDNS는 **Ingress/Service/Gateway에 적힌 호스트명을 외부 DNS(Cloudflare 등)에 자동 동기화**하는 컨트롤러로, **TXT 레지스트리 + txt-owner-id**로 자기 레코드만 안전하게 관리한다. 도입은 **upsert-only**로 시작하고 `domain-filter`로 범위를 좁히는 것이 안전하다.

### 참고 (공식 문서)
- ExternalDNS (kubernetes-sigs): https://github.com/kubernetes-sigs/external-dns
- Cloudflare 튜토리얼: https://kubernetes-sigs.github.io/external-dns/latest/docs/tutorials/cloudflare/
- 레지스트리(TXT) 설명: https://kubernetes-sigs.github.io/external-dns/latest/docs/registry/registry/
- 어노테이션 레퍼런스: https://kubernetes-sigs.github.io/external-dns/latest/docs/annotations/annotations/
- Gateway API 소스: https://kubernetes-sigs.github.io/external-dns/latest/docs/sources/gateway/
