1# Trivy

## 1. Why — 왜 쓰는가

종합 보안 스캐너. 컨테이너 이미지, IaC, Kubernetes manifest, Git repository 등의 취약점을 한 도구로 스캔.

**컨테이너 이미지 보안의 문제**:
- Base image에 누적된 OS-level CVE
- 앱 의존성 라이브러리의 취약점 (예: Spring4Shell)
- Dockerfile misconfiguration (root user 사용 등)
- 빌드 시점에 안 잡으면 production 배포 후 발견 → 대응 비용 폭증

**Trivy의 해결**:
- **다섯 가지 스캔 종류 한 도구로**:
  1. Container image vulnerability (OS package + 언어별 라이브러리)
  2. IaC misconfiguration (Terraform, k8s YAML)
  3. Secret detection (코드에 박힌 API key, 비밀번호)
  4. License compliance
  5. SBOM (Software Bill of Materials) 생성
- **Jenkins 파이프라인 통합**: 빌드 후 즉시 스캔, CRITICAL 발견 시 차단
- **Free + 오픈소스** (Aqua Security)

**대체재**:
- **Snyk**: 풍부한 UI + 유료
- **Anchore**: 오픈소스, Trivy보다 무거움
- **Clair (Quay 내장)**: OS-level만, 라이브러리 부족
- **GitHub Advanced Security**: GitHub 통합, repo만 (이미지 미지원)
- **Trivy**: 가장 광범위 + 가벼움 + Helm chart로 k8s operator 가능

본 프로젝트는 **Jenkins 파이프라인에서 단발 스캔** + 향후 **Trivy Operator로 cluster 내 지속 스캔** 검토.

## 2. Architecture — 어떻게 구성되는가

**Trivy 동작 방식 두 가지**:
1. **CLI**: 단발 실행. `trivy image <image>` 같은 명령. Jenkins 같은 파이프라인 통합.
2. **Trivy Operator**: k8s에 설치. cluster 내 모든 이미지 + 매니페스트 지속 스캔. CR 형태로 결과 저장.

**Vulnerability database**:
- Aqua가 매일 업데이트하는 종합 DB
- NVD (National Vulnerability Database) + GitHub Security Advisories + 언어별 advisory + 벤더 advisory
- 첫 실행 시 다운로드 (~500MB), 이후 캐시 + 매번 update 체크

**스캔 대상**:
- **OS packages**: apt, apk, yum, etc. (CVE)
- **Language packages**: Go modules, npm, pip, Maven, etc.
- **IaC**: Terraform, k8s YAML, Dockerfile, Helm chart
- **Secrets**: 정규식 + entropy로 API key, 비밀번호 감지
- **Licenses**: OSS license 종류 (GPL 등 위험 license 탐지)

## 3. Mechanism — 어떻게 돌아가는가

**이미지 스캔 흐름**:
1. `trivy image ghcr.io/myorg/login:abc123` 실행
2. Trivy가 이미지 manifest pull
3. 각 layer의 metadata 분석 → OS 종류, 설치된 package 식별
4. Trivy DB에서 해당 package version의 CVE 검색
5. 언어별 dependency file(go.sum, package-lock.json) 파싱 → 라이브러리 CVE 검색
6. 결과 출력 (severity별: CRITICAL/HIGH/MEDIUM/LOW/UNKNOWN)

**Severity 결정**:
- CVSS score 기반
- CRITICAL: 9.0-10.0, HIGH: 7.0-8.9, MEDIUM: 4.0-6.9, LOW: 0.1-3.9
- 일부 CVE는 fix unavailable (패치 없음)

**False positive 처리**:
- `.trivyignore` 파일에 CVE ID 명시
- 또는 annotation으로 특정 vulnerability 제외
- 본 프로젝트는 PR 리뷰 거쳐 .trivyignore 변경

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Trivy 의존 관계.

- **Jenkins** (Phase 3 Shared Library의 `scanImage()` placeholder) — 빌드 후 스캔 실행
- **GHCR** — 스캔 대상 이미지 위치
- **Grafana** (선택) — 스캔 결과 대시보드 (Trivy Operator + Prometheus 통합 시)
- **Kyverno** (Phase 6-A) — 보완 관계. Trivy는 빌드 시 차단, Kyverno는 admission 시 차단.

