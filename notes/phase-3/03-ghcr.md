# GHCR (GitHub Container Registry)

## 1. Why — 왜 쓰는가

GitHub의 컨테이너 이미지 저장소. `ghcr.io/<owner>/<image>:<tag>` 형식으로 주소. Docker Hub의 대안.

**왜 GHCR (대체재 비교)**:
- **Docker Hub**: 가장 광범위하나 (1) 무료 사용자 anonymous pull 100/6h rate limit, authenticated 200/6h, (2) private repo 1개 무료 — 운영에는 부족, (3) 2020년 retention 정책 변경으로 inactive 이미지 삭제 위험.
- **AWS ECR**: AWS 종속. 본 프로젝트는 OCI라 부적합 + 비용 발생.
- **OCI Container Registry**: OCI Always Free에 포함 안 됨, 사용량 과금. 본 프로젝트 무료 제약 위반.
- **Harbor self-host**: 강력하나 별도 인프라 (~500MB RAM) 필요. Always Free 자원 부족.
- **GHCR**: GitHub repo와 통합, public 무료 + private 500MB 무료(개인), authenticated pull rate limit 더 관대, OCI registry 표준 준수, multi-arch 지원.

본 프로젝트가 GHCR을 고른 narrative: "GitHub repo 사용 중이라 통합이 자연스럽고, 자원 부담 없이 multi-arch ARM64 이미지를 무료로 호스팅 가능".

## 2. Architecture — 어떻게 구성되는가

**구조**:
- **Registry URL**: `ghcr.io`
- **Image path**: `ghcr.io/<owner>/<image>:<tag>` (owner = GitHub user 또는 org)
- **OCI Image Manifest v2 표준 준수**: Docker Manifest v2와도 호환
- **Multi-arch image**: 하나의 tag에 여러 architecture(linux/amd64, linux/arm64) variant 묶음 → 클라이언트 platform에 맞는 것 자동 선택

**Access control**:
- GitHub 사용자/Org의 일부로 관리
- Repository와 동일한 권한 모델
- Public/Private 분리
- Personal Access Token (PAT) 또는 GitHub App으로 인증

**Token scope (권한)**:
- `read:packages`: pull
- `write:packages`: push (자동으로 read 포함)
- `delete:packages`: 삭제

## 3. Mechanism — 어떻게 돌아가는가

**Push 흐름**:

1. Docker buildx로 이미지 빌드 (multi-arch)
2. `docker login ghcr.io -u <user> -p <PAT-with-write:packages>`
3. `docker tag` 또는 buildx로 `ghcr.io/<owner>/<image>:<tag>` 명명
4. `docker push ghcr.io/<owner>/<image>:<tag>`
5. GHCR이 이미지 layer를 받아서 저장 (blob, manifest)
6. 동일 layer는 deduplication

**Multi-arch push**:
- buildx가 ARM64 + AMD64 두 이미지를 각각 빌드
- 두 이미지를 가리키는 manifest list 생성
- 같은 tag로 manifest list만 push → 사용자는 단일 tag만 봄

**Pull 흐름**:

1. Kubernetes가 Pod 생성, image: ghcr.io/...
2. kubelet이 containerd에게 pull 요청
3. containerd가 노드의 imagePullSecrets에서 credential 조회
4. ghcr.io에 인증 (read:packages token)
5. Manifest 조회 → 노드의 architecture(ARM64)에 맞는 layer만 pull
6. Layer 압축 해제 → 컨테이너 실행

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 GHCR 의존 관계.

- **Jenkins** — 빌드 후 image push (`ghcr-push` token: write:packages)
- **Kubernetes Pod** — image pull (`ghcr-pull` imagePullSecrets: read:packages, agent용도 같은 secret)
- **GitHub repo** — 이미지가 어느 repo에 속하는지 명시 (`org.opencontainers.image.source` label)
- **Kyverno** (Phase 6-A) — verifyImages 정책으로 GHCR 외 registry 이미지 거부
- **cosign** (Phase 6-A) — GHCR 이미지에 cosign signature 첨부 (OCI artifact로 저장)
- **Trivy** (Phase 6-A) — GHCR 이미지 취약점 스캔

