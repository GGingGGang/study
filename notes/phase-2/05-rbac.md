# Kubernetes RBAC

## 1. Why — 왜 쓰는가

Kubernetes의 Role-Based Access Control. 누가(Subject) 어떤 리소스에(Resource) 어떤 행동을(Verb) 할 수 있는지 정의하는 권한 시스템.

**왜 필요한가**:
- 개발자 실수로 prod namespace의 Secret을 삭제하는 사고 방지
- ArgoCD가 자기 namespace를 넘어 다른 곳에 배포 가능한 권한이 있으면 ArgoCD 탈취 시 클러스터 전체 위험
- 컴플라이언스(SOC2, ISO 27001 등)는 최소 권한 원칙 요구
- 면접에서 가장 자주 묻는 영역. "ArgoCD가 어떤 권한을 가져야 해요?" 즉답 못하면 감점

**대체재**: Kubernetes RBAC가 사실상 표준. OPA Gatekeeper, Kyverno는 RBAC 위에 정책을 추가하는 보완 도구이지 대체재 아님.

## 2. Architecture — 어떻게 구성되는가

**4가지 핵심 리소스**:

- **Role** (namespace-scoped): 특정 namespace 내 권한 정의. 어떤 리소스에 어떤 verb 허용.
- **ClusterRole** (cluster-scoped): 클러스터 전체 또는 모든 namespace에 적용 가능한 권한.
- **RoleBinding**: Role 또는 ClusterRole을 특정 namespace 내 subject에 바인딩.
- **ClusterRoleBinding**: ClusterRole을 클러스터 전체 subject에 바인딩.

**Subject 종류**:
- `User`: 외부 사용자 (kubeconfig + CA 인증서, 또는 OIDC)
- `Group`: User들의 모음 (OIDC claim 등으로 결정)
- `ServiceAccount`: pod 내부 컴포넌트. 본 프로젝트가 주로 다루는 영역

**조합 규칙**:
- Role + RoleBinding: 단일 namespace 내 권한
- ClusterRole + RoleBinding: 모든 namespace에 동일한 권한 부여 시 ClusterRole 재사용
- ClusterRole + ClusterRoleBinding: cluster-wide 권한 (위험, 신중하게)

## 3. Mechanism — 어떻게 돌아가는가

**요청 흐름**:

1. API 요청 도착 (예: `kubectl get pods -n app`)
2. Authentication: 누가? (User/SA 인증, kubeconfig token 또는 SA token 검증)
3. Authorization: 무엇을? RBAC authorizer가 평가
4. Admission Control: 허용 가능한가? (PSA, Kyverno 등)
5. 실행

**RBAC 평가**:
- API 요청의 (subject, verb, resource, namespace) 튜플 추출
- 해당 subject에 바인딩된 모든 Role/ClusterRole 수집
- 각 Role의 rule에 매칭되는 게 있으면 허용
- 매칭 없으면 거부 (deny by default)

**SA Token 진화**:
- **Legacy SA Token**: namespace 생성 시 자동 Secret 발급, 만료 없음. 유출 시 영구 사용 가능
- **Projected SA Token** (Kubernetes 1.21+ default): pod 안에서 짧은 만료(default 1시간) JWT 자동 발급/갱신. 더 안전
- 본 프로젝트는 projected token만 사용

**Aggregation**:
- ClusterRole에 `aggregationRule` 지정하면 label 기반으로 다른 ClusterRole의 rule을 자동 병합
- 예: `kubernetes.io/bootstrapping: rbac-defaults` label이 있는 모든 ClusterRole 병합
- 본 프로젝트에서는 적극 사용 안 함 (단순성 우선)

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 RBAC 의존 관계.

- **ArgoCD ServiceAccount**: `app` namespace에 RoleBinding (Deployment/Service/HTTPRoute/HPA 관리). Secret은 별도 제한.
- **Jenkins ServiceAccount**: 두 개 분리.
  - `cicd` namespace 내부 권한 (자기 pod 관리)
  - `app` namespace에 배포 트리거용 별도 SA + RoleBinding
- **Prometheus ServiceAccount**: ClusterRole (`nodes/metrics`, `services`, `endpoints`, `pods` read-only). cluster-wide 메트릭 수집.
- **cert-manager ServiceAccount**: ClusterRole (Certificate/Issuer 관리, Secret create/update 권한)
- **external-dns ServiceAccount**: ClusterRole (Service/Ingress/HTTPRoute read, 자기 상태 update)
- **Istio Pilot ServiceAccount**: ClusterRole (모든 리소스 watch, mTLS 인증서 발급)
- **Velero ServiceAccount**: ClusterRole (cluster-wide backup/restore)

**원칙**:
- 최소 권한 (Principle of Least Privilege)
- Secret 권한은 별도 분리 (외부 secret manager 우회 방지)
- ClusterRole 사용은 정말 cluster-wide가 필요한 경우만 (Prometheus, cert-manager, Istio)

## 5. Usage — 어떻게 쓰는가

**ServiceAccount 생성**:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: argocd-app-deployer
  namespace: cicd
