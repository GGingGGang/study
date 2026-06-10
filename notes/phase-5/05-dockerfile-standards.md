# Dockerfile 표준 (ARM64 + Distroless + Non-root)

## 1. Why — 왜 쓰는가

Dockerfile은 단순 "이미지 빌드 방법"이 아니라 **보안 + 자원 효율 + 운영 안정성**의 출발점. 본 프로젝트의 4가지 표준:

1. **Multi-stage build**: 빌드 환경과 실행 환경 분리
2. **ARM64 빌드**: A1.Flex 노드 정합
3. **Distroless / Scratch base**: CVE 표면 최소화
4. **Non-root user**: PSA restricted 충족

**naive Dockerfile의 문제**:
- `FROM ubuntu` 같은 풀 OS base → 이미지 500MB+, CVE 수십 개
- `RUN apt install ...` 누적 → 빌드 도구가 runtime에 남음
- `USER root` → 컨테이너 escape 시 호스트 영향
- AMD64로 빌드 → A1.Flex 노드에서 `exec format error`

## 2. Architecture — 어떻게 구성되는가

**Multi-stage build**:
```dockerfile
# Stage 1: builder (큰 base, 빌드 도구)
FROM golang:1.26-alpine AS builder
WORKDIR /src
COPY . .
RUN go build -o app ./cmd/login

# Stage 2: runtime (최소 base)
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /src/app /app
USER nonroot:nonroot
ENTRYPOINT ["/app"]
```

빌드 결과: ~20MB 이미지. 빌드 도구는 stage 1에만 존재.

**Base image 선택**:
- `scratch`: 완전 비어있음. Go 같은 statically-linked binary만 가능. 5MB.
- `gcr.io/distroless/static-debian12:nonroot`: glibc 없음, statically-linked만. ~5MB. **본 프로젝트 권장**.
- `gcr.io/distroless/base-debian12:nonroot`: glibc 있음. dynamic linking 필요한 경우. ~20MB.
- `alpine:3.20`: 작지만(~5MB) musl libc 사용. 호환성 문제 가능.
- `ubuntu/debian`: 풀 OS, 절대 비권장.

## 3. Mechanism — 어떻게 돌아가는가

**Multi-arch 빌드 (buildx)**:
1. `docker buildx create --use`로 builder 인스턴스 생성
2. QEMU emulation 또는 multi-node builder 활용
3. `--platform=linux/arm64,linux/amd64`로 두 architecture 동시 빌드
4. 각 architecture별 이미지 → manifest list로 묶음 → 단일 tag로 push
5. Pull 시 클라이언트(노드)가 자기 architecture에 맞는 variant만 받음

**Distroless 동작**:
- shell 없음 (`sh`, `bash`) → `kubectl exec` 디버깅 어려움 (debug 컨테이너 사용)
- package manager 없음 → 런타임에 의존성 추가 불가
- 최소 라이브러리만 (libc 또는 없음)
- 결과: CVE 표면 1/100 수준

**Non-root user**:
- `runAsNonRoot: true` PSA restricted 요구사항
- Dockerfile의 `USER nonroot:nonroot` (distroless 내장 user)
- 또는 custom UID/GID: `USER 1000:1000`

## 4. Integration — 어떻게 연결하는가

- **Jenkins build agent** — Docker buildx로 multi-arch 빌드
- **GHCR** — 빌드 결과 push (이미 multi-arch manifest)
- **OKE A1.Flex 노드** — ARM64 variant 자동 pull
- **PSA restricted** — non-root + read-only root filesystem 충족
- **Kyverno** (Phase 6-A) — image tag = git commit SHA 강제, latest 금지
- **Trivy** (Phase 6-A) — 빌드 후 CVE 스캔

## 5. Usage — 어떻게 쓰는가

**Go 앱 Dockerfile** (본 프로젝트 표준):

