# Kyverno + cosign

## 1. Why — 왜 쓰는가

**Kyverno**: Kubernetes-native policy engine. CRD 기반 admission policy + cluster-wide 검증/생성/변환.
**cosign**: 컨테이너 이미지 서명 + 검증 도구. Sigstore 프로젝트.

**왜 묶어서 다루는가**: 본 프로젝트의 supply chain 보안 narrative 핵심 조합. Jenkins가 빌드 후 cosign으로 이미지 서명 → Kyverno가 admission에서 서명 검증 → 서명 없는 이미지 배포 차단.

**PSA만으로 부족한 이유**:
- PSA는 Pod SecurityContext 검증만
- "GHCR 외 registry 이미지 거부" "latest 태그 금지" "cosign 서명 검증" 같은 정책은 PSA 범위 밖
- 더 유연한 정책 엔진 필요

**Kyverno의 해결**:
- YAML로 정책 작성 (OPA Rego보다 학습곡선 낮음)
- ClusterPolicy CR로 cluster-wide 적용
- validate / mutate / generate / cleanup 4가지 동작
- cosign 서명 검증 내장 지원 (`verifyImages`)

**대체재**:
- **OPA Gatekeeper**: Rego 언어. 강력하지만 학습곡선.
- **Kyverno**: YAML 기반. k8s-native. 본 프로젝트 정합.

## 2. Architecture — 어떻게 구성되는가

**Kyverno 컴포넌트**:
- **kyverno-admission-controller**: Mutating + Validating webhook
- **kyverno-background-controller**: 기존 리소스 정책 위반 백그라운드 스캔
- **kyverno-cleanup-controller**: cleanup 정책 처리
- **kyverno-reports-controller**: PolicyReport CR 생성

**Kyverno 정책 타입**:
- **validate**: 위반 시 거부 (또는 warn/audit)
- **mutate**: 매니페스트 자동 수정 (예: 모든 Pod에 label 추가)
- **generate**: 새 리소스 자동 생성 (예: NS 만들면 NetworkPolicy 자동)
- **verifyImages**: cosign 서명 검증

**cosign 동작 모델**:
- **Keyed signing**: 개인키/공개키 페어 사용 (전통 방식)
- **Keyless signing**: OIDC identity 기반 (Sigstore Fulcio + Rekor transparency log)
- 본 프로젝트는 keyed (단순 + 자체 키 관리)

## 3. Mechanism — 어떻게 돌아가는가