```

**Role (namespace-scoped)**:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: app-deployer
  namespace: app
rules:
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["services", "configmaps", "pods"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["gateway.networking.k8s.io"]
  resources: ["httproutes"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# Secret은 명시적 제외 (외부 secret manager로 관리)
```

**RoleBinding**:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: argocd-app-deployer
  namespace: app
subjects:
- kind: ServiceAccount
  name: argocd-app-deployer
  namespace: cicd
roleRef:
  kind: Role
  name: app-deployer
  apiGroup: rbac.authorization.k8s.io
```

**Pod에서 SA 사용**:

```yaml
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: argocd-app-deployer
  automountServiceAccountToken: true   # default true
  containers:
  - name: app
    # /var/run/secrets/kubernetes.io/serviceaccount/token 에 projected token 자동 마운트
```

**Projected token 명시적 설정 (만료 단축)**:

```yaml
volumes:
- name: sa-token
  projected:
    sources:
    - serviceAccountToken:
        path: token
        expirationSeconds: 3600   # 1시간 만료
        audience: vault           # 특정 audience용
```

**검증 명령**:

```bash
# 어떤 SA가 어떤 권한을 가지는지
kubectl auth can-i create deployments --as=system:serviceaccount:cicd:argocd-app-deployer -n app

# 특정 user의 모든 권한 조회
kubectl auth can-i --list --as=system:serviceaccount:cicd:argocd-app-deployer -n app

# RoleBinding 확인
kubectl get rolebinding -n app -o wide
```

## 6. Configuration — 어떤 설정이 있는가

**Role rule 옵션**:
- `apiGroups`: API 그룹 (`""`은 core, `"apps"`는 Deployment 등)
- `resources`: 리소스 종류 (`pods`, `pods/log`, `pods/exec` 등 subresource 포함)
- `verbs`: `get`, `list`, `watch`, `create`, `update`, `patch`, `delete`, `deletecollection`
- `resourceNames`: 특정 이름의 리소스만 (예: 특정 Secret만 읽기 허용)
- `nonResourceURLs`: `/healthz` 같은 비-리소스 경로 (드물게 사용)

**Verb 의미**:
- `get`: 단일 조회
- `list`: 목록 조회
- `watch`: 변경 사항 stream (controller 필수)
- `create`: 생성
- `update`: 전체 교체 (PUT)
- `patch`: 부분 수정 (PATCH)
- `delete`: 삭제
- `deletecollection`: 일괄 삭제 (위험)
- `*`: 모든 verb (이 권한 부여는 매우 신중하게)

**Aggregation rule** (고급):
```yaml
aggregationRule:
  clusterRoleSelectors:
  - matchLabels:
      rbac.example.com/aggregate-to-monitoring: "true"
