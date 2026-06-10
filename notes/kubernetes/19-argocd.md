# Argo CD (Argo CD)

> 쿠버네티스 · GitOps/ArgoCD · 학습내용: Argo CD가 무엇/왜, Application·AppProject 커스텀 리소스, 동기화 상태(Synced/OutOfSync)와 헬스 상태, 자동 동기화·self-heal·prune, sync wave/hook, app-of-apps, RBAC·SSO, UI/CLI, 최소 Application 예시와 흔한 함정

---

## 1. Argo CD가 뭐고 왜 쓰나

**Argo CD**는 **쿠버네티스를 위한 선언형 GitOps 지속 배포(CD) 도구**다. Git 저장소에 선언된 매니페스트를 **단일 진실 소스**로 삼아, 클러스터의 실제 상태가 Git과 같아지도록 **지속적으로 동기화**한다.

- **pull 모델**: Argo CD가 **클러스터 안에서** 돌며 Git을 직접 끌어와 적용한다. 외부에서 클러스터로 배포를 밀어넣지 않으니 클러스터 자격증명을 외부 CI에 줄 필요가 없다.
- **지속 조정**: Git과 클러스터를 계속 비교해 차이(드리프트)를 보여주고, 설정에 따라 자동 교정한다.
- 지원 매니페스트 형식: 순수 YAML, **Kustomize**, **Helm**, jsonnet 등.

쉽게 말해 "Git에 적힌 대로 클러스터를 항상 맞춰주는 컨트롤러 + 보기 좋은 UI"다.

## 2. 핵심 리소스 — Application과 AppProject

Argo CD는 **커스텀 리소스(CRD)** 로 동작한다.

| 리소스 | 역할 |
|--------|------|
| **Application** | "**어떤 Git source를 어떤 클러스터/네임스페이스(destination)에 배포할지**" 선언하는 핵심 단위 |
| **AppProject** | 여러 Application을 묶는 **논리 그룹 + 가드레일**. 허용 source repo·destination·리소스 종류를 제한 → **멀티테넌시** |

### 2.1 Application

핵심 필드:

- **source**: 배포 소스 — `repoURL`(Git repo), `path`(디렉토리), `targetRevision`(브랜치/태그/커밋).
- **destination**: 배포 대상 — `server`(클러스터 API), `namespace`.
- **project**: 소속 AppProject.
- **syncPolicy**: 동기화 정책(자동/수동, self-heal, prune 등).

### 2.2 AppProject (멀티테넌시)

여러 팀이 한 Argo CD를 공유할 때, 프로젝트마다 **건드릴 수 있는 범위**를 제한한다.

- 허용 **source repo** 화이트리스트
- 허용 **destination**(클러스터/네임스페이스) 제한
- 허용 **리소스 종류** 제한(예: ClusterRole 생성 금지)

→ 팀 A가 팀 B의 네임스페이스나 클러스터 전역 리소스를 못 건드리게 막는 **격리 장치**.

★ 면접 포인트: **Application = 무엇을 어디에 배포하는지 한 단위**, **AppProject = 그 Application들의 권한·범위를 가두는 멀티테넌시 경계**. 둘의 역할 구분을 설명할 수 있어야 한다.

## 3. 동기화 상태 + 헬스 상태

Argo CD는 앱을 **두 축**으로 본다. 이 둘을 헷갈리면 안 된다.

| 축 | 값 | 의미 |
|----|----|------|
| **Sync 상태** | **Synced** / **OutOfSync** | Git(원하는 상태)과 클러스터(실제 상태)가 **같은가** |
| **Health 상태** | Healthy / Progressing / Degraded / Missing 등 | 배포된 리소스가 **실제로 잘 돌고 있는가** |

- **Synced ≠ Healthy**: Git대로 적용은 됐는데(Synced) 파드가 CrashLoop라 Degraded일 수 있다.
- **OutOfSync**: 누가 손으로 바꿨거나(드리프트), Git이 갱신됐는데 아직 적용 전.

## 4. 동기화 자동화 — auto-sync · self-heal · prune

`syncPolicy`로 동기화 동작을 제어한다.

| 옵션 | 켜면 | 함정 |
|------|------|------|
| **automated sync** | Git 변경을 **자동 적용** | 잘못된 머지가 즉시 운영에 반영 |
| **selfHeal** | 클러스터의 수동 변경을 **자동 원복**(드리프트 교정) | 긴급 핫픽스를 손으로 못 댐 — 반드시 Git 경유 |
| **prune** | Git에서 **사라진 리소스를 클러스터에서도 삭제** | **매니페스트 실수 삭제 → 운영 리소스 증발** |