**Kyverno validate 흐름**:
1. 사용자가 매니페스트 apply
2. kube-apiserver admission → Kyverno webhook 호출
3. Kyverno가 매칭되는 ClusterPolicy 검색
4. 정책 평가 (예: image가 ghcr.io/myorg/* 패턴인지)
5. 위반 시 거부 + 에러 메시지

**cosign 서명 흐름** (Jenkins 파이프라인):
1. 빌드 → image push to GHCR
2. cosign이 image digest를 개인키로 서명
3. 서명을 GHCR에 OCI artifact로 push (별도 tag `sha256-<digest>.sig`)
4. 서명 검증은 Kyverno verifyImages 정책이 admission 단계에서 수행

**verifyImages 검증 흐름**:
1. Pod 매니페스트의 image field 추출
2. 해당 image의 cosign signature 조회 (registry에서)
3. ClusterPolicy의 공개키로 서명 검증
4. 검증 성공 → 통과, 실패 → admission 거부

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Kyverno + cosign 의존 관계.

- **Jenkins Shared Library** — `signImage()` 함수에서 cosign 호출
- **Vault** — cosign 개인키 저장 (Phase 6의 Vault 활용)
- **GHCR** — 서명 OCI artifact 저장
- **Kyverno ClusterPolicy** — admission에서 verifyImages 실행
- **PSA** — 보완 관계. PSA 통과 후 Kyverno 추가 검증.
- **Trivy** — 보완. Trivy는 빌드 시 CVE 차단, Kyverno는 admission 시 정책 차단.

## 5. Usage — 어떻게 쓰는가

**Kyverno 설치** (Helm):

```bash
helm install kyverno kyverno/kyverno \
  --namespace kyverno --create-namespace \
  --version 3.x \
  --set admissionController.replicas=2
```

**cosign 키 페어 생성** (Jenkins 환경):

```bash
cosign generate-key-pair
# cosign.key (private, Vault에 저장)
# cosign.pub (public, Kyverno ClusterPolicy에 embed)
```

**Vault에 cosign 개인키 저장**:

```bash
vault kv put secret/cicd/cosign \
  private_key=@cosign.key \
  password="<key-password>"
```

**Jenkins Shared Library `signImage()` 구현**:

```groovy
def call(String image, String tag) {
    container('cosign') {
        withCredentials([
            file(credentialsId: 'cosign-private-key', variable: 'COSIGN_KEY'),
            string(credentialsId: 'cosign-password', variable: 'COSIGN_PASSWORD')
        ]) {
            sh """
                cosign sign --key \$COSIGN_KEY \\
                  --yes \\
                  ${image}:${tag}
            """
        }
    }
}
```

**ClusterPolicy 1: GHCR 외 registry 거부**:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: only-ghcr-images
spec:
  validationFailureAction: Enforce
  rules:
  - name: check-ghcr
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [app]
    validate:
      message: "Only ghcr.io/myorg/* images allowed"
      pattern:
        spec:
          containers:
          - image: "ghcr.io/myorg/*"
```

**ClusterPolicy 2: latest 태그 금지**:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: disallow-latest-tag
spec:
  validationFailureAction: Enforce
  rules:
  - name: validate-image-tag
    match:
      any:
      - resources:
          kinds: [Pod]
    validate:
      message: "Image tag :latest is not allowed"
      pattern:
        spec:
          containers:
          - image: "!*:latest"
```

**ClusterPolicy 3: cosign 서명 검증** (핵심):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: verify-image-signatures
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
  - name: verify-signatures
    match:
      any:
      - resources:
          kinds: [Pod]
          namespaces: [app]
    verifyImages:
    - imageReferences:
      - "ghcr.io/myorg/*"
      attestors:
      - entries:
        - keys:
            publicKeys: |-
              -----BEGIN PUBLIC KEY-----
              <cosign.pub content>
              -----END PUBLIC KEY-----
```

**Break-glass 메커니즘** (긴급 hotfix):

```yaml
# Pod에 annotation 추가 시 verify 우회
metadata:
  annotations:
    break-glass: "true"
    break-glass-reason: "P1 incident #12345"
```

정책에 break-glass 예외:
```yaml
- name: verify-signatures
  match:
    any:
    - resources:
        kinds: [Pod]
  exclude:
    any:
    - resources:
        annotations:
          break-glass: "true"
  verifyImages:
  ...
```

별도 Slack 알람 + audit log 필수.

## 6. Configuration — 어떤 설정이 있는가

**validationFailureAction**:
- `Enforce`: 위반 시 거부
- `Audit`: 위반 시 PolicyReport에 기록만, 통과

**verifyImages 옵션**:
- `imageReferences`: 적용할 image pattern
- `attestors.keys.publicKeys`: 공개키 (여러 개 가능)
- `attestors.keyless`: keyless mode (Fulcio 사용)
- `mutateDigest: true`: tag 대신 digest로 mutate (immutable 강제)

**cosign 옵션**:
- `--key`: 개인키 경로
- `--yes`: 확인 프롬프트 자동 yes
- `--certificate-identity`: keyless mode identity
- `--annotations`: signature에 메타데이터 첨부

**Kyverno performance**:
- `webhookTimeoutSeconds`: webhook timeout (default 10s, verifyImages는 30s 권장 — registry 조회 시간)
- 정책 평가 caching

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **Kyverno 1.13+** (2026-05 권장, k8s 1.30+ 호환)
- **cosign 2.x+** (Sigstore 표준)
- **OCI Image Spec 1.1+** (signature artifact 저장)
- **GHCR**: cosign OCI artifact 지원 (모든 OCI registry 호환)

## 8. 면접 예상 질문 & 답변

**Q1. Kyverno와 PSA 어떻게 다르고 왜 둘 다 써요?**
> PSA는 k8s 내장으로 Pod SecurityContext만 검증합니다(restricted 프로파일 등). Kyverno는 더 유연한 정책 엔진으로 image registry 제한, latest tag 금지, 필수 label 강제, cosign 서명 검증 같은 PSA 범위 밖 정책을 처리합니다. 본 프로젝트는 PSA를 1차 방어선(SecurityContext 표준 강제) + Kyverno를 추가 레이어(image/registry/서명 정책)로 사용합니다. 보완 관계.

**Q2. cosign이 뭐고 왜 필요해요?**
> Container image signing 도구입니다. Sigstore 프로젝트의 일부. 이미지 빌드 후 개인키로 서명 → registry에 서명을 OCI artifact로 저장 → 배포 시 공개키로 검증. 왜 필요한가: (1) supply chain 공격 방어 — 누군가 GHCR에 악성 이미지 push해도 서명 없으면 admission 거부, (2) SLSA Level 2-3 충족 — supply chain security 표준, (3) audit — 어느 이미지가 정상 빌드 파이프라인 통과했는지 검증 가능. 본 프로젝트는 keyed signing + Vault에 개인키 저장.

**Q3. cosign keyed vs keyless signing 차이는?**
> Keyed는 전통적 방식 — 개인키/공개키 페어를 생성하고 직접 관리합니다. 단순하나 키 관리 부담 (회전, 백업, 유출 대응). Keyless는 OIDC identity 기반 — GitHub Actions OIDC token 같은 걸로 Sigstore Fulcio에서 임시 인증서 발급 → 그걸로 서명 → Rekor transparency log에 기록. 키 관리 불필요하나 OIDC provider 의존. 본 프로젝트는 단순성 + Vault 통합으로 keyed 선택. Jenkins에서 cosign 호출 시 Vault에서 개인키 가져옴.

**Q4. Kyverno verifyImages가 admission 단계에 호출되면 latency 안 늘어요?**
> 약간 늘어납니다. verifyImages는 registry에서 signature OCI artifact를 조회해야 해서 typically 500ms-2s 정도. 그래서 `webhookTimeoutSeconds: 30` 설정 권장. 정상 운영에서는 (1) Kyverno가 검증 결과 캐싱, (2) digest 기반 검증이라 매 deploy마다 재검증 안 함 — Pod 재시작 시점에만 영향. 본 프로젝트는 트래픽 작아서 영향 미미. 운영 환경 대규모는 admission 부담 모니터링 필요.

**Q5. Break-glass 메커니즘이 뭐고 왜 필요해요?**
> 긴급 사고 대응 시 정책을 우회할 수 있는 escape hatch입니다. P1 incident 발생 시 (예: production 다운, hotfix 즉시 배포 필요) cosign 서명 시간이 없을 수 있는데 모든 배포가 막히면 사고 악화. 본 프로젝트는 Pod annotation `break-glass: true` + `break-glass-reason` 추가 시 verifyImages 정책 우회 + Slack 알람 + audit log 강제. 우회 자체는 가능하지만 모든 사용이 추적되고 사후 review로 정상 절차 복구. 면접에서 운영 현실 인지 시그널.

**Q6. Trivy와 Kyverno 역할이 어떻게 달라요?**
> 시점이 다릅니다. Trivy는 **빌드 시점(CI)**에 CVE 차단 — 취약점 있는 이미지가 GHCR에 push 안 되게. Kyverno는 **배포 시점(admission)**에 정책 차단 — image tag, signature, registry 등 정책 위반 매니페스트 거부. 본 프로젝트는 둘 다 — Trivy 우회한 이미지가 있어도 Kyverno가 admission에서 한 번 더 차단. Defense in depth.

**Q7. cosign 공개키를 ClusterPolicy에 embed하면 키 회전 어떻게 해요?**
> 두 단계 회전. (1) 새 키 페어 생성 + 새 공개키를 ClusterPolicy에 **추가** (기존 공개키와 함께). 이 상태에서 Kyverno는 둘 중 하나로만 서명되어도 통과. (2) Jenkins가 새 키로 모든 새 이미지 서명 시작. (3) 충분한 기간 후 (예: 1개월) 모든 production 이미지가 새 키로 서명됐는지 확인. (4) ClusterPolicy에서 옛 공개키 제거. 무중단 회전. 본 프로젝트는 키 회전 정책 1년 주기.

**Q8. Kyverno mutate 정책의 예시는?**
> 본 프로젝트는 mutate를 보수적으로 사용하지만 가능한 예: (1) 모든 Pod에 `pod.kubernetes.io/managed-by: kyverno` label 자동 추가 (audit용), (2) 명시 안 된 SecurityContext default 주입, (3) image tag :latest를 자동으로 sha256 digest로 변환. mutate는 매니페스트를 자동 수정해서 사용자가 의도하지 않은 결과 가능 — GitOps drift 위험. 본 프로젝트는 validate 위주, mutate는 최소.

**Q9. ClusterPolicy 위반 시 PolicyReport는 어떻게 봐요?**
> Kyverno가 자동으로 PolicyReport CR을 namespace당 생성합니다. `kubectl get polr -n app`으로 namespace의 위반 리스트, `kubectl get cpolr`로 cluster-wide. PolicyReport는 (1) 정책 위반 추적, (2) Grafana 대시보드로 시각화 가능 (Prometheus exporter 통합), (3) audit 보고서 자료. 본 프로젝트는 validationFailureAction을 Enforce로 두지만 PolicyReport는 항상 생성되어 위반 시도 자체를 추적.

**Q10. SLSA framework와 본 프로젝트의 위치는?**
> SLSA(Supply-chain Levels for Software Artifacts) 4단계 표준: Level 1(빌드 출처 기록), Level 2(서명 + 인증된 빌드), Level 3(reproducible + isolated build), Level 4(2-person review + hermetic build). 본 프로젝트는 Trivy + cosign + Jenkins(single-tenant) + GHCR provenance 조합으로 **SLSA Level 2 수준**. Level 3는 reproducible build + 빌드 isolation 필요한데 Jenkins single-tenant는 충분치 않음. 면접에서 "SLSA Level 2 달성, Level 3는 reproducible build와 ephemeral builder 추가 필요" narrative.
