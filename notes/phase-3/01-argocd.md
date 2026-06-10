# ArgoCD

## 1. Why — 왜 쓰는가

GitOps 도구. **Git 저장소를 source of truth로 두고, 클러스터 상태를 Git에 선언된 desired state와 자동으로 일치시키는** controller.

**imperative 배포의 문제**:
- 누가 언제 무엇을 배포했는지 추적 어려움
- `kubectl apply`를 사람 손으로 하면 환경 간 차이 발생
- 롤백이 명확하지 않음 (이전 manifest를 다시 찾아야 함)
- 클러스터 상태와 코드 사이 drift 발생

**ArgoCD의 해결**:
- **Git이 source of truth**: 모든 변경은 PR을 거쳐 Git에 commit. 클러스터 변경 이력 = Git 이력.
- **자동 sync**: Git 변경 감지하면 자동으로 클러스터에 apply
- **Drift detection**: 누군가 `kubectl edit`로 수동 변경하면 ArgoCD가 감지하고 자동 복구 (또는 알람)
- **롤백**: `git revert` 하나로 이전 상태 복원
- **시각화**: 리소스 토폴로지 + sync 상태 + health UI

**대체재**:
- **Flux CD**: CNCF graduated. ArgoCD와 거의 동급 기능. CLI 우선 vs ArgoCD UI 우선. 본 프로젝트는 ArgoCD 선택 — 토스 사용 + UI가 학습/면접 자료로 강함.
- **Jenkins CD pipeline**: imperative. GitOps 아님. drift 추적 불가.
- **Spinnaker**: Netflix 출신. 복잡, multi-cloud 강하나 학습곡선 가파름.

ArgoCD가 가장 광범위한 채택률 + Helm/Kustomize/raw manifest 모두 native 지원 + ApplicationSet으로 멀티 배포 자동화.

## 2. Architecture — 어떻게 구성되는가

**핵심 컴포넌트** (모두 `argocd` 또는 `cicd` namespace에 Pod 형태):

- **argocd-server**: API server + Web UI. gRPC + REST.
- **argocd-repo-server**: Git repo clone + manifest 렌더링 (Helm/Kustomize 처리).
- **argocd-application-controller**: 핵심 reconciliation. desired vs actual 비교, sync 수행. StatefulSet.
- **argocd-applicationset-controller**: ApplicationSet CR 처리 → 다수 Application 자동 생성.
- **argocd-notifications-controller**: sync 결과를 Slack/email로 전송 (선택).
- **argocd-dex-server**: SSO (OIDC/SAML). GitHub OAuth 같은 외부 IdP 통합 시 사용.
- **argocd-redis**: 캐시 (manifest 렌더링 결과, repo 정보).

**핵심 CRD**:

- **Application**: 단일 배포 단위. Git source + 대상 namespace + sync policy 명시.
- **ApplicationSet**: 다수 Application을 generator 기반으로 자동 생성. List/Matrix/Cluster/Git/Pull Request generator.
- **AppProject**: Application 그룹 + 접근 권한 + repo/cluster 화이트리스트.

## 3. Mechanism — 어떻게 돌아가는가

**Application 동기화 흐름**:

1. 사용자가 `Application` CR 생성 (Git URL + path + target namespace 명시)
2. argocd-application-controller가 새 Application 감지
3. argocd-repo-server에게 manifest 렌더링 요청
4. repo-server가 Git clone → Helm/Kustomize 실행 → 최종 매니페스트 반환
5. Controller가 cluster의 actual state 조회
6. Desired (Git manifest) vs Actual (cluster) 비교 → diff 계산
7. Sync policy에 따라:
   - `auto sync`: 즉시 apply
   - `manual sync`: 사용자가 UI에서 Sync 버튼 클릭 대기
8. apply 후 헬스 상태 추적 (Healthy / Progressing / Degraded)
9. 사용자가 `kubectl edit`로 변경 → drift 감지 → `selfHeal: true`면 자동 복구

