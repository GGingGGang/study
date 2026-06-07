# GitOps 구현 패턴 (GitOps Implementation Patterns)

> 쿠버네티스 · GitOps · 학습내용: 저장소 구조(앱/설정 분리·모노 vs 멀티·환경별 디렉토리/브랜치), app-of-apps, 환경 분리·프로모션(dev→staging→prod·overlay/values), 동기화 제어(sync wave·hook·prune·self-heal), 롤백(git revert), 이미지 업데이트 자동화(다이제스트 고정), GitOps 시크릿 관리, 프로그레시브 딜리버리(카나리/블루그린), 전체 워크플로 다이어그램

---

## 0. 들어가며 — 무엇을 "어떻게" 두느냐의 문제

GitOps의 원리(선언형·단일 진실 소스·자동 pull·지속 조정)는 정해져 있다. 실무의 난점은 **"그 선언들을 Git에 어떻게 배치·구조화·자동화할 것인가"** 다. 이 문서는 그 **구현 패턴**을 다룬다. 잘못 설계하면 GitOps가 오히려 더 복잡해지므로, 패턴 선택의 **이유와 함정**까지 같이 본다.

---

## 1. 저장소 구조 설계

### 1.1 앱 코드 repo vs 배포 설정 repo 분리

GitOps의 첫 번째 결정은 **"애플리케이션 소스 코드"와 "배포 설정(매니페스트)"을 같은 repo에 둘지, 나눌지** 다.

| 구분 | 같은 repo (통합) | 분리 repo (app repo + config repo) |
|------|------------------|-------------------------------------|
| 구성 | 코드와 K8s 매니페스트가 한 저장소 | 코드 repo / 배포 설정 repo 별도 |
| 장점 | 단순, 한눈에 보임 | **관심사 분리**, CI/CD 권한 분리 깔끔 |
| 단점 | CI가 배포 설정 커밋 시 무한 루프 위험, 권한 섞임 | repo 2개 관리 |
| 권장 | 소규모/단일 앱 | **대부분의 실무·다중 환경** |

**분리(app repo + config repo)가 일반적**으로 권장된다. 이유:

- **무한 루프 방지**: 통합 repo에서 CI가 이미지 태그를 같은 repo에 커밋하면, 그 커밋이 다시 CI를 트리거하는 루프가 생길 수 있다. config repo를 분리하면 깔끔하다.
- **권한 분리**: 개발자는 app repo에, 배포 변경은 config repo PR로 → 운영 변경에 별도 승인 흐름을 건다.
- **재사용**: 여러 앱의 배포 설정을 config repo에서 일관되게 관리.

### 1.2 모노레포 vs 멀티레포 (config repo 기준)

| 항목 | 모노레포(설정 1개) | 멀티레포(앱/팀별 설정 repo) |
|------|--------------------|------------------------------|
| 가시성 | 전체를 한 곳에서 | 분산 |
| 권한(접근 제어) | 디렉토리 단위로만 제어(거칠다) | repo 단위로 깔끔히 분리 |
| 팀 자율성 | 충돌 가능 | **팀별 독립** |
| 적합 | 소~중규모, 적은 팀 | 다수 팀·강한 격리 필요 |

정답은 없다. **조직 규모와 권한 경계**로 결정한다. 작게 시작하면 모노레포, 팀이 늘면 분리하는 식이 흔하다.

### 1.3 환경 구분 — 디렉토리 vs 브랜치

같은 앱을 dev/staging/prod로 나눌 때 두 방식이 있다.

| 방식 | 설명 | 평가 |
|------|------|------|
| **디렉토리 방식** | `envs/dev/`, `envs/staging/`, `envs/prod/` 폴더로 환경 분리 (브랜치는 main 하나) | **권장.** 환경 간 차이를 PR diff로 한눈에 비교, 머지 충돌 적음 |
| **브랜치 방식** | `dev`/`staging`/`prod` 브랜치로 환경 분리 | 환경 간 cherry-pick/머지가 번거롭고 드리프트 나기 쉬움 — **일반적으로 비권장** |