```

**ServiceAccount Token Volume Projection 옵션**:
- `expirationSeconds`: 토큰 만료 (최소 600초, default 1시간)
- `audience`: 토큰의 의도된 audience (Vault 등 외부 시스템 통합 시)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.6+** (RBAC GA 시점). 본 프로젝트는 1.34+
- **Projected SA Token**: Kubernetes 1.21+ default. 더 낮은 버전은 legacy token 사용
- **API Group 변화**: Ingress가 `extensions/v1beta1` → `networking.k8s.io/v1` 이동했듯 새 리소스는 새 API group. Role 정의 시 정확한 그룹 명시 필수
- **Aggregation**: 1.11+ stable
- **TokenRequest API**: 1.22+ stable. Vault 같은 외부 인증 통합 시 필수

## 8. 면접 예상 질문 & 답변

**Q1. RBAC의 deny by default 모델이 뭐고 왜 중요해요?**
> Kubernetes RBAC는 명시적으로 허용된 권한 외에는 모두 거부합니다. RoleBinding이 없으면 ServiceAccount는 아무것도 못 합니다. 이 모델이 중요한 이유는 (1) 권한 누락이 보안 사고가 아니라 단순 동작 실패로 끝나기 때문이고, (2) 명시적 권한 부여를 강제하므로 "이 SA가 왜 이걸 할 수 있지?" 같은 질문에 답하기 쉽기 때문이고, (3) 컴플라이언스 감사 시 권한 목록을 명확하게 보여줄 수 있기 때문입니다.

**Q2. ArgoCD에 어떤 권한을 줘야 하나요?**
> 본 프로젝트는 `app` namespace에 한정한 Role을 만들고, `apps/deployments`, `apps/statefulsets`, `core/services`, `core/configmaps`, `core/pods`, `gateway.networking.k8s.io/httproutes`, `autoscaling/horizontalpodautoscalers`에 대해 `get/list/watch/create/update/patch/delete`를 부여합니다. Secret은 명시적으로 제외해서 외부 secret manager(Vault Agent Injector)를 우회해 직접 Secret을 만드는 패턴을 차단합니다. ArgoCD가 cluster-admin 받는 게 가장 흔한 잘못된 관행입니다.

**Q3. ClusterRole vs Role 차이는요? 언제 어느 걸 써요?**
> Role은 단일 namespace 내에서만 동작하고, ClusterRole은 클러스터 전체 또는 모든 namespace에서 동작 가능합니다. ClusterRole + RoleBinding 조합은 같은 권한 패턴을 여러 namespace에 재사용할 때 유용합니다. ClusterRole + ClusterRoleBinding은 진짜 cluster-wide 권한이 필요할 때만 씁니다(Prometheus의 노드 메트릭 수집, cert-manager의 cluster-wide 인증서 관리 등). 본 프로젝트는 ClusterRoleBinding을 4-5개만 쓰고 나머지는 namespace-scoped Role로 갑니다.

**Q4. Projected SA Token이 뭐고 왜 default가 됐나요?**
> Legacy SA Token은 namespace 생성 시 자동으로 Secret으로 만들어졌고 만료가 없어서 한 번 유출되면 영구적으로 사용 가능했습니다. Projected Token은 Kubernetes 1.21부터 default로, pod 안에 짧은 만료(default 1시간) JWT를 자동 발급하고 만료 전에 갱신합니다. 토큰이 Secret으로 저장되지 않고 pod의 tmpfs에만 마운트되므로 etcd에 영구 저장된 token이 사라집니다. 보안상 훨씬 안전합니다.

**Q5. cluster-admin을 절대 주면 안 되는 SA는 뭐고, 줘야 하는 SA는 뭐예요?**
> 절대 금지: ArgoCD, Jenkins, 모든 일반 앱 SA. 이들이 탈취되면 클러스터 전체가 위험합니다. 줘도 되는 경우: Velero(backup/restore는 cluster-wide 권한 필수), cluster-autoscaler 같은 시스템 컴포넌트. 단 Velero도 정말 cluster-admin이 필요한지 검토하고 가능하면 권한을 좁힙니다. 본 프로젝트는 cluster-admin을 단 하나도 부여하지 않는 것을 목표로 하고, 필요하면 ClusterRole에 명시적 verb를 적습니다.

**Q6. 어떤 SA가 어떤 권한을 가지는지 어떻게 확인하나요?**
> `kubectl auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa> -n <target-ns>` 명령으로 특정 권한 보유 여부를 확인합니다. 전체 권한 목록은 `kubectl auth can-i --list --as=...`로 확인합니다. 또 `kubectl get rolebinding,clusterrolebinding -A -o wide`로 모든 바인딩을 조회하고, `rbac-lookup` 같은 도구로 SA별 권한 매트릭스를 시각화할 수 있습니다. 면접에서 "이걸 어떻게 검증해요?" 물으면 `auth can-i` 명령을 답하면 됩니다.

**Q7. Secret 권한을 따로 분리하는 이유는?**
> 본 프로젝트는 Phase 6에서 모든 시크릿을 Vault Agent Injector를 통해 pod에 주입하는 패턴을 강제합니다. ArgoCD나 Jenkins SA에 Secret create 권한을 주면, 누군가 매니페스트에 평문 Secret을 적어서 GitOps로 배포할 수 있습니다. 이러면 Vault 우회가 발생하고 secret이 etcd에 평문으로 저장됩니다. Secret 권한을 명시적으로 제외해서 시크릿은 반드시 Vault를 거치도록 강제합니다.

**Q8. RBAC 권한 누락으로 발생하는 가장 흔한 에러는?**
> `Forbidden: User "system:serviceaccount:xxx" cannot list resource "yyy" in API group "zzz" in the namespace "www"` 에러입니다. 이게 떠도 컨트롤러가 자체적으로 retry하므로 즉시 장애로 보이지 않고 "왜 동작 안 하지?"로 한참 헤매다 발견되는 경우가 많습니다. controller 로그를 항상 봐야 하고, Prometheus의 `apiserver_request_total{code="403"}` 메트릭을 모니터링해서 403이 급증하면 RBAC 누락을 의심합니다.

**Q9. namespace를 가로지르는 SA 사용은 어떻게 해요?**
> Jenkins SA는 `cicd` namespace에 있지만 `app` namespace에 배포해야 합니다. 이때 (1) Jenkins SA(`cicd` namespace) 생성, (2) `app` namespace에 Role(`app-deployer`) 정의, (3) `app` namespace에 RoleBinding을 만들고 subjects에 `kind: ServiceAccount, name: jenkins, namespace: cicd` 명시. RoleBinding은 자기 namespace의 Role을 자기 namespace에 적용하지만 subject는 다른 namespace의 SA를 참조할 수 있습니다.

**Q10. RBAC가 안 되는 권한은 뭐가 있어요?**
> RBAC는 API 객체 단위 권한만 제어합니다. 다음은 RBAC 범위 밖이라 다른 메커니즘이 필요합니다. (1) 특정 필드 변경 금지(예: replicas만 수정 허용) → Admission Webhook(Kyverno) 필요. (2) 특정 컨테이너 이미지만 허용 → Admission. (3) 네트워크 통신 제어 → NetworkPolicy. (4) Linux capability 제한 → PSA 또는 PodSecurityContext. RBAC는 "누가 무엇을 할 수 있나"를 정하고, 나머지는 보완 정책으로 처리합니다.
