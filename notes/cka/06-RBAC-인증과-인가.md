# 06. RBAC — 인증과 인가

> 도메인: 클러스터 아키텍처, 설치 및 구성 (25%)
> 시험 포인트: Role/RoleBinding 생성, ServiceAccount 권한 부여, CSR로 사용자 인증서 발급이 단골. **명령형(create role/rolebinding)으로 푸는 게 압도적으로 빠르다.**

---

## 1. 요청 처리 3단계

```
요청 → ① 인증(Authentication) → ② 인가(Authorization) → ③ 어드미션(Admission) → etcd
```

- **인증**: 너 누구야? — X.509 클라이언트 인증서, ServiceAccount 토큰, OIDC 등
- **인가**: 그거 해도 돼? — **RBAC**(표준), Node, Webhook, ABAC
- **어드미션**: 정책 검사/변형 — LimitRange, ResourceQuota, PodSecurity 등

> 쿠버네티스에는 **User라는 API 객체가 없다.** 사용자는 인증서의 CN(Common Name)이나 외부 시스템으로 표현될 뿐이다. 그룹은 인증서의 O(Organization).

## 2. RBAC 4가지 객체

| 객체 | 범위 | 역할 |
|---|---|---|
| **Role** | 네임스페이스 | 권한 정의 (무엇을 할 수 있나) |
| **ClusterRole** | 클러스터 전체 | 권한 정의 (+ 노드/PV 같은 클러스터 리소스, 모든 네임스페이스) |
| **RoleBinding** | 네임스페이스 | Role(또는 ClusterRole)을 주체에게 연결 |
| **ClusterRoleBinding** | 클러스터 전체 | ClusterRole을 주체에게 연결 |

- 주체(subject): **User**, **Group**, **ServiceAccount**
- RBAC은 **허용만** 정의한다 (deny 규칙 없음. 기본이 전부 거부).
- **ClusterRole + RoleBinding** 조합: 공통 권한 정의를 네임스페이스 단위로 제한해 부여 (자주 쓰는 패턴).

## 3. Role / RoleBinding 작성

### 명령형 (시험 권장)
```bash
kubectl create role pod-reader \
  --verb=get,list,watch --resource=pods -n dev

kubectl create rolebinding pod-reader-binding \
  --role=pod-reader --user=jane -n dev

# ServiceAccount에 바인딩할 때
kubectl create rolebinding sa-binding \
  --role=pod-reader --serviceaccount=dev:mysa -n dev

# ClusterRole / ClusterRoleBinding
kubectl create clusterrole node-reader --verb=get,list --resource=nodes
kubectl create clusterrolebinding node-reader-binding \
  --clusterrole=node-reader --user=jane

# 하위 리소스 (예: pod/log)
kubectl create role log-reader --verb=get --resource=pods/log -n dev
```

### YAML
```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: dev
rules:
- apiGroups: [""]              # "" = core 그룹 (pods, services, configmaps...)
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]          # deployments, daemonsets...
  resources: ["deployments"]
  verbs: ["create", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader-binding
  namespace: dev
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: mysa
  namespace: dev               # SA는 namespace 명시, apiGroup은 ""(생략)
roleRef:                       # roleRef는 불변 — 바꾸려면 바인딩 재생성
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

- 리소스가 어느 apiGroup인지 모르면: `kubectl api-resources | grep <리소스>`
- verbs 종류: `get, list, watch, create, update, patch, delete, deletecollection`, 전부는 `*`

## 4. 권한 확인 — auth can-i

```bash
kubectl auth can-i create pods                        # 내 권한
kubectl auth can-i list secrets -n dev --as jane      # jane으로 가장(impersonate)
kubectl auth can-i delete nodes --as system:serviceaccount:dev:mysa
kubectl auth can-i --list --as jane -n dev            # jane의 전체 권한 목록
```

> 시험에서 Role을 만들었으면 `--as`로 반드시 검증할 것.

## 5. ServiceAccount

Pod 안의 프로세스가 apiserver에 접근할 때 쓰는 신원.

```bash
kubectl create serviceaccount mysa -n dev
kubectl get sa -n dev
```

Pod에 지정:
```yaml
spec:
  serviceAccountName: mysa
  automountServiceAccountToken: false   # 토큰 자동 마운트 끄기 (보안 강화 시)
