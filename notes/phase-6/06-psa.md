# Pod Security Standards (PSA)

## 1. Why — 왜 쓰는가

Kubernetes 내장 admission controller. Pod의 SecurityContext를 표준 프로파일로 검증해서 위험한 설정(root 실행, privileged 컨테이너 등)을 차단.

**기존 PSP(Pod Security Policy) deprecated**: k8s 1.21에서 deprecated, 1.25에서 제거. 복잡 + bypass 가능 + RBAC 통합 문제로 폐기. **PSA가 후계자**.

**PSA의 해결**:
- k8s 내장 — 별도 설치 불필요
- 단일 namespace label 한 줄로 활성화
- 3가지 표준 프로파일: privileged / baseline / restricted
- Kyverno보다 가벼움 + admission 우선 적용

**대체재**:
- **Kyverno**: 더 유연한 정책 엔진. PSA보다 표현력 강함. 보완 관계.
- **OPA Gatekeeper**: Rego 언어 기반. 학습곡선.
- **PSA**: 표준 + 가벼움. 본 프로젝트 1차 방어선.

## 2. Architecture — 어떻게 구성되는가

**3가지 표준 프로파일**:
- **privileged**: 제약 없음 (시스템 워크로드용)
- **baseline**: 기본적인 권한 상승 차단 (privileged, hostNetwork, hostPID 등 금지)
- **restricted**: 강한 제약 (non-root 강제, capabilities drop ALL, seccomp RuntimeDefault 등). 본 프로젝트 권장.

**3가지 적용 모드**:
- **enforce**: 위반 시 admission 거부
- **audit**: 위반 시 audit log만 기록
- **warn**: 위반 시 kubectl 사용자에게 경고 메시지

**Label 한 줄로 설정**:
```yaml
labels:
  pod-security.kubernetes.io/enforce: restricted
  pod-security.kubernetes.io/enforce-version: latest
  pod-security.kubernetes.io/audit: restricted     # 함께 audit도
  pod-security.kubernetes.io/warn: restricted      # 함께 warn도
```

## 3. Mechanism — 어떻게 돌아가는가

1. 사용자가 Pod manifest apply
2. kube-apiserver의 admission 단계에서 PSA controller 호출
3. Pod의 namespace label에서 적용할 프로파일 확인
4. Pod의 SecurityContext + containers spec 검증
5. 위반 발견 시 mode에 따라:
   - enforce: 거부 + 에러 메시지
   - audit: audit log 기록 후 통과
   - warn: kubectl 응답에 경고 추가 후 통과

**restricted 프로파일이 강제하는 것** (주요):
- `runAsNonRoot: true` 필수
- `allowPrivilegeEscalation: false` 필수
- `capabilities.drop: [ALL]` 필수 (`NET_BIND_SERVICE`만 add 허용)
- `readOnlyRootFilesystem: true` 권장 (필수 아님, baseline은 아님)
- `seccompProfile.type: RuntimeDefault` 필수
- `hostNetwork: false`, `hostPID: false`, `hostIPC: false`
- privileged container 금지
- volume type 제한 (configMap, emptyDir, secret, PVC만 허용)

## 4. Integration — 어떻게 연결하는가

- **kube-apiserver** — 내장 admission controller
- **모든 namespace** — label로 활성화
- **Helm charts** — 일부 chart(Jenkins, Prometheus 등)가 restricted 위반 → securityContext override 필요
- **Kyverno** — 보완 관계. PSA가 1차, Kyverno가 추가 정책.
- **Vault Agent Injector** — webhook이 init container 주입, securityContext 호환 확인 필요

**일부 컴포넌트의 restricted 비호환**:
- ArgoCD, Jenkins, Prometheus, Grafana, Loki, Tempo, Strimzi 등이 자체 chart default로 restricted 위반
- 각 chart values.yaml에 `podSecurityContext`/`securityContext` override 필요
- 또는 해당 namespace는 baseline 적용

## 5. Usage — 어떻게 쓰는가

**Namespace에 적용** (app namespace에 restricted):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: app
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: latest
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

**Pod이 restricted 통과하려면**:

```yaml
apiVersion: v1
kind: Pod
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532              # nonroot UID
    runAsGroup: 65532
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    securityContext:
      allowPrivilegeEscalation: false
      runAsNonRoot: true
      capabilities:
        drop: ["ALL"]
      readOnlyRootFilesystem: true   # restricted 필수 아님이지만 권장
    volumeMounts:
    - name: tmp
      mountPath: /tmp
  volumes:
  - name: tmp
    emptyDir:
      medium: Memory
```

**점진적 도입** (audit → warn → enforce):

```bash
# Step 1: audit 모드로 위반 사항 파악
kubectl label namespace app pod-security.kubernetes.io/audit=restricted
# audit log에서 violation 확인

# Step 2: 위반 컴포넌트 SecurityContext 수정

# Step 3: warn 모드로 새 매니페스트 위반 즉시 알림
kubectl label namespace app pod-security.kubernetes.io/warn=restricted

# Step 4: enforce로 강제
kubectl label namespace app pod-security.kubernetes.io/enforce=restricted
```

**위반 확인**:

```bash
# audit log 위치
kubectl logs -n kube-system kube-apiserver-xxx | grep "pod-security"

# 또는 매니페스트 apply 시 직접 에러 확인
kubectl apply -f bad-pod.yaml
# Error from server (Forbidden): pods "bad-pod" is forbidden: violates PodSecurity "restricted:latest"
```

## 6. Configuration — 어떤 설정이 있는가

**프로파일 선택 가이드**:
- 시스템 namespace (kube-system 등): privileged
- 인프라 컴포넌트 (cert-manager, vault 등): baseline (일부 restricted 가능)
- 앱 namespace: **restricted**
- 본 프로젝트 권장: app NS는 restricted, 나머지는 baseline부터 시작

