# 07. Helm과 Kustomize

> 도메인: 클러스터 아키텍처, 설치 및 구성 (25%)
> 시험 포인트: 2025 개정판 신규 항목 — "Helm과 Kustomize를 사용해 클러스터 컴포넌트 설치". 시험 중 helm.sh/docs 접근 가능.

---

## 1. Helm — 쿠버네티스 패키지 매니저

- **Chart**: 패키지 (템플릿화된 매니페스트 묶음)
- **Release**: 차트를 특정 값으로 설치한 인스턴스
- **Repository**: 차트 저장소
- **values.yaml**: 차트의 설정값 (설치 시 오버라이드 가능)

### 1-1. 저장소 관리
```bash
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo list
helm repo update                       # 저장소 인덱스 갱신 (설치 전 습관)
helm search repo nginx                 # 저장소에서 검색
helm search repo nginx --versions      # 사용 가능한 모든 버전
helm search hub wordpress              # Artifact Hub 검색
```

### 1-2. 설치 / 업그레이드 / 롤백 / 삭제
```bash
helm install myweb bitnami/nginx -n web --create-namespace
helm install myweb bitnami/nginx --version 15.0.0        # 특정 차트 버전
helm install myweb bitnami/nginx -f custom-values.yaml   # 값 파일로 오버라이드
helm install myweb bitnami/nginx --set replicaCount=3    # 개별 값 오버라이드

helm upgrade myweb bitnami/nginx --set replicaCount=5
helm upgrade --install myweb bitnami/nginx               # 없으면 설치, 있으면 업그레이드

helm rollback myweb 1                  # 리비전 1로 롤백
helm uninstall myweb -n web
```

### 1-3. 조회 / 검사
```bash
helm list -A                           # 모든 네임스페이스의 릴리스
helm list -n web --all                 # 실패한 릴리스 포함
helm status myweb -n web
helm history myweb                     # 리비전 이력 (rollback 대상 확인)
helm get values myweb                  # 설치에 사용된 값
helm get manifest myweb                # 실제 적용된 매니페스트

helm show values bitnami/nginx         # 차트의 기본 values.yaml 보기 (커스터마이즈 전 확인)
helm show chart bitnami/nginx
helm template myweb bitnami/nginx      # 설치하지 않고 렌더링 결과만 출력
helm install myweb bitnami/nginx --dry-run --debug
```

### 시험에서 나올 만한 유형
- 특정 차트를 특정 버전/값으로 설치하라
- 기존 릴리스를 새 버전으로 업그레이드하라 (`helm repo update` → `helm search repo --versions` → `helm upgrade --version`)
- 실패/불필요 릴리스를 찾아 삭제하라 (`helm list -A --all`)
- 차트를 **설치하지 말고** 매니페스트만 뽑아라 (`helm template`)

## 2. Kustomize — 템플릿 없는 YAML 커스터마이징

- kubectl에 **내장** (`kubectl apply -k`, `kubectl kustomize`)
- 원본 YAML을 수정하지 않고 **오버레이(patch)를 겹쳐** 환경별 변형을 만든다

### 2-1. 기본 구조
```
myapp/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
└── overlays/
    ├── dev/
    │   └── kustomization.yaml
    └── prod/
        ├── kustomization.yaml
        └── replica-patch.yaml
```

```yaml
# base/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
```

```yaml
# overlays/prod/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../../base            # base를 참조
namespace: prod          # 모든 리소스에 네임스페이스 적용
namePrefix: prod-        # 이름 접두사
commonLabels:
  env: prod
images:                  # 이미지 태그 교체
- name: nginx
  newTag: "1.27"
patches:                 # 전략적 병합 패치
- path: replica-patch.yaml
```

```yaml
# overlays/prod/replica-patch.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 5
```

### 2-2. 적용과 확인
```bash
kubectl kustomize overlays/prod          # 렌더링 결과만 출력 (검증용)
kubectl apply -k overlays/prod           # 빌드 + 적용
kubectl delete -k overlays/prod
```

### 2-3. Generator (ConfigMap/Secret 생성)
```yaml
# kustomization.yaml
configMapGenerator:
- name: app-config
  literals:
  - LOG_LEVEL=debug
  files:
  - config.properties
secretGenerator:
- name: app-secret
  literals:
  - password=s3cret
```
- 생성되는 이름에 내용 해시가 접미사로 붙음(`app-config-7b58f9m6ck`) → 내용이 바뀌면 이름이 바뀌어 **참조하는 Deployment가 자동 롤아웃**됨. 해시를 끄려면:
  ```yaml
  generatorOptions:
    disableNameSuffixHash: true
  ```

## 3. Helm vs Kustomize 선택 기준

| | Helm | Kustomize |
|---|---|---|
| 방식 | Go 템플릿 + values | 원본 + 오버레이 패치 |
| 배포 단위 | Release(이력/롤백 내장) | 그냥 kubectl apply |
| 서드파티 설치 | 강함 (차트 생태계) | 약함 |
| 자체 앱 환경 분리 | 가능 | 강함 (선언적, 단순) |
| 설치 | 별도 CLI | kubectl 내장 |

## 4. 체크리스트

- [ ] `helm repo add/update`, `search repo --versions`, `install/upgrade/rollback/uninstall`을 안다
- [ ] `helm list -A`, `helm get values`, `helm show values` 구분한다
- [ ] `helm template` = 설치 없이 렌더링임을 안다
- [ ] kustomization.yaml의 resources / namespace / namePrefix / images / patches를 쓸 수 있다
- [ ] `kubectl apply -k`와 `kubectl kustomize` 차이를 안다
- [ ] configMapGenerator의 해시 접미사 동작을 안다
