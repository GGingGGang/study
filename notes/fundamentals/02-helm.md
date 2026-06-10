# Helm

## 1. Why — 왜 쓰는가

Kubernetes의 패키지 매니저. `apt`나 `npm` 같은 역할을 k8s 매니페스트에 한다. 본 프로젝트가 거의 모든 인프라 컴포넌트를 Helm으로 설치하는 사유.

**raw manifest의 한계**:
- 환경별 다른 값(이미지 태그, 리소스 크기, 도메인)을 처리하기 어려움. 모든 YAML을 복사해서 수정해야 함.
- 50개 manifest로 구성된 컴포넌트(예: Istio) 설치를 수동으로 관리 못 함.
- upgrade 시 어떤 manifest가 변경됐는지 추적 안 됨, 부분 적용 실패 처리 안 됨.
- rollback 메커니즘 없음.
- 의존성 관리 없음 (예: Prometheus 설치 전 CRD 먼저 필요).

**Helm의 해결**:
- **Template + Values**: 매니페스트를 Go template으로 작성하고 values.yaml로 값만 분리
- **Release 관리**: 설치된 차트를 "Release"로 추적, upgrade/rollback 명령 한 줄
- **의존성**: chart가 다른 chart를 dependency로 선언
- **Repository**: 공식 차트(prometheus-community, jetstack 등)를 받아서 사용
- **Hook**: 설치 전/후 작업 정의 (CRD 설치, DB 마이그레이션 등)

**대체재**:
- **Kustomize**: 더 단순, k8s 내장(`kubectl apply -k`). Template 대신 patch 방식. 작은 변경엔 좋으나 복잡한 차트엔 부족.
- **Jsonnet/CUE**: 강력하나 학습곡선 가파름. 사용자 적음.
- **CDK8s** (k8s용 CDK): TypeScript/Python으로 정의. 새로운 패러다임이나 생태계 작음.
- **Helm**: 사실상 표준. 모든 주요 컴포넌트가 공식 Helm chart 제공.

본 프로젝트는 Helm + ArgoCD 조합. ArgoCD가 Helm chart를 native source로 지원해서 자연스럽게 결합.

## 2. Architecture — 어떻게 구성되는가

**핵심 개념 5가지**:

- **Chart**: 패키지. 매니페스트 템플릿 + 메타데이터의 묶음. `.tgz` 파일 또는 디렉토리.
- **Template**: Go template 문법으로 작성된 매니페스트. `.yaml`이지만 `{{ .Values.image.tag }}` 같은 변수 포함.
- **Values**: 템플릿에 주입할 값. `values.yaml`(기본값) + 사용자가 제공한 값 병합.
- **Release**: 차트의 설치 인스턴스. 같은 차트를 여러 namespace에 설치하면 각각 별도 Release.
- **Repository**: chart 저장소. HTTP 기반 또는 OCI registry 기반.

**Chart 디렉토리 구조**:

```
mychart/
├── Chart.yaml          # 메타데이터 (이름, 버전, 의존성)
├── values.yaml         # 기본값
├── templates/          # Go template 매니페스트
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── _helpers.tpl    # 재사용 함수 (template)
│   └── NOTES.txt       # 설치 후 사용자 안내
├── charts/             # 의존 chart (subchart)
└── crds/               # CRD (template 외부, lifecycle 다름)
```

**Helm 3.x 핵심 변화** (vs Helm 2):
- **Tiller 제거**: Helm 2는 클러스터 내 Tiller pod이 cluster-admin 권한으로 동작 → 보안 위험. Helm 3는 클라이언트가 직접 kube-apiserver와 통신
- **Release 저장**: ConfigMap → Secret으로 변경 (더 안전, 64KB 한도 우회)
- **3-way merge**: 사용자 manual 변경 + chart 변경 + 라이브 상태 3-way merge
- **namespace 자동 생성 안 함**: `--create-namespace` 명시 필요