```

- 지정 안 하면 네임스페이스의 `default` SA 사용.
- 1.24+부터 SA를 만들어도 **토큰 Secret이 자동 생성되지 않음**. 단기 토큰이 필요하면:
  ```bash
  kubectl create token mysa -n dev          # TokenRequest API로 단기 토큰 발급
  ```
- SA 주체 표기: `system:serviceaccount:<namespace>:<name>`

## 6. 사용자 인증서 발급 (CSR 흐름) — 빈출

새 사용자 "jane"에게 클러스터 접근 권한을 주는 전체 절차:

```bash
# 1) 키와 CSR 생성
openssl genrsa -out jane.key 2048
openssl req -new -key jane.key -subj "/CN=jane/O=dev-team" -out jane.csr

# 2) CSR을 base64로 (줄바꿈 제거)
cat jane.csr | base64 | tr -d "\n"
```

```yaml
# 3) CertificateSigningRequest 객체 생성
apiVersion: certificates.k8s.io/v1
kind: CertificateSigningRequest
metadata:
  name: jane
spec:
  request: <base64 인코딩한 CSR>
  signerName: kubernetes.io/kube-apiserver-client   # 사용자 인증서용 서명자
  expirationSeconds: 86400                          # 선택 (1일)
  usages:
  - client auth
```

```bash
kubectl apply -f csr.yaml

# 4) 승인 및 인증서 추출
kubectl get csr
kubectl certificate approve jane
kubectl get csr jane -o jsonpath='{.status.certificate}' | base64 -d > jane.crt

# 5) kubeconfig에 등록
kubectl config set-credentials jane --client-key=jane.key --client-certificate=jane.crt --embed-certs
kubectl config set-context jane --cluster=kubernetes --user=jane
kubectl config use-context jane
```

- 이후 RBAC으로 권한 부여 (위 3절).
- `kubectl certificate deny <name>`으로 거부도 가능.
- YAML 템플릿은 문서에서 "CertificateSigningRequest" 검색.

## 7. 기본 제공 ClusterRole

| 이름 | 권한 |
|---|---|
| `cluster-admin` | 모든 것 (superuser) |
| `admin` | 네임스페이스 내 대부분 (RoleBinding으로 사용) |
| `edit` | 네임스페이스 내 읽기/쓰기 (RBAC 조회 불가) |
| `view` | 네임스페이스 내 읽기 전용 (Secret 제외) |

```bash
kubectl create rolebinding dev-admin --clusterrole=admin --user=jane -n dev
```

## 8. 트러블슈팅 관점

```bash
kubectl describe role,rolebinding -n dev        # 권한 정의/바인딩 확인
kubectl get clusterrolebindings -o wide | grep jane
# "Forbidden" 에러 = 인가 실패 → Role의 verbs/resources/apiGroups, 바인딩의 주체 철자 확인
# "Unauthorized" 에러 = 인증 실패 → 인증서/토큰 문제
```

## 9. 체크리스트

- [ ] Role/ClusterRole/RoleBinding/ClusterRoleBinding 조합 4가지를 구분한다
- [ ] `kubectl create role/rolebinding` 명령형으로 1분 내 권한을 부여할 수 있다
- [ ] `kubectl auth can-i ... --as`로 검증하는 습관이 있다
- [ ] CSR 발급 → approve → 인증서 추출 → kubeconfig 등록 흐름을 안다
- [ ] SA 주체 표기 `system:serviceaccount:ns:name`을 외웠다
- [ ] core 리소스는 apiGroups가 `""` 임을 안다