**파이프라인 통합 흐름**:
1. Jenkins: build → image push to GHCR
2. Jenkins: `trivy image ghcr.io/...` 실행
3. CRITICAL fix-available 있으면 → 파이프라인 fail, 배포 차단
4. Slack 알림 + 리포트 Jenkins 아티팩트 저장

## 5. Usage — 어떻게 쓰는가

**CLI 설치** (Jenkins build agent):

```bash
# Container image로 사용 (권장, 별도 설치 불필요)
docker run --rm aquasec/trivy:0.58.0 image ghcr.io/myorg/login:abc123

# 또는 binary
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin
```

**이미지 스캔 (기본)**:

```bash
trivy image \
  --severity CRITICAL,HIGH \
  --ignore-unfixed \              # fix 없는 CVE 제외 (운영 정책)
  --exit-code 1 \                  # CRITICAL/HIGH 있으면 exit 1
  --format table \
  ghcr.io/myorg/login:abc123
```

**JSON 출력 + 리포트 저장**:

```bash
trivy image \
  --format json \
  --output trivy-report.json \
  ghcr.io/myorg/login:abc123

# 또는 SARIF (GitHub Security 통합용)
trivy image --format sarif --output trivy.sarif <image>
```

**Jenkins Shared Library `scanImage()` 구현** (Phase 3 placeholder 채움):

```groovy
def call(String image, String tag) {
    container('trivy') {
        sh """
            trivy image \\
              --severity CRITICAL \\
              --ignore-unfixed \\
              --exit-code 1 \\
              --format json \\
              --output trivy-${tag}.json \\
              ${image}:${tag}
        """
        archiveArtifacts artifacts: "trivy-${tag}.json"
    }
}
```

podTemplate에 trivy 컨테이너 추가:

```yaml
containers:
- name: trivy
  image: aquasec/trivy:0.58.0
  command: ["cat"]
  tty: true
```

**`.trivyignore` 파일** (false positive 관리):

```
# CVE-2024-12345: Java library X, 본 프로젝트 사용 안 함 (false positive)
CVE-2024-12345

# CVE-2024-67890: base image OS, fix 예정 2025-Q1
CVE-2024-67890
```

**IaC 스캔** (Terraform):

```bash
trivy config terraform/
# k8s manifest 스캔
trivy config kubernetes/
```

**Secret 스캔** (코드에 박힌 비밀번호):

```bash
trivy fs --scanners secret .
```

**Trivy Operator** (cluster 내 지속 스캔, 선택):

```bash
helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system --create-namespace \
  --set="trivy.ignoreUnfixed=true"
```

- 자동으로 모든 Pod의 이미지 스캔
- VulnerabilityReport CR로 결과 저장
- Prometheus 메트릭 노출

## 6. Configuration — 어떤 설정이 있는가

**Severity 필터**:
- `--severity CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN` 조합
- 본 프로젝트는 CRITICAL만 차단, 나머지는 리포트만

**Fix 옵션**:
- `--ignore-unfixed`: fix 없는 CVE 제외. base image OS CVE는 보통 운영자가 제어 불가라 제외 권장.
- 본 프로젝트는 `--ignore-unfixed` 켜고, base image 자체를 주기적 업데이트(월 1회)로 대응

**Scanners 옵션**:
- `--scanners vuln,secret,config,license`: 모든 종류
- 본 프로젝트는 image는 vuln만, code는 secret + config

**Output 형식**:
- `table` (default), `json`, `sarif`, `template`
- SARIF는 GitHub Security 통합용
- 본 프로젝트는 json (파싱 자동화)

**Cache**:
- DB 캐시 위치: `$HOME/.cache/trivy/db`
- `--cache-dir` 옵션으로 변경
- CI 환경에서는 PV에 캐시 마운트로 재사용

**Exit code**:
- `--exit-code 1`: 발견 시 fail
- `--exit-code 0`: 항상 성공 (리포트만)