★ 면접 포인트: "환경을 브랜치로 나누나 디렉토리로 나누나?" → **"디렉토리 권장. 브랜치 방식은 환경 간 변경 전파가 어렵고 드리프트가 생기기 쉽다."** 라고 답하면 실무 감각이 드러난다.

예시 디렉토리 구조(config repo):

```
config-repo/
├── base/                      # 공통 매니페스트(환경 무관)
│   ├── deployment.yaml
│   ├── service.yaml
│   └── kustomization.yaml
└── envs/
    ├── dev/
    │   └── kustomization.yaml # base + dev 패치(replica=1, dev 도메인 등)
    ├── staging/
    │   └── kustomization.yaml
    └── prod/
        └── kustomization.yaml # base + prod 패치(replica=3, ggang.cloud 등)
```

---

## 2. app-of-apps 패턴

**app-of-apps**는 **"애플리케이션들을 선언하는 또 하나의 애플리케이션"** 을 두는 패턴이다. 즉 부모 Application 하나가 여러 자식 Application 정의를 Git에서 읽어 일괄 생성·관리한다.

```
root (app-of-apps)
├── app: ingress-controller
├── app: cert-manager
├── app: monitoring
└── app: my-service (dev/staging/prod ...)
```

- **부트스트랩**: 새 클러스터에 root 하나만 적용하면, root가 나머지 모든 앱을 줄줄이 만들어낸다 → 클러스터 전체를 **Git 한 곳에서 선언**.
- **일괄 관리**: 앱을 추가/삭제하려면 root가 가리키는 디렉토리에 자식 정의를 넣고 빼면 된다.

함정: 부모가 자식의 **prune(삭제) 권한**까지 갖게 되므로, root에서 자식 정의를 잘못 지우면 줄줄이 삭제될 수 있다. prune 정책을 신중히.

---

## 3. 환경 분리와 프로모션 (dev → staging → prod)

### 3.1 프로모션이란

같은 변경을 **낮은 환경에서 검증한 뒤 높은 환경으로 올리는** 흐름이다. GitOps에서 프로모션은 곧 **"Git 변경을 환경 디렉토리/값에 반영하는 일"** 이다.

```
dev에서 새 이미지 검증
  → staging 디렉토리에 같은 이미지 태그 반영(PR·머지)
    → 검증 통과
      → prod 디렉토리에 반영(승인 PR·머지)
```

핵심: **"환경마다 무엇이 배포돼 있는가"가 전부 Git에 적혀 있다.** 프로모션 = 그 값을 다음 환경으로 옮기는 커밋.

### 3.2 환경별 차이를 표현하는 도구

같은 base에 환경별 차이(replica 수, 도메인, 리소스 한도 등)를 입히는 두 방식.

| 도구 | 방식 | 특징 |
|------|------|------|
| **Kustomize overlays** | `base` + 환경별 `overlay`에서 **패치(patch)** 로 덮어씀 | 템플릿 없이 순수 YAML 합성, K8s 내장 |
| **Helm values** | 차트(템플릿) + 환경별 `values-<env>.yaml` | 강력한 템플릿화, 파라미터화에 유리 |

Kustomize 예 (prod overlay가 replica를 3으로):

```yaml
# envs/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../base
patches:
  - target:
      kind: Deployment
      name: my-service
    patch: |
      - op: replace
        path: /spec/replicas
        value: 3
```

Helm 예 (환경별 values로 도메인/replica 분기):

```yaml
# values-prod.yaml
replicaCount: 3
ingress:
  host: app.ggang.cloud
```

★ 면접 포인트: "환경 차이를 어떻게 관리하나?" → **"공통 base를 두고 Kustomize overlay(패치) 또는 Helm 환경별 values로 환경별 차이만 덮어쓴다. 중복을 줄이고 base 변경이 전 환경에 일관 적용된다."**

---

## 4. 동기화(sync) 제어

GitOps 에이전트가 Git을 클러스터에 적용할 때, **순서·정리·교정**을 세밀하게 제어해야 할 때가 있다.

### 4.1 sync wave (순서 제어)