## 3. Mechanism — 어떻게 돌아가는가

**`helm install` 흐름**:

1. 사용자가 `helm install my-release my-chart -f values.yaml`
2. Helm CLI가 chart 디렉토리에서 `Chart.yaml`, `values.yaml`, `templates/` 로드
3. **Template rendering**: `values.yaml`(default) + 사용자 -f 옵션 + `--set` 플래그 병합 → 모든 `{{ ... }}` 치환
4. 렌더된 매니페스트를 kube-apiserver에 apply
5. **Release 정보를 Secret에 저장**: namespace 안에 `sh.helm.release.v1.<release>.<version>` 형식 Secret 생성. 안에 chart + values + 매니페스트 압축 저장.
6. NOTES.txt 출력 (사용자 안내)

**`helm upgrade` 흐름**:

1. 사용자가 `helm upgrade my-release my-chart -f values.yaml`
2. 이전 Release Secret에서 이전 매니페스트 가져옴
3. 새 매니페스트 렌더링
4. **3-way merge**: (1) live cluster state, (2) old manifest, (3) new manifest 세 개 비교
5. 차이점만 patch 적용
6. 새 Release version Secret 생성 (revision 증가)

**`helm rollback` 흐름**:

1. `helm rollback my-release 3` (revision 3으로)
2. Revision 3의 Secret에서 매니페스트 복원
3. 현재 매니페스트와 차이만 apply
4. 새 revision으로 기록 (revision은 항상 증가, rollback도 새 revision)

**Hook 메커니즘**: 매니페스트에 annotation 추가로 lifecycle 시점 지정
- `pre-install` / `post-install`: 설치 전후
- `pre-upgrade` / `post-upgrade`: 업그레이드 전후
- `pre-delete` / `post-delete`: 삭제 전후
- `test`: `helm test` 시 실행
- 흔한 사용: DB 마이그레이션 Job, CRD 사전 설치, 정리 작업

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Helm 사용처 (거의 모든 인프라 컴포넌트).