**.trivyignore 파일 위치**:
- 스캔 디렉토리 또는 image의 working dir
- 또는 `--ignorefile <path>`로 명시

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Trivy 0.55+** (2026-05 권장). 매월 업데이트.
- **DB 업데이트**: 매일 자동, 인터넷 접근 필요
- **이미지 형식**: OCI Image v1.0+, Docker Image v2
- **Jenkins**: container-based runner 또는 binary install
- **Trivy Operator**: k8s 1.27+
- **ARM64**: native 지원 (트리비 binary + image 모두)

## 8. 면접 예상 질문 & 답변

**Q1. Trivy를 왜 골랐어요? Snyk나 Anchore도 있는데.**
> 세 가지 이유입니다. (1) 오픈소스 + 무료 — Snyk는 일정 규모 이상 유료, 본 프로젝트 self-host 컨셉에 정합. (2) 한 도구로 5가지 스캔 종류 — 이미지 CVE, IaC, secret, license, SBOM. Anchore는 더 무겁고 별도 인프라 필요. (3) 가벼움 + 빠름 — Trivy는 단일 binary + Jenkins 컨테이너로 통합 쉬움. 본 프로젝트는 Jenkins 파이프라인 통합이 핵심이라 빠른 단발 실행이 중요합니다. 면접에서 "운영 환경에서 Trivy Operator로 cluster 내 지속 스캔 추가 가능"이라 확장 narrative.

**Q2. CRITICAL fix-available은 차단, CRITICAL fix-unavailable은 통과시키는 이유는?**
> 운영 정책의 trade-off입니다. fix-unavailable CVE는 (1) 운영자가 직접 패치할 수 없음, (2) base image upgrade 외 대응 방법 없음, (3) 차단하면 빌드 자체가 안 되어서 새 release가 막힘. 그래서 `--ignore-unfixed`로 통과시키고, base image 자체를 월 1회 주기적 업데이트하는 정책으로 대응합니다. 면접에서 "fix-unavailable이지만 critical exploit이 알려지면 즉시 base image upgrade trigger"라 답하면 더 좋습니다.

**Q3. False positive는 어떻게 처리해요?**
> `.trivyignore` 파일로 관리합니다. 발견된 CVE가 실제로 본 프로젝트에 영향 없는 경우(예: Java 취약점인데 Go 앱이라 무관) ignore 추가. 단 두 가지 원칙: (1) PR 리뷰 거쳐 추가 — 임의 ignore 금지. (2) 코멘트로 ignore 이유 명시 — "왜 false positive인지" 1년 후에도 알 수 있게. 본 프로젝트는 .trivyignore 변경을 PR로만 허용하고 SRE 팀 리뷰 강제.

**Q4. base image CVE가 누적되는데 어떻게 대응해요?**
> 월 1회 base image upgrade를 정책으로 박습니다. Dockerfile의 base image를 `gcr.io/distroless/static-debian12:nonroot`처럼 명확히 명시하고, 매월 첫 주에 (1) base image 새 release 확인, (2) 모든 service의 base image tag 업데이트 PR, (3) Jenkins 빌드 + Trivy 스캔으로 새 CVE 확인. 본 프로젝트는 distroless를 사용해서 OS CVE가 매우 적고 (~5MB 이미지), Alpine이나 Ubuntu 대비 관리 부담이 1/10 수준입니다.

**Q5. Trivy Operator vs CLI 어느 게 나은가요?**
> 보완 관계입니다. CLI는 빌드 시점(Jenkins)에 단발 스캔 — 새 이미지를 production 가기 전에 차단. Operator는 cluster 내 모든 이미지를 지속 스캔 — Trivy DB가 매일 업데이트되므로 이미 배포된 이미지의 새 CVE도 발견 가능합니다. 본 프로젝트는 (1) Phase 6에서 Jenkins CLI 통합부터 — 신규 빌드 차단이 핵심, (2) 추후 Trivy Operator 추가 — 운영 중 이미지의 새 CVE 발견. 면접에서 "두 가지 다 가치 있고 단계적 도입"이라 답합니다.

**Q6. Trivy DB는 어디서 가져와요? 인터넷 차단 환경에서는?**
> Aqua Security의 GitHub release에서 가져옵니다. 매일 업데이트. 인터넷 차단 환경(air-gapped)에서는 (1) `trivy --skip-update` + 미리 다운로드한 DB 사용, (2) Aqua의 private mirror 설정, (3) 자체 mirror 운영. 본 프로젝트는 인터넷 접근 있는 환경이라 자동 업데이트 사용. Jenkins build agent의 캐시 PV에 DB 저장해서 매 빌드마다 재다운로드 안 함.