**ApplicationSet 동작**:

1. ApplicationSet CR이 generator(예: List)와 template 정의
2. argocd-applicationset-controller가 generator 실행
3. List generator의 각 element마다 template에 값 주입 → Application CR 생성
4. 생성된 Application들이 위 1-9 흐름으로 동작

**Sync wave 메커니즘**:

리소스 매니페스트에 `argocd.argoproj.io/sync-wave: "5"` annotation 부여. ArgoCD가 wave 값을 보고 정렬해서 순차 apply.
- 낮은 wave 먼저 (default 0)
- CRD → CR 순서가 필수일 때 사용 (CRD wave -1, CR wave 0)
- Phase 5/6에서 Strimzi Kafka CRD → Kafka CR 같은 경우 필수

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 ArgoCD 의존 관계.

- **GitHub** — manifest repo source
- **Helm** — chart source 지원, `helm template` 내부 호출 (helm install은 안 함)
- **Kustomize** — 보조 source 지원
- **Jenkins** — Jenkins가 manifest repo에 commit하면 ArgoCD가 감지해서 sync
- **OAuth (GitHub)** — Dex를 통한 SSO
- **Kubernetes RBAC** — ArgoCD ServiceAccount에 app namespace deploy 권한 부여
- **Vault** (Phase 6) — ArgoCD가 직접 Vault 호출하지 않음. 매니페스트의 Vault Agent Injector annotation을 보고 pod 생성 시 Vault가 자동 주입
- **Slack / Email** — argocd-notifications로 sync 결과 알림

## 5. Usage — 어떻게 쓰는가

**설치** (Helm):

```bash
helm install argocd argo/argo-cd \
  --namespace cicd --create-namespace \
  --version 7.7.0 \
  -f values.yaml
```

values.yaml 핵심:
```yaml
server:
  ingress:
    enabled: false  # HTTPRoute로 별도 노출
  config:
    url: https://argocd.ggang.cloud
    oidc.config: |
      name: GitHub
      issuer: https://token.actions.githubusercontent.com
      ...
configs:
  rbac:
    policy.csv: |
      g, argocd-admins, role:admin
      g, argocd-devs, role:readonly
```

**초기 admin 패스워드 확인 + 변경**:

```bash
kubectl get secret argocd-initial-admin-secret -n cicd \
  -o jsonpath='{.data.password}' | base64 -d
# 초기 패스워드로 로그인 후 UI에서 변경
kubectl delete secret argocd-initial-admin-secret -n cicd
```

**Application CR 예시** (Helm source):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: login
  namespace: cicd
spec:
  project: app
  source:
    repoURL: https://github.com/myorg/k8s-manifests
    targetRevision: main
    path: kubernetes/apps/login
    helm:
      valueFiles:
      - values.yaml
  destination:
    server: https://kubernetes.default.svc
    namespace: app
  syncPolicy:
    automated:
      prune: true       # Git에서 삭제된 리소스를 클러스터에서도 삭제
      selfHeal: true    # drift 자동 복구
    syncOptions:
    - CreateNamespace=true
    - ServerSideApply=true
```

**ApplicationSet List generator** (본 프로젝트, 단일 환경):

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: app-services
  namespace: cicd
spec:
  generators:
  - list:
      elements:
      - service: login
      - service: core
      - service: batch
  template:
    metadata:
      name: '{{service}}'
    spec:
      project: app
      source:
        repoURL: https://github.com/myorg/k8s-manifests
        targetRevision: main
        path: kubernetes/apps/{{service}}
        helm:
          valueFiles:
          - values.yaml
      destination:
        server: https://kubernetes.default.svc
        namespace: app
      syncPolicy:
        automated:
          prune: true
          selfHeal: true
```

**Sync wave 사용 예시**:

```yaml
# CRD 매니페스트
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: kafkas.kafka.strimzi.io
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
```