리소스에 **순서(wave) 번호**를 매겨 **낮은 wave부터 차례로** 적용한다. 의존성 있는 리소스(예: CRD → 그 CRD를 쓰는 리소스, DB → 앱)를 순서대로 올릴 때 쓴다.

```yaml
metadata:
  annotations:
    # 숫자가 작을수록 먼저 적용됨(음수 가능)
    argocd.argoproj.io/sync-wave: "1"
```

### 4.2 hook (생애주기 훅)

동기화 **특정 시점에 한 번 실행되는 작업**(보통 Job). 선언형으로 표현 어려운 절차적 작업을 끼워넣는 장치다.

- **PreSync**: 동기화 직전(예: DB 마이그레이션)
- **Sync**: 동기화 중
- **PostSync**: 동기화 후(예: 스모크 테스트, 알림)

```yaml
metadata:
  annotations:
    argocd.argoproj.io/hook: PreSync
    argocd.argoproj.io/hook-delete-policy: HookSucceeded  # 성공 시 정리
```

### 4.3 prune (Git에서 사라진 리소스 정리)

Git에서 리소스 정의를 **삭제했을 때**, 클러스터의 해당 리소스도 **지울지** 여부. prune을 켜야 "Git이 진짜 단일 진실 소스"가 된다. **단, 켜면 위험**하다(잘못 지우면 운영 리소스 삭제).

### 4.4 self-heal (드리프트 자동 교정)

클러스터가 Git과 어긋나면(누가 손으로 바꾸면) **자동으로 Git 상태로 되돌린다.** 켜면 임시 수동 변경이 살아남지 못한다(= 드리프트 봉쇄).

| 옵션 | 켜면 | 함정 |
|------|------|------|
| **prune** | Git에서 지운 리소스를 클러스터에서도 삭제 | 매니페스트 실수 삭제 → 운영 리소스 증발 |
| **self-heal** | 수동 변경을 자동 원복 | 긴급 핫픽스를 손으로 못 댐(반드시 Git 경유) |
| **자동 sync** | Git 변경을 자동 적용 | 잘못된 머지가 즉시 운영 반영 |

★★★ 면접 포인트: **자동 prune의 위험**을 반드시 알아둘 것. "GitOps에서 가장 조심할 설정?" → **"prune. Git에서 매니페스트를 실수로 빼면 운영 리소스가 통째로 삭제될 수 있다. 보통 PR 리뷰·dry-run·비운영 환경 먼저 검증으로 방어한다."**

---

## 5. 롤백 — git revert

GitOps의 롤백은 단순하다. **이전 상태로 되돌리는 = Git을 되돌리는 것.**

```bash
# 직전 배포 커밋을 되돌리는 새 커밋 생성
git revert <bad-commit-sha>
git push
# → 에이전트가 변경을 pull → 클러스터를 이전 상태로 조정
```

- `git revert`는 **새 커밋으로 되돌림**을 표현하므로 **이력이 보존**된다(reset과 달리 과거를 지우지 않음).
- "롤백"조차 하나의 **추적 가능한 커밋**으로 남는다 → 감사 일관성 유지.
- 단, **시크릿/외부 상태**(DB 스키마 등)는 Git revert만으로 안 돌아갈 수 있다. 마이그레이션 역적용 등 별도 고려 필요.

---

## 6. 이미지 업데이트 자동화

CI가 새 이미지를 만들면, **그 새 태그를 config repo에 반영**해야 CD가 배포한다. 이 "이미지 태그 → Git 커밋" 단계를 자동화하는 것이 GitOps의 핵심 자동화 포인트다.

### 6.1 기본 흐름

```
CI 빌드 성공 → 이미지를 레지스트리(GHCR)에 push
            → config repo의 deployment 이미지 태그를 새 값으로 커밋(자동)
            → CD 에이전트가 pull 감지 → 배포
```

방식 두 가지:

- **CI가 직접 커밋**: 빌드 잡 마지막에 config repo를 클론해 이미지 태그를 바꾼 커밋을 push(흔한 방식). CI는 config repo의 **쓰기 권한만** 가지면 되고 클러스터 자격증명은 불필요.
- **이미지 자동 갱신 컨트롤러**: 레지스트리를 감시하다 새 태그를 발견하면 자동으로 config repo에 커밋해 주는 별도 도구를 두는 방식(대안).