**Q7. SBOM은 뭐고 왜 중요해요?**
> Software Bill of Materials. 이미지 안에 들어있는 모든 software component 명세입니다. Trivy `--format spdx`로 생성. 중요한 이유: (1) supply chain 공격 시 영향받는 component 빠르게 식별 (예: log4j CVE 발생 시 "어느 이미지가 log4j 사용?" 즉답), (2) license 감사 — 어떤 OSS license가 포함되어 있는지, (3) 컴플라이언스 요구사항 (US 정부 EO 14028 등 SBOM 의무화 흐름). 본 프로젝트는 buildx `--sbom=true`로 빌드 시 자동 생성 + GHCR에 OCI artifact로 저장.

**Q8. CI에서 Trivy 실행이 너무 느려요. 어떻게 빨라져요?**
> 다섯 가지 최적화. (1) DB 캐시 PV — Jenkins build agent에 trivy DB 캐시 마운트, 매번 500MB 다운로드 안 함. (2) `--scanners vuln`만 — secret이나 license 스캔 빼면 빠름. (3) `--severity CRITICAL,HIGH`만 — MEDIUM 이하 무시. (4) `--ignore-unfixed` — fix 없는 CVE 빠르게 skip. (5) layer 캐싱 — buildx layer cache로 base image 부분 재스캔 안 함. 본 프로젝트는 이 다섯 가지 모두 적용해서 빌드당 Trivy 시간 ~30초로 유지.

**Q9. Kyverno와 Trivy 둘 다 쓰는데 역할이 어떻게 달라요?**
> 시점이 다릅니다. Trivy는 **빌드 시점(CI)**에 CVE 차단 — 취약점 있는 이미지가 GHCR에 push 안 되게 또는 manifest commit 안 되게. Kyverno는 **배포 시점(admission)**에 정책 차단 — image tag, signature, 기타 정책 위반 매니페스트가 k8s API server에 반영 안 되게. 둘은 보완 관계로 본 프로젝트는 둘 다 적용. Trivy를 우회한 매니페스트가 있어도 Kyverno가 admission에서 한 번 더 차단. defense in depth.

**Q10. Trivy 결과를 Grafana로 시각화하면 좋아요?**
> Trivy Operator를 쓰면 Prometheus 메트릭이 자동 노출되어 Grafana 대시보드 가능합니다. namespace별 / severity별 CVE 수, 시간에 따른 CVE 추이 등. 본 프로젝트는 CLI 위주라 즉시 적용은 안 되지만, Trivy Operator 추가 시 Grafana 대시보드 30분이면 만듭니다. 면접에서 "단계적 관측력 확장" 영역으로 답변 가능. 면접관이 보안 가시화에 관심 있으면 가산점.

**Q11. SLSA framework와 Trivy 관계는?**
> SLSA(Supply-chain Levels for Software Artifacts)는 supply chain 보안 표준. Level 1(빌드 출처), 2(서명), 3(reproducible build) 등 단계적. Trivy는 SLSA의 vulnerability detection 부분을 담당하지만 SLSA 자체는 아님. SLSA는 cosign 서명(Phase 6-A의 Kyverno + cosign 항목), build provenance, hermetic build 등 더 넓은 영역. 본 프로젝트는 Trivy + cosign + buildx provenance 조합으로 SLSA Level 2 수준 supply chain 보안 narrative 구축.

**Q12. Trivy를 우회한 이미지가 production에 가는 경우는 어떻게 막아요?**
> 다중 방어선입니다. (1) Jenkins Shared Library의 scanImage()를 모든 service Jenkinsfile에 강제 호출. (2) Kyverno admission으로 image tag = git commit SHA 강제 — manual로 latest 같은 tag 배포 차단. (3) Kyverno cosign signature 검증 — 정상 빌드 파이프라인을 통과한 이미지만 서명되므로 우회 이미지는 admission 거부. (4) GHCR push 권한을 Jenkins SA만 — 사람이 직접 push 못 함. 네 가지 조합으로 우회 거의 불가능. 면접에서 강력한 narrative.