**버전 pinning**:
- `enforce-version: latest` — 항상 최신
- `enforce-version: v1.32` — 특정 k8s 버전 기준 (predictability 우선 시)

**Exception 설정** (특정 user/SA가 restricted 우회):
- kube-apiserver flag `--admission-control-config-file` 사용
- 본 프로젝트는 사용 안 함 (모든 워크로드 restricted 강제)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.25+** (PSA stable, PSP 제거)
- **Pod 매니페스트**: SecurityContext 명시적 작성 필요
- **Helm chart 호환성**: 주요 chart들이 restricted 호환 옵션 제공하나 default가 아닐 수 있음 — 검증 필요

## 8. 면접 예상 질문 & 답변

**Q1. PSP 안 쓰고 PSA 쓴 이유는?**
> PSP는 k8s 1.21에서 deprecated, 1.25에서 제거됐습니다. PSA가 후계자입니다. PSP의 문제는 (1) 복잡 — 정책별로 별도 리소스, (2) RBAC 매칭 어려움 — 어느 user/SA에 어느 정책 적용할지, (3) bypass 가능 — 일부 매니페스트 수정으로 우회. PSA는 namespace label 한 줄로 활성화되고 3가지 표준 프로파일(privileged/baseline/restricted)만 있어서 단순하고 명확합니다. 본 프로젝트는 app NS에 restricted 강제.

**Q2. enforce 바로 적용하면 안 되는 이유는?**
> 다수 컴포넌트가 default로 restricted 위반입니다. ArgoCD, Jenkins, Prometheus, Grafana 등의 Helm chart는 securityContext가 restricted 호환 default가 아닌 경우가 많습니다. 바로 enforce하면 helm install 자체가 실패. 본 프로젝트의 점진 도입: (1) audit 모드로 위반 파악 → (2) 각 chart values.yaml에 securityContext override → (3) warn 모드로 새 위반 즉시 알림 → (4) enforce로 강제. 이 순서로 며칠 운영하면서 안정화.

**Q3. restricted가 강제하는 핵심 5가지는?**
> (1) `runAsNonRoot: true` — root 실행 금지, (2) `allowPrivilegeEscalation: false` — setuid 같은 권한 상승 금지, (3) `capabilities.drop: [ALL]` — Linux capability 모두 제거 (NET_BIND_SERVICE만 add 허용), (4) `seccompProfile.type: RuntimeDefault` — seccomp 적용, (5) hostNetwork/hostPID/hostIPC 금지. 본 프로젝트의 distroless + non-root + read-only root filesystem 패턴이 자연스럽게 restricted 통과합니다.

**Q4. restricted 통과 못 하는 컴포넌트는 어떻게 해요?**
> 두 가지 옵션. (1) Helm chart values에 securityContext override — 대부분 가능. 예: Jenkins controller가 root 필요한 경우 nonroot UID + chown init container 추가. (2) 해당 namespace는 baseline 적용 — restricted 어려운 인프라 컴포넌트 namespace는 한 단계 완화. 본 프로젝트는 (1) 우선, (2) fallback. cert-manager, external-dns, vault 등은 대부분 restricted 호환. monitoring 일부(Loki single binary 등)는 baseline.

**Q5. PSA vs Kyverno 어느 게 나아요?**
> 보완 관계입니다. PSA는 (1) k8s 내장 — 별도 설치 불필요, (2) 빠름 — admission 우선 평가, (3) 표준 프로파일 3개로 단순. Kyverno는 (1) 더 유연 — 임의 정책 작성 가능, (2) 정책 표현력 강함 — JMESPath 기반. 본 프로젝트는 PSA를 baseline + restricted로 활성화하고, Kyverno를 추가 레이어(image registry 제한, cosign 검증 등)로 사용. PSA가 1차 방어, Kyverno가 추가 정책.

**Q6. distroless 이미지가 restricted 통과 도움이 되나요?**
> 큰 도움입니다. distroless의 nonroot variant(`gcr.io/distroless/static-debian12:nonroot`)는 default user가 UID 65532라 `runAsNonRoot: true`를 자동 충족합니다. shell도 없어 setuid 같은 권한 상승 시도가 원천 차단. capabilities도 필요 없음. 결과적으로 Dockerfile에 `USER nonroot:nonroot` 한 줄 + Pod manifest에 securityContext만 추가하면 restricted 통과. 본 프로젝트의 Dockerfile 표준이 이미 restricted 호환되도록 설계됐습니다.

**Q7. restricted enforce 후 새 helm chart가 violate되면 어떻게 처리해요?**
> 두 단계. (1) `warn` 모드 활용 — chart install 시 위반 경고가 즉시 kubectl 응답에 표시되어 발견 빠름. (2) values.yaml에 podSecurityContext + securityContext 추가해서 통과시키거나, 정말 안 되면 해당 namespace를 baseline으로 완화. 본 프로젝트는 PR 리뷰 시 새 chart의 PSA 호환성 검증을 표준 체크리스트에 포함.

**Q8. audit log에서 PSA 위반은 어떻게 봐요?**
> kube-apiserver의 audit log에서 `pod-security.kubernetes.io` keyword로 grep합니다. OKE Basic은 audit log를 OCI에서 관리하므로 OCI Console → OKE → Audit logs에서 확인. 또는 namespace label에 `audit=restricted` + `warn=restricted` 추가해서 새 위반이 즉시 사용자에게 보이고 audit log에 기록되도록 합니다. 본 프로젝트는 audit + warn + enforce 셋 다 동시 활성화로 가시성 + 강제 모두 확보.