### 6.2 태그 vs 다이제스트 고정 (★ 중요)

이미지를 참조하는 방법은 둘이다.

| 방식 | 예 | 문제/이점 |
|------|----|-----------|
| **가변 태그** | `myapp:latest`, `myapp:v1` | 같은 태그가 **다른 이미지를 가리킬 수 있음** → 재현성 깨짐, 무엇이 떴는지 불확실 |
| **다이제스트 고정** | `myapp@sha256:abc...` | 내용 해시로 **불변 식별** → **정확한 재현성·무결성 보장** |

GitOps의 "버전·불변" 정신상 **다이제스트(sha256) 고정**이 권장된다. 최소한 `latest` 같은 떠다니는 태그는 피하고, **불변 태그(빌드별 고유 태그)** 나 다이제스트를 쓴다.

```yaml
# 권장: 불변 태그 + (가능하면) 다이제스트 고정
image: ghcr.io/<org>/my-service@sha256:9f2c...e1
```

★ 면접 포인트: "왜 latest 태그를 쓰면 안 되나?" → **"같은 태그가 시점마다 다른 이미지를 가리켜 재현성·롤백·드리프트 추적이 깨진다. 빌드별 불변 태그나 sha256 다이제스트로 고정해야 한다."**

---

## 7. GitOps 시크릿 관리

**평문 시크릿을 Git에 커밋하면 안 된다.** Git 이력은 영구라 한 번 들어간 비밀은 사실상 회수 불가다. GitOps에서 시크릿을 다루는 대표 접근(개념):

| 접근 | 원리 | 비고 |
|------|------|------|
| **봉인된 시크릿(Sealed Secrets류)** | 시크릿을 **공개키로 암호화한 형태**로 Git에 커밋. 클러스터 내 컨트롤러가 **개인키로 복호화**해 실제 Secret 생성 | 암호문은 Git에 둬도 안전. 클러스터별 키 |
| **파일 암호화(SOPS류)** | YAML의 **민감 필드만 암호화**해 커밋. 복호화 키는 KMS/외부에 보관 | diff 친화적(키는 그대로, 값만 암호화) |
| **외부 시크릿 오퍼레이터** | 실제 값은 외부 비밀 저장소(Vault 류)에 두고, Git에는 **"어디서 가져오라"는 참조만** 선언 → 오퍼레이터가 런타임 동기화 | Git에 비밀 자체가 없음 |

핵심 원칙 한 줄: **"민감 값의 평문은 Git에 들어가지 않는다. 암호문 또는 참조만 둔다."**

★ 면접 포인트: "GitOps에서 시크릿을 어떻게 다루나?" → **"평문 금지. ① 암호화해서 커밋(봉인된 시크릿/파일 암호화) 또는 ② 외부 시크릿 저장소를 참조만 한다."**

---

## 8. 프로그레시브 딜리버리 (점진적 배포)

새 버전을 한 번에 전부 교체하지 않고 **점진적으로 트래픽을 옮기며** 위험을 줄이는 기법. GitOps와 결합해 배포 전략 자체를 선언형으로 관리한다.

| 전략 | 방식 | 장점 / 주의 |
|------|------|-------------|
| **블루-그린(Blue-Green)** | 새 버전(green)을 **별도로 띄워** 준비 → 트래픽을 한 번에 green으로 전환. 문제 시 blue로 즉시 복귀 | 즉시 롤백 쉬움 / 리소스 2배 |
| **카나리(Canary)** | 새 버전에 **소량 트래픽(예: 5%→25%→100%)** 부터 점진 노출하며 지표 관찰 | 위험 작음 / 점진 제어·지표 분석 필요 |
| **롤링(Rolling, 기본)** | 파드를 조금씩 교체(K8s 기본) | 단순 / 세밀한 트래픽 제어는 없음 |

- 카나리/블루-그린은 보통 **별도 컨트롤러(롤아웃 도구)** 나 **서비스 메시**의 트래픽 분할과 함께 쓴다.
- GitOps에서는 이 롤아웃 전략·단계도 **Git의 선언으로** 관리한다(원하는 전략을 매니페스트에 박아둠).