```yaml
# CR 매니페스트
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-kafka
  annotations:
    argocd.argoproj.io/sync-wave: "0"
```

**디버깅 명령**:

```bash
kubectl get applications -n cicd
kubectl describe application login -n cicd       # sync 상태, 오류 메시지
argocd app sync login                              # 수동 sync 트리거
argocd app diff login                              # desired vs actual
argocd app history login                           # sync 이력
```

## 6. Configuration — 어떤 설정이 있는가

**Sync policy 옵션**:
- `automated.prune`: Git에서 삭제된 리소스를 클러스터에서도 자동 삭제. **false면 좀비 리소스 누적**.
- `automated.selfHeal`: drift를 자동 복구. **false면 manual 변경이 다음 commit까지 유지됨**.
- `automated.allowEmpty`: empty diff 허용 (Application이 0개 리소스 가질 수 있음).
- `syncOptions`:
  - `CreateNamespace=true`: namespace 없으면 자동 생성
  - `ServerSideApply=true`: kubectl SSA 사용 (large manifest 처리 우수)
  - `PrunePropagationPolicy=foreground`: 의존성 순서대로 삭제
  - `RespectIgnoreDifferences=true`: ignoreDifferences 명시한 필드는 drift 무시

**ApplicationSet generator 종류**:
- **List**: 명시적 element 목록. 단순. 본 프로젝트 사용.
- **Cluster**: 등록된 모든 클러스터에 배포 (multi-cluster).
- **Git**: Git repo의 디렉토리 또는 파일 기반.
- **Matrix**: 두 generator의 cartesian product (예: service × env). 멀티환경 시 사용.
- **Merge**: 두 generator를 합쳐서 deduplicate.
- **Pull Request**: PR마다 preview environment 자동 생성.

**RBAC** (`configs.rbac.policy.csv`):
- `g, <group>, role:<role>`: 그룹에 role 부여
- `p, role:<role>, applications, *, <project>/*, allow`: role에 권한 부여
- 본 프로젝트: GitHub team을 group으로 매핑, admin/readonly 분리

**App-of-Apps vs ApplicationSet**:
- App-of-Apps: Application이 다른 Application들을 만드는 패턴. **레거시, 비권장**.
- ApplicationSet: generator + template으로 동적 생성. **신규 프로젝트 권장**.

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **ArgoCD 2.13+** (2026-05 기준 권장). Gateway API native 지원, sync wave 안정.
- **Helm 3.x**: ArgoCD가 내부적으로 helm template 호출
- **Kustomize 4.x+**: 내장
- **OCI Registry chart**: ArgoCD 2.7+ 지원
- **Multi-arch image**: 본 프로젝트 ARM64 노드라 image manifest의 ARM64 variant 자동 선택

## 8. 면접 예상 질문 & 답변

**Q1. GitOps가 뭐예요? ArgoCD가 다른 CD 도구랑 어떻게 다른가요?**
> GitOps는 (1) Git을 source of truth로, (2) declarative 명세로, (3) 자동화된 controller가 sync하는 운영 패러다임입니다. Jenkins CD pipeline 같은 imperative 도구는 "deploy 명령을 실행한다"는 액션 중심인데, GitOps는 "Git에 선언된 상태와 일치해야 한다"는 상태 중심입니다. 결과적으로 GitOps는 audit trail이 Git history 자체가 되고, drift 감지가 자동이며, 롤백이 git revert 한 줄로 끝납니다. ArgoCD는 이 패턴의 가장 광범위한 구현체입니다.

**Q2. ApplicationSet과 App-of-Apps 차이는요?**
> App-of-Apps는 한 Application이 자식 Application들을 만들도록 매니페스트를 짜는 패턴이고, ApplicationSet은 generator + template으로 다수 Application을 동적 생성하는 native CRD입니다. App-of-Apps는 (1) 자식 Application 매니페스트를 일일이 작성해야 하고, (2) 새 환경/서비스 추가 시 수동, (3) deduplication 안 됨 같은 한계가 있어서 레거시로 분류됩니다. 신규 프로젝트는 ApplicationSet이 표준이고, 본 프로젝트는 List generator로 service 3개를 자동 생성하는 패턴입니다.