```yaml
syncPolicy:
  automated:
    prune: true       # Git에서 지운 리소스 삭제 (위험! 주의)
    selfHeal: true    # 드리프트 자동 교정
```

## 5. 동기화 순서·훅, app-of-apps (한 줄씩)

- **sync wave**: 애너테이션 `argocd.argoproj.io/sync-wave: "N"` — 번호가 작을수록 먼저 적용(의존성 순서 제어).
- **resource hook**: `argocd.argoproj.io/hook: PreSync|Sync|PostSync` — 동기화 특정 시점에 Job 등 실행(예: PreSync로 DB 마이그레이션).
- **app-of-apps**: Application들을 만들어내는 **부모 Application** 하나로 클러스터 전체를 부트스트랩(root만 적용하면 나머지 줄줄이 생성).

## 6. RBAC · SSO · UI/CLI

- **RBAC**: Argo CD 자체의 역할 기반 접근 제어(누가 어떤 프로젝트/앱을 sync·수정할 수 있는지). AppProject와 결합해 멀티테넌시 강화.
- **SSO**: OIDC/SAML 등 외부 인증 연동(예: 회사 IdP로 로그인). 사용자별 권한은 RBAC로 매핑.
- **UI**: 앱 토폴로지·sync/health 상태·diff·동기화 버튼을 시각적으로 제공.
- **CLI(`argocd`)**: `argocd app sync`, `argocd app diff`, `argocd app list` 등으로 동일 작업을 자동화/스크립트화.

## 7. 최소 Application 예시

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: my-service
  namespace: argocd            # Argo CD가 사는 네임스페이스
spec:
  project: default
  source:
    repoURL: https://github.com/<org>/config-repo.git
    path: envs/prod            # 배포할 매니페스트 경로
    targetRevision: main       # 추적할 브랜치/태그/커밋
  destination:
    server: https://kubernetes.default.svc   # 같은(in-cluster) 클러스터
    namespace: my-service
  syncPolicy:
    automated:
      prune: false             # 처음엔 끄고 시작 권장
      selfHeal: true
    syncOptions:
      - CreateNamespace=true   # 대상 네임스페이스 없으면 생성
```

## 8. 흔한 함정

- ★★★ **자동 prune 위험**: `prune: true`에서 config repo 매니페스트를 실수로 지우면 **운영 리소스가 통째로 삭제**된다. 비운영 환경 먼저·PR 리뷰로 막고, 처음엔 꺼두는 게 안전하다.
- **self-heal와 긴급 변경 충돌**: self-heal이 켜져 있으면 손으로 한 변경이 즉시 원복된다 → 모든 변경은 Git 경유.
- **Synced인데 장애**: Sync 상태만 보지 말고 **Health 상태**를 함께 확인(적용됐어도 파드가 죽었을 수 있음).
- **targetRevision을 떠다니는 값으로**: `HEAD`/가변 태그면 무엇이 떴는지 불확실. 가능하면 고정 가능한 값을 추적.

★ 면접 포인트: "Argo CD에서 가장 조심할 설정?" → **"prune. 매니페스트 실수 삭제가 운영 리소스 삭제로 이어진다."** 그리고 **"Sync(=Git과 일치)와 Health(=실제 동작)는 다른 축"** 임을 구분.

---

### 한 줄 요약

Argo CD는 **K8s용 선언형 GitOps CD 도구**로, **Application**(어떤 Git source→어떤 destination)과 **AppProject**(멀티테넌시 가드레일)로 구성되며, **Sync 상태(Synced/OutOfSync)** 와 **Health 상태**를 따로 관리한다. **auto-sync·self-heal·prune**로 조정을 자동화하되, **prune은 운영 리소스 삭제 위험**이 커 가장 조심해야 한다.

---

### 참고 (공식 문서)

- Argo CD 공식 문서: <https://argo-cd.readthedocs.io/en/stable/>
- Core Concepts (Application/Sync/Health): <https://argo-cd.readthedocs.io/en/stable/core_concepts/>
- Application 선언 spec: <https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/>
- Sync Waves & Hooks: <https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/>
- RBAC: <https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/>