```dockerfile
# syntax=docker/dockerfile:1.7

# Stage 1: Build
FROM --platform=$BUILDPLATFORM golang:1.26-alpine AS builder

ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

# Dependency caching layer
COPY go.mod go.sum ./
RUN go mod download

# Build
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -ldflags="-s -w" -o /app ./cmd/login

# Stage 2: Runtime
FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /

COPY --from=builder /app /app

USER nonroot:nonroot

EXPOSE 8080 9090

# OCI Image Spec 라벨
LABEL org.opencontainers.image.source="https://github.com/myorg/login"
LABEL org.opencontainers.image.description="Login service for fintech MSA"
LABEL org.opencontainers.image.licenses="MIT"

ENTRYPOINT ["/app"]
```

**Jenkins build stage**:

```groovy
stage('Build Image') {
  steps {
    container('buildx') {
      sh """
        docker buildx build \\
          --platform linux/arm64 \\
          --tag ghcr.io/myorg/login:${env.GIT_COMMIT.take(7)} \\
          --label "org.opencontainers.image.revision=${env.GIT_COMMIT}" \\
          --label "org.opencontainers.image.version=${env.BUILD_NUMBER}" \\
          --provenance=true \\
          --push \\
          .
      """
    }
  }
}
```

**Pod spec에서 image + securityContext**:

```yaml
spec:
  containers:
  - name: login
    image: ghcr.io/myorg/login:abc123
    securityContext:
      runAsNonRoot: true
      runAsUser: 65532          # distroless nonroot UID
      runAsGroup: 65532
      readOnlyRootFilesystem: true
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
    volumeMounts:
    - name: tmp
      mountPath: /tmp           # tmpfs for writable
  volumes:
  - name: tmp
    emptyDir:
      medium: Memory
      sizeLimit: 64Mi
```

**디버깅** (distroless의 shell 없음 문제):

```bash
# 일반적인 kubectl exec sh는 안 됨
kubectl exec -it <pod> -- sh   # X

# kubectl debug로 사이드카 컨테이너 띄우기 (k8s 1.25+)
kubectl debug -it <pod> --image=busybox --target=login
# 같은 process namespace + 같은 file system 공유로 디버깅
```

## 6. Configuration — 어떤 설정이 있는가

**Multi-stage 최적화**:
- Dependency layer를 source code layer보다 먼저 → 캐시 효율
- `COPY go.mod go.sum` 후 `go mod download` → 의존성만 변경 시 캐시 재사용
- `COPY . .`는 마지막 (source 변경마다 캐시 무효)

**Build args**:
- `--build-arg VERSION=1.0` 식으로 빌드 시 변수 전달
- `ARG`로 Dockerfile에서 받기
- `TARGETOS`, `TARGETARCH`는 buildx가 자동 주입

**Go 빌드 옵션**:
- `CGO_ENABLED=0`: static linking (distroless static base와 호환)
- `-ldflags="-s -w"`: 디버그 정보 제거 → 바이너리 작아짐
- `-trimpath`: 빌드 경로 정보 제거 (보안)

**Layer 캐싱 (buildx)**:
- `--cache-from=ghcr.io/myorg/login:cache`: 이전 이미지를 캐시 소스로
- `--cache-to=ghcr.io/myorg/login:cache,mode=max`: 캐시 push
- 본 프로젝트는 GHCR을 캐시 저장소로 활용

**SBOM + Provenance**:
- `--sbom=true`: Software Bill of Materials 자동 생성
- `--provenance=true`: 빌드 출처 정보 (SLSA Level 1+)
- GHCR에 OCI artifact로 저장

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Docker buildx 0.13+** (2026-05 권장)
- **BuildKit 0.13+**
- **OCI Image Spec v1.1+** (provenance 지원)
- **distroless image**: linux/arm64, linux/amd64 모두 지원
- **PSA restricted**: non-root + read-only + drop ALL capabilities 필수
- **kubectl debug**: k8s 1.25+ stable (distroless 디버깅용)

## 8. 면접 예상 질문 & 답변