| 컴포넌트 | Chart | Repo |
|----------|-------|------|
| Istio (base, istiod, cni, ztunnel, gateway) | istio/* | istio.io |
| cert-manager | jetstack/cert-manager | charts.jetstack.io |
| external-dns | external-dns/external-dns | kubernetes-sigs.github.io |
| ArgoCD | argo/argo-cd | argoproj.github.io |
| Jenkins | jenkins/jenkins | charts.jenkins.io |
| kube-prometheus-stack | prometheus-community/kube-prometheus-stack | prometheus-community.github.io |
| Loki | grafana/loki | grafana.github.io |
| Tempo | grafana/tempo | grafana.github.io |
| Grafana Alloy | grafana/alloy | grafana.github.io |
| Kiali | kiali/kiali-server | kiali.org |
| Vault / OpenBao | hashicorp/vault, openbao/openbao | helm.releases.hashicorp.com, openbao.org |
| Strimzi Kafka Operator | strimzi/strimzi-kafka-operator | strimzi.io |
| Cilium | cilium/cilium | helm.cilium.io |
| Velero | vmware-tanzu/velero | vmware-tanzu.github.io |
| Kyverno | kyverno/kyverno | kyverno.github.io |

**ArgoCD + Helm 결합 패턴**:
ArgoCD의 `Application` 리소스에 Helm chart source + values 명시. ArgoCD가 `helm template`로 매니페스트 렌더링 후 직접 apply. **`helm install`은 호출하지 않음** — Release Secret이 안 만들어짐. 이게 중요한 차이점: ArgoCD는 자체 추적을 하므로 Helm Release 관리는 ArgoCD가 대신함.

## 5. Usage — 어떻게 쓰는가

**Repository 관리**:

```bash
# repo 추가
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update                          # 최신 정보 fetch

# 검색
helm search repo prometheus
helm show values prometheus-community/kube-prometheus-stack > values.yaml
```

**설치/업그레이드**:

```bash
# 설치
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  --version 70.0.0 \
  -f values.yaml

# 업그레이드 (없으면 설치)
helm upgrade --install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  -f values.yaml \
  --version 70.0.0

# 미리보기 (실제 apply 안 함)
helm install prometheus ... --dry-run --debug
```

**Release 관리**:

```bash
helm list -n monitoring                   # 설치된 release 목록
helm history prometheus -n monitoring     # revision 이력
helm rollback prometheus 3 -n monitoring  # revision 3으로
helm uninstall prometheus -n monitoring   # 삭제
```

**Template 디버깅**:

```bash
helm template my-release my-chart -f values.yaml    # 렌더링 결과만 출력
helm lint my-chart                                   # chart 문법 검증
helm install my-release my-chart --dry-run --debug   # 실제 apply 없이 검증
```

**values 우선순위** (낮음 → 높음):
1. chart의 `values.yaml`
2. parent chart의 `values.yaml` (subchart인 경우)
3. `-f` 옵션으로 지정한 파일
4. `--set` 플래그

## 6. Configuration — 어떤 설정이 있는가

**Chart.yaml 필수 필드**:

```yaml
apiVersion: v2          # Helm 3는 v2
name: my-chart
version: 1.0.0          # chart 자체 버전 (semver)
appVersion: "1.34.0"    # 패키징된 앱 버전 (참고용)
type: application       # application / library
dependencies:
- name: postgresql
  version: 13.x.x
  repository: https://charts.bitnami.com/bitnami
  condition: postgresql.enabled
```

**Template 함수** (자주 쓰는 것):

```yaml
{{ .Values.image.tag | default "latest" }}      # default 값
{{ .Values.replicas | int }}                     # 타입 변환
{{ include "mychart.fullname" . }}               # _helpers.tpl 호출
{{ toYaml .Values.resources | nindent 4 }}       # YAML 변환 + 들여쓰기
{{ if .Values.ingress.enabled }} ... {{ end }}   # 조건
{{ range .Values.services }} ... {{ end }}       # 반복
{{- end }}                                        # 공백 제거
```

**Hook 예시** (CRD 설치 전 처리):

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: pre-install-job
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "-5"          # 낮을수록 먼저
    "helm.sh/hook-delete-policy": before-hook-creation
```

**Subchart vs Library chart**:
- Subchart: 부모 chart의 의존성. 부모와 함께 설치됨.
- Library chart: 매니페스트 만들지 않음. 다른 chart가 import해서 template 함수 재사용.

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Helm 3.x 필수** (Helm 2는 EOL, Tiller 보안 문제)
- **Kubernetes 호환성**: chart의 `kubeVersion` 필드 확인. 본 프로젝트 k8s 1.34는 modern chart 대부분 호환
- **CRD lifecycle**: `crds/` 디렉토리의 CRD는 Helm이 install 시 생성하지만 **upgrade/delete 시 건드리지 않음**. CRD 변경은 수동 처리 필요
- **OCI registry**: Helm 3.8+부터 OCI registry(Harbor, ghcr 등)에서 chart 저장 가능. `helm push`/`helm pull` 지원
- **Chart API version**: `v1`(Helm 2 시대)은 deprecated, `v2`만 사용
- **Plugin 호환성**: `helm-diff`, `helm-secrets` 같은 plugin은 Helm 3 호환 버전 사용

## 8. 면접 예상 질문 & 답변

**Q1. Helm을 왜 쓰나요? kubectl apply만으로 충분하지 않나요?**
> 50개 매니페스트로 구성된 컴포넌트(예: kube-prometheus-stack)를 환경별 설정만 바꿔서 설치할 때 raw manifest로는 모든 YAML을 복사해서 수정해야 합니다. Helm은 template + values로 분리해서 환경별 차이는 values.yaml만 바꾸면 되게 만듭니다. 또 helm upgrade는 변경된 매니페스트만 patch하고 helm rollback으로 revision 단위로 되돌릴 수 있어서 운영 안정성이 큽니다. 본 프로젝트는 30+개 컴포넌트를 모두 Helm으로 관리합니다.

**Q2. Helm 2와 Helm 3 차이가 뭐예요?**
> 가장 큰 차이는 Tiller 제거입니다. Helm 2는 클러스터 안에 Tiller라는 server pod이 cluster-admin 권한으로 동작했는데, Tiller 자체가 큰 보안 취약점이었습니다. Helm 3는 client-only 아키텍처로 사용자 kubeconfig 권한으로 직접 kube-apiserver와 통신합니다. 두 번째 차이는 Release 저장 위치가 ConfigMap에서 Secret으로 바뀐 거고, 세 번째는 3-way merge로 사용자가 수동 변경한 매니페스트를 helm upgrade가 덮어쓰지 않게 됐습니다.

**Q3. ArgoCD와 Helm을 같이 쓰는데, helm install이 호출되나요?**
> 아니요. ArgoCD는 Helm chart를 source로 받지만 `helm template` 명령으로 매니페스트만 렌더링한 후 자신이 직접 kube-apiserver에 apply합니다. 결과적으로 Helm Release Secret이 생성되지 않고 ArgoCD의 Application 리소스가 추적 단위가 됩니다. 이 패턴의 장점은 ArgoCD가 desired state(Git)와 actual state(클러스터)를 직접 비교할 수 있다는 점이고, 단점은 `helm rollback` 같은 Helm 기본 명령이 안 통한다는 점인데 ArgoCD UI의 history rollback으로 대체합니다.

**Q4. Helm template에서 자주 쓰는 함수 5개만 답해주세요.**
> `default`(값이 없으면 기본값), `include`(다른 template 호출, _helpers.tpl 활용), `toYaml`(map을 YAML 문자열로), `nindent`(들여쓰기), `quote`(문자열을 따옴표로 감싸기) 다섯 개가 가장 자주 쓰입니다. 예를 들어 `{{ toYaml .Values.resources | nindent 8 }}`는 values의 resources 객체를 YAML로 변환하면서 8 칸 들여쓰기를 주는 패턴이고, 이게 90%의 chart에서 보입니다.

**Q5. Helm Hook 종류와 언제 쓰나요?**
> 핵심 hook은 6개입니다. `pre-install`/`post-install`은 차트 설치 전후, `pre-upgrade`/`post-upgrade`는 업그레이드 전후, `pre-delete`/`post-delete`는 삭제 전후입니다. 가장 흔한 사용 사례는 DB 마이그레이션 Job을 pre-upgrade로 돌려서 새 버전 배포 전에 schema migration을 끝내는 거고, 또 다른 사례는 CRD를 pre-install로 사전 설치하는 패턴입니다. 본 프로젝트는 ArgoCD sync-wave를 더 선호하지만 일부 차트(kube-prometheus-stack의 admission controller 등)는 hook 기반으로 동작합니다.

**Q6. CRD 관리는 어떻게 해야 하나요?**
> Helm의 `crds/` 디렉토리는 함정이 있습니다. Helm이 install 시 CRD를 생성하지만 **upgrade와 delete 시 건드리지 않습니다**. 그래서 CRD 버전을 올리고 싶으면 `helm upgrade`로는 안 되고 수동으로 kubectl apply해야 합니다. 본 프로젝트는 이 함정을 피하기 위해 (1) Gateway API CRD처럼 cross-cutting CRD는 별도 manifest로 ArgoCD에 띄우고, (2) chart 내장 CRD(예: cert-manager)는 `--set crds.enabled=true`로 처음 install 시만 적용한 후 upgrade는 별도 처리합니다.

**Q7. values.yaml에 있는 모든 옵션을 다 외울 수는 없는데, 어떻게 학습해야 해요?**
> 두 가지 명령이 핵심입니다. `helm show values <chart>`는 chart의 default values를 모두 출력해서 어떤 옵션이 있는지 보여줍니다. 본 프로젝트는 이 출력을 파일로 저장해서 주석을 읽고 필요한 옵션만 본인 values.yaml에 옮깁니다. 두 번째는 `helm template <chart> -f values.yaml`로 렌더링 결과를 보면서 본인이 준 값이 실제로 어떤 매니페스트를 만드는지 검증합니다. 이 두 명령을 모르면 Helm chart 사용이 추측이 됩니다.

**Q8. Subchart의 values는 어떻게 override하나요?**
> Parent chart의 values.yaml에서 subchart 이름을 키로 사용합니다. 예를 들어 `dependencies`에 `postgresql`이 있으면 parent values.yaml에 `postgresql: { auth: { password: xxx } }` 형식으로 적습니다. 이게 subchart의 values.yaml의 `auth.password`를 override합니다. 또 global values는 모든 subchart에 전파되는데 `global: { storageClass: oci-bv }` 같은 식으로 공통 값을 전파할 때 씁니다.

**Q9. helm install이 실패했을 때 어떻게 복구해요?**
> Helm 3는 install 실패 시 default로 partial 상태를 남깁니다. 두 가지 옵션이 있는데 (1) `--atomic` 플래그를 추가하면 실패 시 자동 rollback해서 클러스터를 깨끗하게 만듭니다. (2) `--cleanup-on-fail` 옵션도 비슷하게 만든 리소스를 정리합니다. 운영 환경에서는 둘 다 켜는 게 표준입니다. 본 프로젝트는 ArgoCD가 처리하지만, 수동 install 시에는 항상 `--atomic --wait --timeout=10m`을 같이 줍니다.

**Q10. Helm chart를 직접 만들어야 한다면 어떤 구조로 만드나요?**
> 본 프로젝트의 앱(Login/Core/Batch) chart는 다음 구조입니다. (1) `Chart.yaml`에 메타데이터 + image tag는 `appVersion`에 명시, (2) `values.yaml`에 image, resources, probes, hpa, env 등 환경에 따라 바뀌는 모든 것, (3) `templates/_helpers.tpl`에 공통 함수(이름, label, selector), (4) `templates/deployment.yaml`, `service.yaml`, `httproute.yaml`, `hpa.yaml`, `servicemonitor.yaml` 등 매니페스트 파일들, (5) `templates/NOTES.txt`에 설치 후 안내. 세 서버가 거의 동일한 구조라 library chart로 빼서 재사용하는 것도 고려할 수 있습니다.

**Q11. Helm vs Kustomize 어느 게 나은가요?**
> 사용 케이스가 다릅니다. Kustomize는 base + overlay 패턴으로 작은 변경(라벨 추가, namespace 변경, image tag 교체 등)에 좋고 학습곡선이 거의 없습니다. kubectl 내장이라 추가 도구도 필요 없습니다. Helm은 복잡한 매니페스트(50개 리소스 + 의존성 + lifecycle hook)를 패키지화할 때 강합니다. 본 프로젝트는 인프라 컴포넌트는 무조건 Helm(공식 chart 사용), 앱은 단순해서 Kustomize도 가능하지만 일관성을 위해 Helm으로 통일했습니다. ArgoCD는 둘 다 native 지원합니다.

**Q12. Helm chart 보안은 어떻게 챙기나요?**
> 세 가지 레이어로 갑니다. (1) Repository 자체를 신뢰: 공식 chart(prometheus-community, jetstack 등)만 사용, 임의 chart는 매니페스트 렌더링해서 검토. (2) `helm template`으로 렌더 결과를 봐서 의심스러운 RBAC(cluster-admin 부여 등) 확인. (3) Provenance signing: `--verify` 옵션으로 chart 서명 검증. 본 프로젝트는 (1)과 (2)를 항상 수행하고, ArgoCD가 적용하기 전에 PR 단위로 매니페스트 검토를 강제합니다.