---

## 9. 전체 워크플로 다이어그램

프로젝트 스택(CI = 빌드 자동화, 레지스트리 = GHCR, CD = GitOps 에이전트, 도메인 = ggang.cloud) 기준 전체 흐름:

```
┌────────────┐  1. 코드 push
│  개발자     │ ───────────────►  app repo (소스 코드)
└────────────┘                        │
                                      │ 2. webhook 트리거
                                      ▼
                              ┌──────────────┐
                              │   CI 서버     │  빌드 → 테스트 → 이미지 빌드
                              └──────────────┘
                                      │ 3. push
                                      ▼
                              ┌──────────────┐
                              │    GHCR       │  ghcr.io/<org>/my-service:<불변태그>
                              └──────────────┘
                                      │ 4. CI가 새 이미지 태그를
                                      │    config repo에 커밋(자동)
                                      ▼
                              ┌──────────────┐
                              │  config repo  │  envs/prod/... 의 image 태그 갱신
                              │ (단일 진실    │   ◄── 사람은 여기 PR로 변경/프로모션
                              │   소스)       │
                              └──────────────┘
                                      ▲ 5. pull / watch
                                      │
                              ┌──────────────┐
                              │ CD 에이전트    │  Git desired vs 클러스터 actual 비교
                              │ (클러스터 내) │  → 6. sync(조정) / self-heal / prune
                              └──────────────┘
                                      │ 7. apply
                                      ▼
                              ┌──────────────┐
                              │   클러스터     │  app.ggang.cloud 로 서비스
                              └──────────────┘
```

핵심: **CI는 config repo까지만 쓰고(클러스터 자격증명 없음), CD는 config repo를 읽어 클러스터에 조정한다. 둘의 접점은 Git 하나다.**

---

## 10. 함정·실무 체크리스트

- **prune 사고**: 매니페스트 실수 삭제 → 운영 리소스 증발. 비운영 환경 먼저·PR 리뷰·dry-run으로 방어.
- **self-heal와 긴급 대응 충돌**: self-heal이 켜져 있으면 손으로 한 핫픽스가 즉시 원복된다 → **모든 변경은 Git 경유**가 원칙.
- **이미지 태그 가변성**: `latest` 금지, 불변 태그/다이제스트 고정.
- **시크릿 평문 커밋**: 절대 금지. 한 번 들어가면 이력에서 회수 불가.
- **무한 루프**: 통합 repo에서 CI가 같은 repo에 커밋하면 CI를 또 트리거할 수 있음 → config repo 분리.
- **비선언적 작업**: DB 마이그레이션 등은 hook(PreSync Job)으로 분리해 처리.
- **롤백의 외부 상태**: git revert로 매니페스트는 돌아가도 DB 스키마 등 외부 상태는 별도 처리 필요.

---

### 한 줄 요약

GitOps 구현은 **앱 repo와 config repo를 분리**하고 환경을 **디렉토리 + Kustomize overlay/Helm values**로 나누며, **app-of-apps**로 클러스터 전체를 선언한다. CI는 **불변 태그/다이제스트로 빌드한 이미지를 GHCR에 push하고 그 태그를 config repo에 커밋**, CD 에이전트는 그걸 **pull해 sync(순서=sync wave, 절차=hook, 정리=prune, 교정=self-heal)** 한다. 롤백은 **`git revert`**, 시크릿은 **암호화/외부 참조**, 배포 위험은 **카나리/블루-그린**으로 줄인다. 최대 함정은 **자동 prune·평문 시크릿·가변 태그(latest)** 다.

---

### 참고 (공식 문서)

- OpenGitOps 원칙: <https://opengitops.dev/>
- Kustomize (Kubernetes): <https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/>
- Argo CD — Sync waves & hooks: <https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/>
- Argo CD — App of Apps 패턴: <https://argo-cd.readthedocs.io/en/stable/operator-manual/cluster-bootstrapping/>
- Kubernetes — Image pull & digests: <https://kubernetes.io/docs/concepts/containers/images/>
