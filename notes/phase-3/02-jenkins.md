# Jenkins

## 1. Why — 왜 쓰는가

오래 검증된 CI 도구. 빌드 + 테스트 + 이미지 push + manifest commit을 자동화하는 파이프라인 엔진.

**왜 Jenkins (대체재 비교)**:
- **GitHub Actions**: SaaS 우선, 본 프로젝트가 self-host MSA 인프라 컨셉이라 결이 안 맞음. private runner도 가능하나 self-host 메시지 약화.
- **GitLab CI**: GitLab과 묶음. GitHub repo 사용하는 본 프로젝트 부적합.
- **Tekton**: Kubernetes-native, 200MB 정도로 가벼움. 그러나 Groovy Shared Library 같은 자산 없음. 학습곡선 다름.
- **ArgoCD Workflows / Argo Workflows**: Argo 생태계 정합. Tekton 유사 성격.
- **Jenkins**: 토스 사용 + Groovy Shared Library 자산 풍부 + Kubernetes plugin으로 동적 agent 지원. 단점: controller 1GB로 무겁고 ARM64 호환성 일부 plugin 부족.

본 프로젝트가 Jenkins 선택한 narrative: "토스 정합 + Shared Library 자산 학습 가치". 면접에서 "Tekton 안 골랐어요?" → "Tekton도 검토했으나 본 프로젝트는 토스 스택 정합 우선, 또 운영 환경에서 Jenkins 자산이 더 광범위해서 학습 ROI가 큼"으로 답변.

**Jenkins의 핵심 가치**:
- 풍부한 plugin 생태계 (1800+ plugin)
- Shared Library로 파이프라인 재사용
- Kubernetes plugin: build agent를 Pod으로 동적 생성/소멸 → 자원 효율
- Pipeline as Code (Jenkinsfile in Git)

## 2. Architecture — 어떻게 구성되는가

**컴포넌트**:

- **Jenkins controller** (master): 단일 Pod. UI, 파이프라인 정의 저장, 빌드 스케줄링, plugin 관리. PV 필수 (job 이력, 설정).
- **Build agent** (slave): Kubernetes plugin으로 빌드 시점에 동적 생성되는 Pod. 빌드 완료 후 소멸.
- **JCasC** (Jenkins Configuration as Code): YAML로 Jenkins 자체 설정 관리. UI 클릭 대신 코드.

**Kubernetes plugin 메커니즘**:
- Jenkins controller가 Pod template 정의
- 빌드 트리거 시 controller가 k8s API에 Pod 생성 요청
- Pod 안에 inbound JNLP agent + 빌드 도구 컨테이너(예: maven, go, docker buildx) 함께 실행
- Build agent가 controller에 JNLP 연결, 빌드 step 수행
- 빌드 끝나면 Pod 자동 삭제

**Pod template 구조**:
```yaml
podTemplate(yaml: '''
  spec:
    serviceAccountName: jenkins
    imagePullSecrets:
    - name: ghcr-pull
    containers:
    - name: jnlp
      image: jenkins/inbound-agent:alpine
    - name: go
      image: golang:1.26-alpine
      command: ["cat"]
      tty: true
    - name: buildx
      image: moby/buildkit:latest
'''
```

## 3. Mechanism — 어떻게 돌아가는가

**전체 빌드 흐름**:

1. 개발자가 코드 push to GitHub
2. GitHub webhook이 Jenkins controller로 POST (HMAC 검증)
3. Controller가 매칭되는 job 식별, 빌드 trigger
4. Controller가 Kubernetes plugin에 빌드 agent Pod 생성 요청
5. k8s가 Pod 생성, agent container가 controller에 JNLP 연결
6. Controller가 파이프라인 stage들을 agent에 전송
7. Agent가 stage 수행:
   - `git clone` (jnlp 컨테이너)
   - `go build` 또는 `mvn package` (언어별 컨테이너)
   - `docker buildx build --platform=linux/arm64 --push` (buildx 컨테이너)
   - `cosign sign` (Phase 6-A, signImage 함수)
   - `git commit & push` to manifest repo (image tag 업데이트)