**Q3. ApplicationSet의 generator 종류 중 본 프로젝트는 왜 List를 골랐어요?**
> 본 프로젝트는 단일 `app` namespace에 3개 service만 배포하는 단순 환경이라 List generator가 가장 명확합니다. Matrix generator는 service × env(dev/staging/prod) 같은 cartesian product를 만들 때 의미가 있는데, 본 프로젝트는 멀티환경을 의도적으로 단일 환경으로 단순화했기 때문에 Matrix가 불필요합니다. 면접에서 "확장성은요?"라고 물으면 "멀티환경 도입 시 List를 Matrix로 바꾸기만 하면 되는 확장 가능한 구조"라고 답합니다.

**Q4. Sync wave는 언제 쓰고 어떻게 동작해요?**
> 리소스 간 적용 순서가 필수일 때 씁니다. 대표 사례가 CRD입니다. Strimzi Kafka CR을 만들려면 Kafka CRD가 먼저 클러스터에 등록되어야 하는데, ArgoCD가 동시에 apply하면 CR 생성이 실패합니다. CRD 매니페스트에 `argocd.argoproj.io/sync-wave: "-1"`, CR 매니페스트에 `"0"`을 주면 ArgoCD가 wave 정렬해서 CRD 먼저, CR 나중에 적용합니다. Hook과 비슷하지만 hook은 차트 단위, sync-wave는 리소스 단위라 더 세밀합니다.

**Q5. selfHeal과 prune을 켜는 게 안전한가요?**
> 안전성과 일관성의 트레이드오프인데 본 프로젝트는 둘 다 켭니다. selfHeal=true면 누군가 `kubectl edit`로 수동 변경한 것을 ArgoCD가 자동 복구하므로 drift가 누적되지 않습니다. prune=true면 Git에서 매니페스트를 삭제하면 클러스터에서도 자동 삭제되어 좀비 리소스가 없습니다. 위험은 (1) 운영자가 emergency hotfix로 kubectl edit 했는데 ArgoCD가 복구해버리는 케이스, (2) Git에서 실수로 매니페스트 삭제한 경우 prod가 같이 삭제되는 케이스인데, 둘 다 PR 리뷰 강제로 방지합니다.

**Q6. ArgoCD가 helm install을 호출하나요?**
> 아니요. ArgoCD는 helm chart를 source로 받지만 내부적으로 `helm template` 명령으로 매니페스트만 렌더링하고 자기가 직접 kube-apiserver에 apply합니다. 결과적으로 Helm Release Secret이 생성되지 않고, ArgoCD의 Application 리소스가 추적 단위가 됩니다. `helm rollback` 같은 명령은 안 통하고, ArgoCD UI의 history rollback으로 대체합니다. 이 패턴의 장점은 ArgoCD가 desired와 actual을 직접 비교 가능하다는 점이고, 단점은 Helm 명령에 익숙한 운영자가 헤맬 수 있다는 점입니다.

**Q7. Jenkins → ArgoCD 연결은 어떻게 하나요? Image Updater 안 쓴 이유는?**
> Jenkins가 빌드 후 새 이미지를 GHCR에 push하고, **manifest repo의 image tag를 commit으로 직접 업데이트**합니다. ArgoCD가 Git 변경을 감지하고 자동 sync해서 배포합니다. ArgoCD Image Updater도 git write-back 모드는 GitOps 호환이지만 (1) 별도 `.argocd-source-<app>.yaml` 파일로 override를 분리 기록해서 audit trail이 두 군데로 흩어지고, (2) Helm chart values에 commit한 메시지가 빌드 메타데이터(commit SHA, build number)와 분리됩니다. Jenkins가 직접 manifest commit하면 메시지에 빌드 정보를 함께 남길 수 있어서 추적성이 단일화됩니다.