**Pull secret 분리 패턴**:
- `ghcr-push`: write:packages, Jenkins build stage 사용
- `ghcr-pull`: read:packages only, build agent Pod의 imagePullSecrets + app Pod의 imagePullSecrets
- 분리 이유: build agent가 탈취돼도 write 권한 없어서 이미지 변조 불가

## 5. Usage — 어떻게 쓰는가

**PAT 발급** (GitHub):
- Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Resource owner: 본인 또는 org
- Repository access: All repositories 또는 selected
- Permissions:
  - `ghcr-push`용: Contents read + Packages write
  - `ghcr-pull`용: Packages read

**Docker login**:

```bash
echo $GHCR_TOKEN | docker login ghcr.io -u <gh-user> --password-stdin
```

**Multi-arch buildx 빌드 + push**:

```bash
docker buildx create --name multiarch --use
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --tag ghcr.io/myorg/login:abc123 \
  --label "org.opencontainers.image.source=https://github.com/myorg/login" \
  --label "org.opencontainers.image.revision=abc123" \
  --push \
  .
```

**Kubernetes imagePullSecret 생성**:

```bash
kubectl create secret docker-registry ghcr-pull -n app \
  --docker-server=ghcr.io \
  --docker-username=<gh-user> \
  --docker-password=<PAT-with-read:packages>
```

**Pod에서 사용**:

```yaml
apiVersion: v1
kind: Pod
spec:
  imagePullSecrets:
  - name: ghcr-pull
  containers:
  - name: login
    image: ghcr.io/myorg/login:abc123
```

**또는 ServiceAccount에 imagePullSecrets 박기** (Pod마다 반복 안 함):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app
  namespace: app
imagePullSecrets:
- name: ghcr-pull
```

**이미지 검사**:

```bash
# manifest 조회
docker manifest inspect ghcr.io/myorg/login:abc123

# multi-arch 확인 (manifests 배열에 amd64/arm64)
```

**이미지 connect to repo** (GitHub UI):
- GHCR 이미지 페이지에서 "Connect repository" 버튼
- 또는 Dockerfile에 `LABEL org.opencontainers.image.source=https://github.com/myorg/login`
- 연결 시 README, license, vulnerability scanning 자동 연동

## 6. Configuration — 어떤 설정이 있는가