8. ArgoCD가 manifest repo 변경 감지 → 자동 sync → 배포
9. Pod 소멸, 빌드 결과를 controller에 보고

**Shared Library 동작**:
- Jenkins 전역 설정에 Shared Library 경로 등록 (별도 Git repo)
- 각 Jenkinsfile 첫 줄에 `@Library('shared-pipelines') _`
- 라이브러리의 vars/*.groovy 함수가 전역 함수로 사용 가능
- 변경은 라이브러리 repo에 commit으로

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Jenkins 의존 관계.

- **GitHub** — webhook 트리거, repo clone, manifest commit. HMAC secret 검증
- **GHCR** — Docker 이미지 push (write:packages token), pull (read:packages token, agent용 imagePullSecrets)
- **Manifest repo (GitHub)** — Jenkins가 빌드 후 image tag commit
- **Kubernetes plugin** — `cicd` namespace에서 동적 agent Pod 생성
- **Block Volume PV** — controller home dir + job history (20GB 권장)
- **ArgoCD** — 직접 연결 없음. Jenkins가 manifest commit하면 ArgoCD가 감지
- **Vault** (Phase 6) — Phase 6에서 4종 secret을 Vault Agent Injector로 마이그레이션
- **Trivy** (Phase 6-A) — Shared Library의 `scanImage()` placeholder, Phase 6-A에서 실제 구현
- **cosign** (Phase 6-A) — Shared Library의 `signImage()` placeholder

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install jenkins jenkins/jenkins \
  --namespace cicd --create-namespace \
  --version 5.x.x \
  -f values.yaml
```

values.yaml 핵심:
```yaml
controller:
  resources:
    requests: { cpu: 500m, memory: 1Gi }
    limits: { cpu: 1, memory: 2Gi }
  serviceType: ClusterIP   # HTTPRoute로 별도 노출
  ingress: { enabled: false }
  JCasC:
    configScripts:
      welcome-message: |
        jenkins:
          systemMessage: "OCI Always Free CI/CD"
  installPlugins:
    - kubernetes:4111.v0
    - workflow-aggregator:latest
    - github:latest
    - git:latest
    - configuration-as-code:latest

persistence:
  enabled: true
  storageClass: oci-bv
  size: 20Gi

serviceAccount:
  create: true
  name: jenkins

agent:
  enabled: true
  podRetention: Never
  containerCap: 2          # 동시 빌드 제한 (Always Free RAM 보호)
  imagePullSecrets: [ghcr-pull]
```

**필수 Secret 4종** (Phase 3에서 사전 생성):

```bash
# 1. GHCR push (write:packages)
kubectl create secret generic ghcr-push -n cicd \
  --from-literal=username=<gh-user> \
  --from-literal=token=<PAT-with-write:packages>

# 2. GHCR pull (read:packages, agent용)
kubectl create secret docker-registry ghcr-pull -n cicd \
  --docker-server=ghcr.io \
  --docker-username=<gh-user> \
  --docker-password=<PAT-with-read:packages>

# 3. GitHub manifest repo PAT (manifest commit)
kubectl create secret generic github-manifest-pat -n cicd \
  --from-literal=token=<fine-grained-PAT-repo-write>

# 4. Webhook HMAC secret
kubectl create secret generic gh-webhook-secret -n cicd \
  --from-literal=secret=<random-hmac-key>
```

**Jenkinsfile 예시** (Shared Library 사용):

```groovy
@Library('shared-pipelines') _

pipeline {
  agent {
    kubernetes {
      yaml libraryResource('podTemplates/go-buildx.yaml')
    }
  }
  stages {
    stage('Build') {
      steps {
        container('go') {
          sh 'go test ./...'
          sh 'go build -o app ./cmd/login'
        }
      }
    }
    stage('Image') {
      steps {
        container('buildx') {
          buildAndPush(
            image: 'ghcr.io/myorg/login',
            tag: env.GIT_COMMIT.take(7),
            platform: 'linux/arm64'
          )
        }
      }
    }
    stage('Scan') {
      steps {
        scanImage('ghcr.io/myorg/login', env.GIT_COMMIT.take(7))  // Phase 6-A
      }
    }
    stage('Sign') {
      steps {
        signImage('ghcr.io/myorg/login', env.GIT_COMMIT.take(7))  // Phase 6-A
      }
    }
    stage('Deploy') {
      steps {
        updateManifest(
          service: 'login',
          tag: env.GIT_COMMIT.take(7),
          repo: 'github.com/myorg/k8s-manifests'
        )
      }
    }
  }
}
```

**Shared Library 구조** (별도 repo):

```
shared-pipelines/
├── vars/
│   ├── buildAndPush.groovy
│   ├── scanImage.groovy        # Phase 6-A에서 채움
│   ├── signImage.groovy        # Phase 6-A에서 채움
│   └── updateManifest.groovy
├── src/
│   └── org/myorg/jenkins/      # 공유 클래스
└── resources/
    └── podTemplates/
        └── go-buildx.yaml
```

## 6. Configuration — 어떤 설정이 있는가

**JCasC (Configuration as Code)**:
- Jenkins 전체 설정을 YAML로 정의 → Git 관리
- UI 클릭 대신 ConfigMap으로 주입
- GHCR credential, GitHub webhook 설정 등 모두 코드로

**Kubernetes plugin 옵션**:
- `containerCap`: 동시 실행 가능한 agent Pod 최대 수 (본 프로젝트 2)
- `podRetention`: `Never`(즉시 삭제) / `OnFailure`(실패 시 디버깅 위해 유지) / `Always`
- `idleMinutes`: agent 유휴 시간 후 삭제 (default 0 = 즉시)
- `serviceAccount`: agent Pod이 사용할 SA

**Pipeline plugin 종류**:
- **Declarative Pipeline**: `pipeline { ... }` 블록, 구조화된 문법, 권장
- **Scripted Pipeline**: 순수 Groovy, 유연하나 복잡
- 본 프로젝트는 Declarative 사용, 복잡 로직만 Shared Library의 src/에 Scripted

**Build Trigger 옵션**:
- GitHub webhook (HMAC 검증)
- Polling (`pollSCM('H/5 * * * *')` — webhook 안 될 때 fallback)
- Cron (`cron('H 0 * * *')` — nightly 빌드)
- Manual

**Backup**:
- Jenkins 홈 디렉토리 통째로 backup → Velero (Phase 7)
- Configuration as Code 사용 시 controller 재구축이 쉬워짐 (PV 잃어도 JCasC + Git 매니페스트로 복원)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **Jenkins LTS 2.452+** (2026-05 기준), Kubernetes plugin 4.x
- **ARM64 호환성**: Jenkins controller official image는 ARM64 지원. 단 일부 plugin이 ARM64 미지원 — 빌드 시 검증 필수
- **Build agent base image**: jenkins/inbound-agent의 ARM64 variant 사용
- **JDK 21+** (Jenkins LTS 2.452부터 Java 17 또는 21)
- **Helm 3.x**

## 8. 면접 예상 질문 & 답변

**Q1. Jenkins 왜 골랐어요? Tekton이나 Argo Workflows가 더 가볍지 않나요?**
> 맞습니다. Tekton은 200MB 정도, Jenkins controller는 1GB라 자원 효율은 Tekton이 압도적입니다. 그럼에도 Jenkins를 고른 이유는 (1) 토스 스택 정합 — 토스가 Jenkins + Groovy Shared Library를 광범위하게 쓰고 있어서 실무 자산이 풍부하고, (2) Shared Library로 파이프라인 로직을 라이브러리로 공유하는 패턴이 학습 가치가 높습니다. 면접에서 "Tekton도 검토했지만 본 프로젝트는 토스 스택 정합과 Shared Library 학습 우선"이라고 답합니다. 운영 환경에서 자원 더 민감하면 Tekton 검토 가치 있다고 첨언합니다.

**Q2. Jenkins HA 안 한 이유는?**
> 의도된 단일 인스턴스입니다. Jenkins controller HA는 Jenkins Enterprise(유료)가 필요하고 OSS Jenkins는 active-passive조차 어렵습니다. 그래서 본 프로젝트는 (1) controller 단일 인스턴스, (2) Block Volume PV에 home directory 저장, (3) Velero로 PV 백업해서 controller 다운 시 빠른 복구 전략을 채택합니다. RTO 목표는 20분(Velero restore 10분 + 재기동 + 빌드 큐 회복 10분)이고, RPO는 24시간(Velero 일일 백업 + Git 매니페스트는 source of truth). 면접에서 "production에선 GitLab CI 또는 Tekton 같은 stateless 옵션이 HA에 유리하다"고 답할 수 있습니다.

**Q3. Kubernetes plugin이 뭐고 왜 쓰나요?**
> Jenkins 빌드 agent를 정적 VM이 아닌 k8s Pod으로 동적 생성하는 plugin입니다. 빌드 시작할 때 Pod 생성 → 빌드 수행 → 종료 시 Pod 삭제 흐름이라 (1) 자원이 빌드 시점에만 잡히고 idle 시간엔 0으로 떨어집니다. (2) 언어별로 다른 Pod template을 정의해서 Go 빌드는 golang 컨테이너, Java 빌드는 maven 컨테이너로 각각 처리 가능합니다. (3) 빌드 환경이 매번 깨끗해서 "내 머신에선 됐는데" 같은 문제가 없습니다. 본 프로젝트는 containerCap을 2로 제한해서 Always Free RAM을 보호합니다.

**Q4. Shared Library가 뭐예요? 왜 분리하나요?**
> Jenkins 파이프라인 코드를 별도 Git repo로 분리해서 여러 Jenkinsfile이 공통 함수를 재사용하게 만드는 메커니즘입니다. 본 프로젝트는 `buildAndPush`, `scanImage`, `signImage`, `updateManifest` 같은 핵심 함수를 Shared Library의 `vars/` 디렉토리에 두고, 각 service의 Jenkinsfile은 `@Library('shared-pipelines') _` 한 줄로 가져옵니다. 이 패턴의 장점은 (1) 파이프라인 로직 변경이 한 곳에서 끝남, (2) Trivy 도입 같은 cross-cutting 변경이 모든 service에 동시 반영, (3) Jenkinsfile 자체는 짧고 읽기 쉬워집니다.

**Q5. Image Updater 안 쓴 이유는?**
> 본 프로젝트는 Jenkins가 manifest repo에 직접 commit하는 방식을 채택했습니다. 사유는 (1) audit trail 단일화 — Jenkins commit message에 빌드 메타데이터(commit SHA, build number, scanned, signed)를 함께 남길 수 있어서 추적이 명확합니다. (2) ArgoCD Image Updater의 git write-back 모드도 GitOps 호환이지만 `.argocd-source-<app>.yaml` 파일로 override를 분리 기록하므로 매니페스트와 override가 두 군데로 흩어집니다. (3) Jenkins commit은 PR-based review도 가능합니다(직접 commit 대신 PR 생성하도록 변경 가능). 단점은 Jenkins가 manifest repo write 권한을 가져야 한다는 점인데, 이건 fine-grained PAT으로 scope 제한해서 폭발 반경을 줄입니다.

**Q6. ARM64 노드에 x86 이미지를 빌드해서 푸시하면 어떻게 되나요?**
> Pod이 ImagePullBackOff 또는 `exec format error`로 죽습니다. OKE A1.Flex 노드는 ARM64라 x86 이미지를 못 돌립니다. 본 프로젝트는 (1) Dockerfile multi-stage build + `--platform=linux/arm64` 명시, (2) Docker buildx 또는 podman buildah 같은 multi-arch 빌더 사용, (3) Jenkins build agent도 ARM64 노드에 떠야 하므로 jenkins/inbound-agent의 ARM64 variant 사용 — 세 가지를 모두 만족해야 합니다. 면접에서 자주 묻는 함정 영역입니다.

**Q7. GitHub webhook 보안은 어떻게 챙기나요?**
> HMAC SHA-256 서명 검증으로 갑니다. GitHub Webhook 설정에서 Secret 필드에 임의의 강한 문자열을 넣고, Jenkins의 GitHub plugin이 같은 secret을 알고 있어야 합니다. GitHub이 webhook을 보낼 때 `X-Hub-Signature-256` 헤더에 HMAC을 넣고, Jenkins가 body를 받아서 같은 secret으로 HMAC 계산 후 비교합니다. 일치하지 않으면 거부. 미설정 시 누구나 webhook URL로 빌드 트리거 가능 → 자원 고갈 또는 공급망 공격 벡터입니다. 본 프로젝트는 `gh-webhook-secret`이라는 k8s Secret으로 관리합니다.

**Q8. Jenkins controller의 4종 secret 관리는 어떻게 해요?**
> Phase 3에서는 plain k8s Secret으로 시작하고, Phase 6에서 Vault Agent Injector로 마이그레이션합니다. 4종은 (1) `ghcr-push` (이미지 push용), (2) `ghcr-pull` (build agent imagePullSecrets), (3) `github-manifest-pat` (manifest commit), (4) `gh-webhook-secret` (HMAC) 입니다. 각각 권한을 최소로 발급합니다 — ghcr-push는 write:packages만, ghcr-pull은 read:packages만, manifest PAT는 fine-grained로 특정 repo write만. 토큰 분리가 폭발 반경 제한의 핵심입니다.

**Q9. Jenkins 빌드 agent의 동시 실행은 어떻게 제한해요?**
> Kubernetes plugin의 `containerCap` 옵션입니다. 본 프로젝트는 2로 설정합니다. Jenkins controller가 빌드 큐를 받아도 동시에 띄우는 agent Pod이 2개를 넘지 않게 강제합니다. 미제한 시 PR 5개가 동시 머지되면 5개 빌드 agent가 동시에 떠서 각각 ~1GB RAM을 잡으므로 24GB 환경이 즉시 사고납니다. 빌드 큐 대기는 늘어나지만 OOM은 방지됩니다. 면접에서 자원 인식 답변으로 좋은 소재입니다.

**Q10. Jenkinsfile vs JCasC 차이는?**
> Jenkinsfile은 **파이프라인 정의** (빌드 흐름)고, JCasC는 **Jenkins 자체 설정** (plugin 목록, credential, agent template 등)입니다. Jenkinsfile은 각 service의 repo에 있고, JCasC는 Jenkins ConfigMap으로 주입됩니다. 둘 다 Git 관리라 Configuration as Code 원칙을 따르지만 lifecycle이 다릅니다. JCasC 변경은 Jenkins controller 재시작이 필요할 수 있고, Jenkinsfile 변경은 즉시 다음 빌드에 반영됩니다.

**Q11. Jenkins UI 노출은 어떻게 해요?**
> HTTPRoute + Gateway API로 노출합니다 (`jenkins.ggang.cloud`). 인증은 GitHub OAuth plugin으로 SSO 적용해서 admin/developer 그룹별 권한 분리합니다. 본 프로젝트는 Phase 6-D 테스트 결과만 보는 view-only 권한과 빌드 트리거 가능한 dev 권한, 시스템 설정 가능한 admin 권한 3단계로 RBAC를 설정합니다. 면접에서 가산점 영역입니다.

**Q12. Jenkins build cache는 어떻게 관리해요?**
> Build agent Pod이 매번 새로 만들어지면 Go module 또는 Maven 의존성 다운로드가 매 빌드마다 발생해서 빌드가 느려집니다. 본 프로젝트는 (1) Go의 경우 build agent Pod template에 `go-mod-cache` volume을 PV로 마운트하거나 emptyDir로 짧은 캐시, (2) Docker layer caching은 buildkit의 `--cache-from` 옵션으로 GHCR 이미지를 캐시 소스로 사용 — 두 가지로 빌드 시간을 절반 이하로 줄입니다. 단 PV 캐시는 동시 빌드 시 lock 충돌 가능성이 있으므로 buildkit의 in-cluster 캐시 + GHCR 캐시 조합이 더 안전합니다.