**Q8. ArgoCD UI는 어떻게 노출하고 인증은 어떻게 하나요?**
> HTTPRoute + Gateway API로 노출합니다 (`argocd.ggang.cloud`). 인증은 두 레이어로 갑니다. 첫째는 ArgoCD가 자동 생성하는 `argocd-initial-admin-secret`의 패스워드인데, 초기 로그인 후 즉시 변경하고 Secret을 삭제합니다. 둘째는 GitHub OAuth SSO를 Dex를 통해 구성합니다. GitHub team `argocd-admins`는 admin role, `argocd-devs`는 readonly role로 매핑해서 RBAC를 적용합니다. 면접에서 가산점 영역이라 본 프로젝트에 박아둡니다.

**Q9. ArgoCD가 죽으면 어떻게 되나요?**
> 이미 배포된 워크로드는 정상 동작합니다. ArgoCD는 reconciliation controller일 뿐 데이터플레인이 아니라서, 클러스터의 모든 Pod과 Service는 계속 트래픽을 처리합니다. ArgoCD 다운의 영향은 (1) 새 commit에 대한 자동 sync가 멈춤, (2) drift가 발생해도 자동 복구 안 됨입니다. 그래서 ArgoCD 다운을 Prometheus가 감지하고 Alertmanager가 즉시 알림을 보내도록 룰을 박아둡니다. ArgoCD 자체는 거의 stateless(redis 캐시는 일시적)라 재기동만으로 회복됩니다.

**Q10. ApplicationSet에서 values 파일을 환경별로 어떻게 매핑하나요?**
> template의 source.helm.valueFiles에서 generator의 변수를 사용합니다. 예를 들어 Matrix generator로 service × env 조합을 만들면 `valueFiles: ["values-{{env}}.yaml"]` 같은 식으로 환경별 values를 매핑합니다. 본 프로젝트는 단일 환경이라 `valueFiles: ["values.yaml"]`만 사용하지만, 멀티환경 확장 시 manifest 디렉토리에 `values-dev.yaml`, `values-staging.yaml`, `values-prod.yaml`을 두고 Matrix generator로 자동 매핑하는 구조입니다.

**Q11. ArgoCD AppProject는 왜 필요해요?**
> Application들의 그룹 + 권한 경계입니다. 본 프로젝트는 `app` AppProject 하나를 만들고 (1) 허용된 source repo만 사용 가능 (`destinations: kubernetes/apps/*`), (2) 허용된 destination namespace만 배포 가능 (`namespaces: [app]`), (3) 허용된 리소스 종류만 (`clusterResourceWhitelist`에 ClusterRole 차단 등)를 명시합니다. AppProject 없이 default project를 쓰면 모든 namespace에 배포 가능해서 ArgoCD 탈취 시 폭발 반경이 큽니다.

**Q12. ArgoCD vs Flux 어느 게 나은가요?**
> 두 도구 다 CNCF graduated고 기능은 거의 동급입니다. 차이는 (1) ArgoCD는 UI 우선, Flux는 CLI/Kustomize 우선, (2) ArgoCD는 ApplicationSet으로 multi-deploy 자동화, Flux는 Kustomization + GitRepository 조합, (3) ArgoCD는 단일 클러스터 multi-app 강함, Flux는 multi-cluster 모델이 더 자연스러움. 본 프로젝트는 ArgoCD를 선택했는데, 이유는 토스가 사용하는 스택이고 UI가 학습 자료 + 면접 데모로 강하기 때문입니다. 면접에서 "Flux도 검토했지만 본 프로젝트는 단일 클러스터 + UI demo 가치로 ArgoCD가 적합"이라고 답합니다.