**Q1. Multi-stage build가 왜 필요해요?**
> 빌드 환경과 실행 환경을 분리하기 위함입니다. Go 앱을 빌드하려면 golang:1.26 이미지(~500MB + Go SDK)가 필요한데, 실행에는 binary 하나만 있으면 됩니다. 단일 stage Dockerfile은 빌드 도구가 runtime 이미지에 남아서 (1) 이미지 크기 폭증, (2) CVE 표면 증가, (3) 공격자가 컨테이너 진입 시 컴파일러로 추가 도구 빌드 가능 — 세 가지 문제가 있습니다. Multi-stage는 마지막 stage만 result로 가져가므로 빌드 도구는 자동으로 빠집니다. 본 프로젝트 Go 이미지는 builder 600MB → runtime 20MB로 30배 줄어듭니다.

**Q2. Distroless 골랐는데 Alpine 안 쓴 이유는?**
> 둘 다 작지만 distroless가 더 안전합니다. Alpine은 musl libc + busybox shell + apk package manager를 포함합니다 — 5MB지만 shell이 있어 공격자가 진입 시 명령 실행 가능합니다. Distroless는 shell 없음 + package manager 없음으로 컨테이너 escape나 RCE 시도 시 자유도가 훨씬 낮습니다. 또 Alpine의 musl libc는 일부 라이브러리(특히 DNS resolver) 동작이 glibc와 달라 호환성 이슈가 있습니다. 단점은 distroless가 디버깅 어렵다는 점인데 `kubectl debug` 사이드카로 해결됩니다.

**Q3. Non-root user가 PSA restricted에 왜 필수예요?**
> 컨테이너 escape 시 호스트 영향 최소화입니다. 컨테이너 안에서 root로 동작하면, 만약 컨테이너 런타임 취약점(예: runc CVE-2024-21626)으로 escape 성공 시 호스트의 root 권한을 얻을 수 있습니다. Non-root(UID 1000+)로 실행하면 escape해도 unprivileged user라 피해가 제한됩니다. PSA restricted는 `runAsNonRoot: true`를 강제하고, Dockerfile에서 `USER nonroot`로 명시해야 admission이 통과합니다. 본 프로젝트는 distroless의 nonroot user (UID 65532) 또는 명시적 1000 사용.

**Q4. ARM64 빌드는 어떻게 해요?**
> Docker buildx 사용입니다. `docker buildx create --use`로 builder 활성화 후 `--platform=linux/arm64` 또는 `linux/arm64,linux/amd64` 동시 지정. buildx는 QEMU emulation으로 x86 머신에서도 ARM64 binary 빌드 가능합니다. Jenkins build agent가 x86이어도 OK. 더 빠른 방법은 native ARM64 build node를 따로 두는 거지만 본 프로젝트는 단순화. Dockerfile에서 `CGO_ENABLED=0 GOARCH=$TARGETARCH`로 buildx의 platform 변수를 받아 cross-compile.

**Q5. CGO_ENABLED=0이 왜 중요해요?**
> Go의 cgo는 C 라이브러리 호출을 가능하게 하지만, dynamic linking을 도입해서 distroless static base에서 동작 안 합니다. `CGO_ENABLED=0`으로 끄면 순수 Go binary가 되어 모든 의존성이 static linking되고 scratch나 distroless static에서 실행 가능합니다. 단점은 일부 라이브러리(DNS resolver, sqlite 등)가 cgo 필요해서 사용 못 함. Go 표준 라이브러리만 쓰면 cgo 불필요. 본 프로젝트는 cgo 없는 패턴 강제.

**Q6. readOnlyRootFilesystem을 켜면 앱이 동작 안 하는데요?**
> 앱이 /tmp 같은 곳에 write하면 fail합니다. 해결책은 (1) writable이 필요한 경로만 `emptyDir.medium: Memory` (tmpfs)로 마운트, (2) 로그는 stdout/stderr만 (파일 X), (3) /tmp 사용 시 emptyDir 마운트. 본 프로젝트는 /tmp에 64Mi tmpfs를 마운트하는 표준 패턴입니다. 일부 Java 앱은 jvm temp dir 등 더 많은 writable path 필요해서 어려운데, Go는 일반적으로 /tmp만 있으면 됩니다.