**Dockerfile label (OCI Image Spec)**:

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/myorg/login"
LABEL org.opencontainers.image.description="Login service for fintech MSA"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.revision="abc123def"
LABEL org.opencontainers.image.version="0.1.0"
```

**Visibility 설정** (GHCR UI):
- Public: 누구나 pull 가능, rate limit 더 느슨
- Private: PAT 필수, 무료 500MB까지

**Retention policy**:
- GHCR 기본 무제한 보존
- 수동으로 untag된 이미지 삭제 가능 (GitHub Actions의 `delete-package-versions` 사용)
- 본 프로젝트는 별도 retention policy 없음 (이미지 수 적음)

**Rate limit** (2026-05 기준):
- Anonymous pull: 1시간당 100 (IP 기준)
- Authenticated pull: 무제한 (사실상)
- Public 이미지 pull은 더 관대

**Image scanning** (GitHub 내장):
- Public 이미지는 자동 vulnerability scan
- 결과는 GitHub Security 탭에 표시
- 본 프로젝트는 Trivy를 Jenkins에서 별도 실행 (Phase 6-A) — GitHub 내장은 보조

## 7. Compatibility — 어떤 호환성이 요구되는가

- **OCI Image Spec v1.0+** 준수 (Docker Image Spec과도 호환)
- **Docker buildx 0.10+** (multi-arch 지원)
- **containerd 1.6+** (기본 OCI registry 지원)
- **Kubernetes**: imagePullSecrets는 모든 버전 호환
- **Multi-arch image**: linux/arm64, linux/amd64 모두 지원. windows/* 등도 가능
- **OCI Artifact**: cosign signature가 OCI artifact로 저장됨 (별도 tag, `.sig` 또는 `.att`)

## 8. 면접 예상 질문 & 답변

**Q1. GHCR을 Docker Hub 대신 고른 이유는?**
> 세 가지 이유입니다. (1) GitHub repo를 이미 쓰고 있어서 이미지가 같은 권한 모델로 관리됩니다 — Org/team 권한이 그대로 적용됩니다. (2) Docker Hub의 rate limit이 anonymous 100/6h, authenticated 200/6h로 빡빡한데 GHCR은 authenticated가 사실상 무제한입니다. Build agent가 imagePullBackOff로 죽는 사고가 안 납니다. (3) Private 이미지가 500MB 무료라 개인 프로젝트에 충분합니다. Docker Hub는 private 1개만 무료입니다. 본 프로젝트 narrative와 정합합니다.

**Q2. Multi-arch 이미지가 뭐고 왜 필요해요?**
> 하나의 image tag가 여러 architecture(linux/amd64, linux/arm64)에 대한 binary를 가지는 구조입니다. Manifest list가 각 architecture variant를 가리키고, 클라이언트가 pull할 때 자기 architecture에 맞는 것만 받습니다. 본 프로젝트는 OKE A1.Flex 노드가 ARM64라 ARM64 variant가 필수입니다. multi-arch로 빌드하면 x86 개발 머신에서도 같은 tag로 테스트 가능하고 ARM64 노드에서도 동작합니다. Docker buildx가 이 multi-arch 빌드의 표준 도구입니다.

**Q3. ghcr-push와 ghcr-pull token을 왜 분리해요?**
> 폭발 반경 제한입니다. Build agent Pod이 탈취되면 그 Pod이 마운트한 imagePullSecrets가 노출됩니다. 만약 같은 token이 push 권한도 가지면 공격자가 임의 이미지를 GHCR에 push해서 supply chain 공격이 가능해집니다. read:packages만 가진 token이면 최악의 경우에도 이미지 변조는 불가능합니다. 비슷한 원리로 manifest commit PAT도 별도, webhook secret도 별도로 4종 분리합니다. 면접에서 보안 마인드 어필 영역입니다.

**Q4. imagePullSecrets를 Pod마다 명시하나요, ServiceAccount에 박나요?**
> 본 프로젝트는 ServiceAccount에 박는 패턴입니다. namespace의 default SA 또는 명시적 SA의 `imagePullSecrets` 필드에 ghcr-pull을 한 번만 추가하면 그 SA를 사용하는 모든 Pod이 자동으로 imagePullSecrets를 상속받습니다. Pod마다 반복 작성하지 않아도 되고, ArgoCD가 매니페스트 변경 추적 시 Pod spec이 깔끔합니다. 단점은 SA를 안 쓰는 Pod(default SA)이 자동 적용 안 받으니 모든 Pod이 명시적 SA를 쓰도록 강제해야 합니다 (PSA restricted와 호환).

**Q5. Multi-arch 이미지 빌드는 어떻게 해요?**
> Docker buildx로 합니다. `docker buildx create --name multiarch --use`로 buildx 인스턴스를 만들고 `--platform linux/arm64,linux/amd64` 옵션으로 빌드합니다. buildx는 내부적으로 QEMU emulation 또는 multi-node builder를 사용해서 ARM64를 x86 머신에서도 빌드 가능합니다. Push도 `--push` 플래그로 한 번에 처리됩니다. Jenkins build agent는 buildx 컨테이너를 별도로 띄워서 빌드합니다. Pod template에 `moby/buildkit` 이미지를 buildx 컨테이너로 정의합니다.

**Q6. GHCR rate limit이 진짜 무제한인가요?**
> Authenticated 사용자의 경우 사실상 무제한입니다(공식 발표 기준). Anonymous는 시간당 100회 제한이라 Public 이미지를 PAT 없이 pull하면 build agent가 막힐 수 있습니다. 본 프로젝트는 (1) 모든 build agent에 ghcr-pull token mount, (2) 같은 이미지 layer를 캐시해서 중복 pull 회피, (3) Private 이미지는 authenticated 필수라 자동으로 안전 — 세 가지로 rate limit 문제를 회피합니다.

**Q7. 이미지에 source repo는 어떻게 연결하나요?**
> Dockerfile에 `LABEL org.opencontainers.image.source=https://github.com/myorg/login` 추가하면 GHCR이 이 라벨을 보고 GitHub repo와 자동 연결합니다. 연결되면 GHCR 페이지에 README가 자동 표시되고, GitHub Security 탭에서 vulnerability scan 결과를 같이 봅니다. 본 프로젝트는 모든 Dockerfile에 OCI Image Spec 라벨 5종(source, description, license, revision, version)을 추가하는 것을 표준으로 박았습니다. revision은 git commit SHA로 자동 주입합니다.

