# OpenBao (OpenBao)

> 쿠버네티스 · 인프라/보안 · 학습내용: 시크릿 관리의 필요성, 시크릿 엔진(KV·DB 동적 시크릿), 동적 vs 정적 시크릿, 인증(Kubernetes Auth 등), 정책, 봉인/해제(seal/unseal)와 Shamir, 쿠버네티스 연동, 감사 로그

---

## 1. OpenBao가 뭐고 왜 쓰나

**OpenBao**는 **시크릿(비밀 값)을 안전하게 저장·발급·관리**하는 시스템이다. HashiCorp Vault에서 갈라져 나온 **오픈소스(리눅스 재단)** 프로젝트로, **Vault와 API/개념이 호환**된다.

여기서 시크릿이란 DB 비밀번호, API 키, TLS 인증서, 클라우드 자격증명, 암호화 키처럼 **노출되면 안 되는 값**이다. OpenBao는 이런 값을 **암호화해 한곳에서 중앙 관리**하고, **누가 언제 무엇에 접근했는지 통제·감사**하며, 필요하면 **요청하는 순간에 짧게 사는 자격증명을 즉석에서 발급**한다.

★★★ **면접 포인트: "왜 쿠버네티스 Secret 대신 Vault/OpenBao인가?"**
- 쿠버네티스 기본 Secret은 etcd에 **base64로 들어갈 뿐 기본적으로 평문에 가깝다**(별도 설정 없으면 미암호화). 접근 통제·자동 교체·동적 발급이 약하다.
- OpenBao는 **저장 시 암호화 + 세밀한 정책(RBAC) + 동적 시크릿 + 감사 로그 + 자동 만료(lease)**를 제공해 시크릿의 전 생애주기를 통제한다.

## 2. 시크릿 엔진 (Secrets Engine)

OpenBao는 **시크릿 엔진**이라는 플러그인을 특정 경로(path)에 마운트해 기능을 제공한다.

| 엔진 | 하는 일 | 시크릿 성격 |
|------|---------|-------------|
| **KV (Key-Value)** | 키-값 시크릿을 그냥 저장/조회(v2는 버전 관리) | **정적** |
| **Database** | DB에 접속해 **요청 시 일회용 DB 계정을 즉석 생성** | **동적** |
| **PKI** | 인증서를 발급(사설 CA) | 동적 |
| **Transit** | 값을 OpenBao에 맡겨 **암·복호화**(키는 밖으로 안 나감) | - |
| **AWS/Cloud** | 클라우드 임시 자격증명 발급 | 동적 |

## 3. 동적 vs 정적 시크릿

| 구분 | 정적 시크릿 | 동적 시크릿 |
|------|-------------|-------------|
| 정의 | 미리 저장해 둔 고정 값(KV) | 요청 시점에 **즉석 생성**되는 값 |
| 수명 | 사람이 바꿀 때까지 유지 | **lease(임대) 기간** 후 자동 만료·폐기 |
| 노출 위험 | 유출되면 교체 전까지 유효 | **짧게 살고 사라져** 유출 영향 최소 |
| 예 | API 키, 설정값 | DB 계정, 클라우드 임시 키 |

★ 동적 시크릿의 핵심: 앱이 DB 비밀번호를 요청하면 OpenBao가 **그 순간 DB에 새 계정을 만들어** 건네고, lease가 끝나면 **그 계정을 DB에서 지운다**. 비밀번호가 코드나 설정에 박히지 않고, 새어 나가도 곧 만료된다.

## 4. 인증 (Auth Methods)

시크릿을 받으려면 먼저 **OpenBao에 자신이 누구인지 인증**해야 한다. 인증에 성공하면 정책이 붙은 **토큰**을 받고, 그 토큰으로 시크릿에 접근한다.


- **Kubernetes Auth**: 워크로드의 **ServiceAccount JWT**를 OpenBao가 쿠버네티스 API로 검증 → 해당 SA에 매핑된 정책의 토큰 발급. ★ 쿠버네티스 앱이 시크릿을 받는 표준 방법(앱에 마스터 토큰을 박지 않아도 됨).
- 그 외 AppRole(머신용), JWT/OIDC(사람·CI), TLS 인증서, 토큰 등.

## 5. 정책 (Policy)

**정책 = "어떤 경로(path)에 어떤 동작(read/create/update/delete/list)을 허용/거부"** 규칙. 기본은 deny이며 명시적으로 허용한다.

```hcl
# app 네임스페이스 앱이 자기 KV만 읽도록 허용
path "secret/data/app/*" {
  capabilities = ["read"]
}
```