**Q7. image tag로 latest 안 쓰면 어떻게 배포해요?**
> image tag = git commit SHA로 강제합니다. Jenkins가 `${GIT_COMMIT:0:7}` (예: abc123)을 tag로 사용해서 push. ArgoCD가 보는 manifest의 image 필드도 commit SHA. 새 배포는 Jenkins가 manifest commit으로 image tag를 새 SHA로 변경 → ArgoCD가 감지해서 rolling update. Pod 재시작 시에도 같은 tag pull이라 이미지가 변동되지 않습니다 — immutable + traceable. Latest tag는 mutable이라 같은 이름이 다른 이미지를 가리킬 수 있어 rollback 불명확.

**Q8. Image 크기가 작으면 뭐가 좋아요?**
> 세 가지 이점. (1) Pull 시간 단축 — Pod startup 빠름, scale up 더 빠름. ARM64 노드가 새 노드면 더 큰 영향. (2) Registry storage 절감 — GHCR 무료 한도 안에서 더 많은 버전 보관. (3) CVE 표면 축소 — 적은 라이브러리 = 적은 취약점. 본 프로젝트 Go 이미지 20MB vs Ubuntu base 500MB는 25배 차이. 1000번 pull 시 24GB vs 0.5TB 네트워크 트래픽. 작은 차이가 큰 비용/시간으로 누적.

**Q9. Distroless에서 디버깅 어떻게 해요?**
> `kubectl debug` 명령으로 사이드카 컨테이너 띄웁니다. `kubectl debug -it <pod> --image=busybox --target=<container>` 하면 같은 Pod의 process namespace와 file system을 공유하는 임시 컨테이너가 추가됩니다. busybox 안의 shell로 `/proc/<pid>` 보거나 `nsenter`로 target 컨테이너 진입. k8s 1.25+ stable 기능입니다. 또 다른 방법은 임시로 distroless가 아닌 debug 이미지 버전을 만들어두는 거지만, kubectl debug가 더 깔끔합니다.

**Q10. Multi-arch manifest list가 어떻게 동작하는지 설명해주세요.**
> Manifest list(또는 image index)는 architecture별 이미지를 가리키는 인덱스 객체입니다. `ghcr.io/myorg/login:abc123` 단일 tag가 실제로는 (1) linux/arm64 variant의 manifest, (2) linux/amd64 variant의 manifest를 가리키는 list입니다. Pod가 image pull 시 노드의 OS/architecture를 보고 적절한 variant만 다운로드. ARM64 노드는 ARM64 variant만 받습니다. 결과적으로 개발자는 단일 tag로 작업하고 노드는 자기 호환 변종만 받는 추상화가 가능합니다.

**Q11. SBOM과 Provenance가 뭐예요?**
> SBOM (Software Bill of Materials)은 이미지 안에 어떤 라이브러리/패키지가 들어있는지 명세입니다. CVE 분석, license audit, supply chain 감사에 필수. buildx `--sbom=true`로 자동 생성되어 OCI artifact로 이미지와 함께 저장됩니다. Provenance는 "이 이미지가 어디서, 누가, 어떤 소스코드로 빌드됐는가" 메타데이터입니다. SLSA framework의 Level 1+ 요구사항. 본 프로젝트는 둘 다 활성화해서 supply chain 추적성을 높입니다. Phase 6-A에서 cosign으로 서명까지 추가하면 SLSA Level 2-3 수준.

**Q12. Dockerfile 빌드가 너무 느려요. 어떻게 빨라져요?**
> 다섯 가지 최적화. (1) Layer 순서 최적화 — 자주 변경 안 되는 layer를 위로, 자주 변경되는 layer를 아래로. (2) Dependency layer를 source 전에 — `COPY go.mod` → `go mod download` → `COPY .`. (3) `.dockerignore`로 불필요 파일 제외 (node_modules, .git 등). (4) buildx `--cache-from` + `--cache-to`로 GHCR 캐시 활용. (5) Native architecture builder 사용 (ARM64는 ARM64 노드에서 빌드, x86은 x86에서) — emulation 대비 5-10배 빠름. 본 프로젝트는 (1)~(4)를 표준 적용.