**Q8. 이미지 tag로 latest 쓰면 안 되는 이유는?**
> Phase 6-A의 Kyverno 정책으로 latest tag 배포를 차단합니다. 이유는 (1) latest는 mutable tag라 같은 이름이 다른 이미지를 가리킬 수 있어서 rollback이 불명확합니다. (2) Pod 재시작 시 latest의 새 버전이 pull되어 의도치 않은 배포가 발생합니다. (3) audit trail이 "latest를 배포했다"로만 남아서 무엇이 배포됐는지 모릅니다. 본 프로젝트는 image tag = git commit SHA(예: `abc123def`)로 강제합니다. 한 commit이 한 이미지에 매핑되어 immutable + traceable입니다.

**Q9. cosign signature는 GHCR에 어떻게 저장되나요?**
> OCI Artifact로 저장됩니다. cosign이 이미지 tag `abc123` 옆에 `sha256-<digest>.sig` 같은 별도 tag로 signature를 push합니다. 이게 OCI Artifact 표준이라 GHCR이 일반 이미지처럼 보관합니다. Kyverno verifyImages 정책이 배포 시 cosign signature 존재를 검증하고, 없으면 거부합니다. Phase 6-A에서 본격 적용하지만 Phase 3에서 Shared Library에 placeholder만 박아둡니다.

**Q10. GHCR에 이미지가 너무 많이 쌓이면 어떻게 관리해요?**
> 본 프로젝트는 image tag = git commit SHA라 PR이 늘어날수록 이미지가 무한 누적됩니다. 관리 방법은 (1) GHCR retention policy로 untagged manifest 또는 30일 이상 미사용 이미지 자동 삭제, (2) GitHub Actions의 `delete-package-versions` action으로 주기적 cleanup, (3) production 배포된 commit만 별도 tag로 promote(`v1.0.0` 같은 semantic version)해서 보호. 본 프로젝트는 단순화를 위해 (1) untagged 30일만 적용하고 나머지는 무제한 보존합니다. 면접에서 "운영 환경에선 더 적극적 retention 필요"로 답할 수 있습니다.

**Q11. GHCR 외 registry를 차단하는 정책은 어떻게 박나요?**
> Kyverno의 ClusterPolicy로 admission webhook 단계에서 검증합니다. 정책 예시: `validate.pattern.spec.containers[*].image: "ghcr.io/myorg/*"`. 매니페스트의 image 필드가 이 패턴에 안 맞으면 admission 단계에서 거부됩니다. Docker Hub 같은 외부 registry 이미지가 실수로 들어오는 것을 방지합니다. Phase 6-A에서 본격 적용합니다.

**Q12. Docker Hub에서 GHCR로 마이그레이션하면 어떻게 해요?**
> 본 프로젝트는 처음부터 GHCR이라 해당 없지만 답변 준비. 마이그레이션 절차: (1) Docker Hub의 이미지 목록 수집, (2) `docker pull` → `docker tag ghcr.io/...` → `docker push`로 각 이미지 복제, (3) Kubernetes 매니페스트의 image URL 변경 (sed 또는 PR), (4) imagePullSecrets를 ghcr-pull로 교체, (5) Kyverno 정책으로 Docker Hub 차단 추가. 다운타임 없이 점진 전환 가능하고, 본 프로젝트 narrative는 "처음부터 GHCR 선택"이지만 마이그레이션 경로도 답할 수 있습니다.