토큰에 정책이 붙고, 인증 방법(예: Kubernetes Auth role)이 SA ↔ 정책을 연결한다.

## 6. 봉인/해제 (Seal / Unseal) + Shamir

★★★ **봉인(seal)**: OpenBao의 저장 데이터는 **마스터 키로 암호화**해 두며, 시작 직후엔 마스터 키가 메모리에 없어 **아무것도 못 읽는 "봉인 상태"**다. **해제(unseal)** 해야 마스터 키가 재구성되어 작동한다.

- **Shamir's Secret Sharing**: 마스터 키를 **N개의 조각(key share)으로 쪼개고**, 그중 **임계치(threshold) K개가 모여야** 마스터 키를 복원한다(예: 5개 중 3개).
  - 한 사람이 모든 키를 갖지 못하게 해 **권한을 분산**하고, 일부 조각이 유출돼도 K개 미만이면 안전.
- **Auto-unseal**: 운영에선 사람이 매번 조각을 넣는 대신, 클라우드 KMS(또는 Transit) 등에 마스터 키 보호를 맡겨 **자동으로 해제**하는 방식을 흔히 쓴다.

> 면접 한 줄: "OpenBao는 마스터 키로 데이터를 암호화하며, 그 마스터 키를 **Shamir로 N개로 쪼개 K개가 모여야 unseal**된다 → 권한 분산·단일 유출 방어."

## 7. 쿠버네티스 연동 (Auth + 주입)

앱이 시크릿을 받는 두 단계: **① 인증(Kubernetes Auth) → ② 시크릿을 앱에 전달**.

시크릿 전달 방식:

- **Agent Sidecar Injector**: Pod에 Agent 사이드카를 자동 주입 → 사이드카가 OpenBao에서 시크릿을 받아 **공유 볼륨의 파일로** 떨궈 줌. 앱은 그 파일을 읽기만.
- **CSI Provider(Secrets Store CSI Driver)**: 시크릿을 **볼륨으로 마운트**해 파일로 제공.
- 둘 다 **앱 코드가 OpenBao를 직접 호출하지 않아도** 되고, **쿠버네티스 Secret에 평문을 두지 않아도** 된다는 게 장점이다.

```yaml
# Agent Injector 어노테이션 예 (Pod 템플릿)
metadata:
  annotations:
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/role: "app"                       # Kubernetes Auth role
    vault.hashicorp.com/agent-inject-secret-db: "database/creds/app"
```

> OpenBao는 Vault 호환이라 위 `vault.hashicorp.com/*` 류 어노테이션·차트가 그대로 통하는 경우가 많다(배포 차트에 따라 키 이름 확인).

## 8. 감사 로그 (Audit)

OpenBao는 **모든 요청·응답을 감사 디바이스로 기록**한다. "누가 언제 어떤 시크릿에 접근했는지"를 남겨 **추적·규정 준수(compliance)**에 쓴다. 민감한 값은 해시로 처리해 기록한다. 운영 보안의 기본은 감사 로깅을 켜 두는 것이다.

## 9. 흔한 함정

- **봉인 상태 방치**: 재시작/장애 후 unseal을 안 하면 OpenBao가 응답하지 않는다(auto-unseal 권장).
- **정책 과다 허용**: 와일드카드 남발로 최소권한 원칙 위반.
- **동적 시크릿 lease 관리 누락**: lease 갱신/폐기를 안 하면 계정이 쌓이거나 갑자기 만료돼 앱이 끊긴다.
- **루트 토큰 상시 사용**: 초기화용 root 토큰을 운영에 쓰지 말 것.

### 한 줄 요약
OpenBao는 **Vault 호환 오픈소스 시크릿 관리 시스템**으로, **시크릿 엔진(정적 KV·동적 DB 등)**으로 값을 저장·발급하고, **인증(Kubernetes Auth)+정책**으로 최소권한 접근을 통제하며, 데이터는 마스터 키로 암호화돼 **Shamir 기반 seal/unseal**로 보호된다. 쿠버네티스에선 **Auth + Agent/CSI 주입**으로 앱에 시크릿을 안전히 전달해, **etcd 평문 Secret의 한계(암호화·교체·동적 발급·감사 부족)**를 메운다.

### 참고 (공식 문서)
- OpenBao 문서 홈: https://openbao.org/docs/
- 시크릿 엔진: https://openbao.org/docs/secrets/
- 인증 방법(Kubernetes 등): https://openbao.org/docs/auth/
- 정책: https://openbao.org/docs/concepts/policies/
- Seal/Unseal 개념: https://openbao.org/docs/concepts/seal/
