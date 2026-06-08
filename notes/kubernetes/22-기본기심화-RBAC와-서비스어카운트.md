# RBAC와 서비스어카운트 (RBAC & ServiceAccount)

> 쿠버네티스 · 기본기 심화 · 학습내용: 인증(authn)→인가(authz) 흐름, Role/ClusterRole, RoleBinding/ClusterRoleBinding 범위, 동사·리소스·resourceNames, ServiceAccount와 파드 연결, projected ServiceAccount 토큰, automountServiceAccountToken, 최소 권한 패턴, kubectl auth can-i

---

이 문서는 "누가 무엇을 할 수 있는가"를 다룬다. apiserver에 도달한 요청이 거부되거나 허용되는 전 과정과, 파드가 API를 호출할 때 쓰는 신원(ServiceAccount)을 한 편에 정리한다.

## 1. 인증(Authentication) → 인가(Authorization) → 어드미션 흐름

kube-apiserver는 모든 요청을 **세 관문**에 순서대로 통과시킨다.

```
요청 ──▶ ① 인증(Authentication)  : "너 누구야?"   → 신원(user/group/SA) 확정
       ──▶ ② 인가(Authorization)  : "그거 해도 돼?" → RBAC 등으로 허용/거부
       ──▶ ③ 어드미션(Admission)  : "내용 검사/변형" → 정책 위반이면 차단
       ──▶ etcd에 반영
```

| 단계 | 질문 | 대표 메커니즘 |
|------|------|--------------|
| **Authentication** | 너는 **누구**인가 | 클라이언트 인증서, Bearer 토큰(ServiceAccount 토큰), OIDC |
| **Authorization** | 그 행동이 **허용**되나 | **RBAC**, ABAC, Node, Webhook |
| **Admission Control** | 내용이 **정책에 맞나** | ValidatingAdmissionPolicy, 웹훅, ResourceQuota 등 |

핵심 구분:
- **인증은 "신원 확인"** 만 한다. 쿠버네티스에는 "User" 라는 오브젝트가 따로 없다. 인증서/토큰에서 추출한 username과 group 문자열이 곧 신원이다.
- **인가는 "권한 판단"** 이다. 가장 널리 쓰는 방식이 **RBAC(Role-Based Access Control)** 다.
- 여러 인가 모듈 중 **하나라도 허용하면 허용**, 모두 침묵하면 거부(deny)다.

> ★★★ **면접 단골**: "apiserver는 ① 인증으로 신원을 확정하고 ② 인가(RBAC)로 그 신원이 해당 동작을 할 수 있는지 판단한 뒤 ③ 어드미션으로 내용을 검사·변형한다. 인증은 '누구냐', 인가는 '돼도 되냐'로 역할이 다르다."

## 2. Role과 ClusterRole — "무엇을 할 수 있는가"

**Role/ClusterRole** 은 권한의 묶음(규칙 집합)이다. 그 자체로는 누구에게도 적용되지 않고, 바인딩으로 주체에 연결해야 효력이 생긴다.

| 종류 | 적용 범위 | 쓰임 |
|------|----------|------|
| **Role** | **특정 네임스페이스 내부** | 그 네임스페이스의 리소스 권한 |
| **ClusterRole** | **클러스터 전역 + 비네임스페이스 리소스** | 노드/PV 같은 전역 리소스, 또는 여러 NS에서 재사용할 공통 권한 |

ClusterRole만 다룰 수 있는 것: 노드, PersistentVolume, 네임스페이스 자체 같은 **클러스터 스코프 리소스**와, `/healthz` 같은 **non-resource URL**.

```yaml
# 네임스페이스 ggang-app 안에서 파드를 읽기만 가능
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: ggang-app
  name: pod-reader
rules:
  - apiGroups: [""]               # "" = core 그룹(pod, service, configmap 등)
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
```

## 3. 규칙의 3요소: 동사(verbs) · 리소스(resources) · resourceNames

`rules`의 한 항목은 "어떤 API 그룹의, 어떤 리소스에, 어떤 동작을 허용한다"를 정의한다.

- **apiGroups**: `""`(core), `"apps"`(Deployment/StatefulSet 등), `"networking.k8s.io"`, `"rbac.authorization.k8s.io"` 등.
- **resources**: `pods`, `deployments`, `services`, `secrets` … 서브리소스는 슬래시로(`pods/log`, `pods/exec`, `deployments/scale`).
- **verbs**: 동작.

| verb | 의미 |
|------|------|
| `get` / `list` / `watch` | 단건 조회 / 목록 / 변경 스트림 구독 |
| `create` / `update` / `patch` | 생성 / 전체 교체 / 부분 수정 |
| `delete` / `deletecollection` | 삭제 / 일괄 삭제 |

- **resourceNames**: 권한을 **특정 이름의 오브젝트로만** 좁힌다. 단, `list`/`create`/`deletecollection`처럼 이름이 요청에 없는 동작에는 적용되지 않으니 주의한다. ★

```yaml
# my-secret 이라는 이름의 Secret 하나만 읽기 허용
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["my-secret"]
    verbs: ["get"]
```

> ★ RBAC는 **가산(additive)** 모델이다. "deny 규칙"이 없다. 명시적으로 허용된 것만 가능하고, 나머지는 전부 거부. 그래서 권한을 넓게 줬다가 빼는 게 아니라, 처음부터 좁게 주고 필요한 것만 더한다(최소 권한).

## 4. RoleBinding과 ClusterRoleBinding — "누구에게 줄 것인가"

바인딩은 **주체(subject) ↔ 역할(role)** 을 잇는다. 주체는 `User`, `Group`, `ServiceAccount` 중 하나다.

### 범위 조합표 (가장 헷갈리는 부분)

| 바인딩 | 참조하는 역할 | 권한이 미치는 범위 |
|--------|--------------|-------------------|
| **RoleBinding** + Role | 같은 NS의 Role | **그 네임스페이스만** |
| **RoleBinding** + ClusterRole | ClusterRole | **그 네임스페이스만** (ClusterRole을 NS 한정으로 재사용) |
| **ClusterRoleBinding** + ClusterRole | ClusterRole | **클러스터 전역(모든 NS)** |

핵심 트릭: **RoleBinding이 ClusterRole을 참조**하면, ClusterRole에 정의된 권한이 **그 RoleBinding이 있는 네임스페이스 안에서만** 발동한다. 공통 권한(예: "view")을 ClusterRole로 한 번 정의하고, 네임스페이스마다 RoleBinding으로 갖다 쓰는 게 정석 패턴이다.

```yaml
# pod-reader Role을 ggang-app 네임스페이스의 SA에게 부여
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: ggang-app
subjects:
  - kind: ServiceAccount
    name: app-sa
    namespace: ggang-app
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

> ★★★ **면접 단골 함정**: "ClusterRoleBinding은 항상 전역"이지만, "RoleBinding이 ClusterRole을 참조하면 그 NS로 한정"된다. ClusterRole이라고 다 전역 권한이 되는 게 아니다. **범위를 결정하는 건 '바인딩의 종류'** 다.

## 5. ServiceAccount와 파드 연결

**ServiceAccount(SA)** 는 **파드(워크로드)가 apiserver를 호출할 때 쓰는 신원**이다. 사람 사용자(User)와 구분되는, 파드용 계정이다.

- 모든 네임스페이스에는 `default`라는 SA가 자동 생성된다. 파드에 SA를 지정하지 않으면 이 `default` SA가 붙는다.
- 파드는 `.spec.serviceAccountName`으로 SA를 지정한다.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
  namespace: ggang-app
---
apiVersion: v1
kind: Pod
metadata:
  name: app
  namespace: ggang-app
spec:
  serviceAccountName: app-sa     # 이 파드의 신원
  containers:
    - name: app
      image: app:1.0
```

- SA가 어떤 권한을 갖는지는 SA 자체가 아니라 **RoleBinding/ClusterRoleBinding으로 어떤 Role에 묶였는가** 로 정해진다. SA를 만들기만 하면 사실상 권한이 없다(default deny).

## 6. Projected ServiceAccount 토큰 (1.24+)

파드가 SA로 인증하려면 **토큰(JWT)** 이 필요하다. 토큰 발급 방식은 1.24 부근에서 크게 바뀌었다.

| 구분 | 과거(레거시) | 현재(권장) |
|------|------------|-----------|
| 토큰 형태 | SA마다 **자동 생성된 Secret**에 영구 토큰 | **projected volume**으로 주입되는 단기 토큰 |
| 만료 | 만료 없음(탈취 시 영구 유효) | **만료(expiration) 있음**, kubelet이 자동 갱신 |
| 대상(audience) | 범용 | **특정 audience** 지정 가능 |
| Secret 자동 생성 | 됨 | **1.24부터 자동 생성 안 함** |

- **BoundServiceAccountTokenVolume**: kubelet이 `TokenRequest` API로 **수명이 짧고, 특정 파드/audience에 바인딩된** 토큰을 발급해 파드의 `/var/run/secrets/kubernetes.io/serviceaccount/token`에 projected volume으로 넣어준다. 파드가 사라지면 토큰도 무효화된다. 보안상 레거시 영구 토큰보다 훨씬 낫다. ★
- 외부 시스템 연동 등으로 **장기 토큰이 꼭 필요하면**, `kubernetes.io/service-account-token` 타입 Secret을 직접 만들어 발급할 수 있다(권장되진 않음). 짧게 쓸 토큰은 `kubectl create token <sa>`로 즉석 발급한다.

```yaml
# 커스텀 audience/만료를 가진 projected SA 토큰 마운트
spec:
  serviceAccountName: app-sa
  containers:
    - name: app
      image: app:1.0
      volumeMounts:
        - name: token
          mountPath: /var/run/secrets/tokens
  volumes:
    - name: token
      projected:
        sources:
          - serviceAccountToken:
              path: token
              audience: vault            # 이 토큰을 받을 대상 명시
              expirationSeconds: 3600    # 1시간 후 만료(자동 갱신)
```

## 7. automountServiceAccountToken — 토큰 자동 주입 끄기

기본적으로 파드에는 SA 토큰이 자동 마운트된다. 그런데 **apiserver를 호출하지 않는 파드**(대부분의 일반 앱)에는 토큰이 필요 없다. 토큰이 있으면 컨테이너가 탈취당했을 때 공격자가 그 토큰으로 API를 찌르므로, **필요 없으면 끄는 게 보안 모범 사례**다.

```yaml
# SA 자체에 끄기 — 이 SA를 쓰는 파드 전부 적용
apiVersion: v1
kind: ServiceAccount
metadata:
  name: app-sa
automountServiceAccountToken: false
---
# 또는 파드 단위로 끄기 (파드 설정이 우선)
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: app-sa
  automountServiceAccountToken: false
```

> ★ **면접 포인트**: "API를 안 쓰는 워크로드는 `automountServiceAccountToken: false`로 토큰 주입을 꺼라. 토큰은 곧 클러스터 자격증명이라, 마운트된 토큰은 컨테이너 탈취 시 공격 표면이 된다."

## 8. 최소 권한(Least Privilege) 패턴

- **default SA에 권한 주지 않기**: `default` SA에 ClusterRoleBinding을 거는 순간 그 NS의 모든 무지정 파드가 권한을 갖는다. 워크로드마다 **전용 SA**를 만들어 딱 필요한 권한만 부여한다.
- **ClusterRoleBinding 남용 금지**: 가능한 한 RoleBinding(NS 한정)으로 좁힌다. 전역 권한은 정말 전역 리소스가 필요할 때만.
- **`cluster-admin` 금지**: 운영 워크로드에 절대 붙이지 않는다. wildcard(`verbs: ["*"]`, `resources: ["*"]`)도 피한다.
- **secrets 접근 분리**: Secret read 권한은 별도 Role로 분리해 꼭 필요한 SA에만.
- **토큰 마운트 끄기**: 위 7절.

```yaml
# 전형적 최소 권한 세트: 전용 SA + NS 한정 Role + RoleBinding
apiVersion: v1
kind: ServiceAccount
metadata: { name: config-watcher, namespace: ggang-app }
automountServiceAccountToken: true
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: cm-reader, namespace: ggang-app }
rules:
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: cm-reader-bind, namespace: ggang-app }
subjects:
  - kind: ServiceAccount
    name: config-watcher
    namespace: ggang-app
roleRef:
  kind: Role
  name: cm-reader
  apiGroup: rbac.authorization.k8s.io
```

## 9. 검증: kubectl auth can-i

권한을 제대로 줬는지, 잘 막혔는지를 **실제 인가 결과**로 확인하는 명령이다. RBAC 디버깅의 핵심 도구다.

```bash
# 내가 ggang-app NS에서 pod를 만들 수 있나?
kubectl auth can-i create pods -n ggang-app

# 특정 ServiceAccount의 권한을 흉내내 확인(impersonate)
kubectl auth can-i get secrets \
  --as=system:serviceaccount:ggang-app:app-sa -n ggang-app

# 내가 할 수 있는 모든 동작 나열
kubectl auth can-i --list -n ggang-app
```

- `--as`로 특정 사용자/SA를 **사칭(impersonate)** 해서 "이 SA가 이거 되나?"를 확인한다(사칭 권한 필요). 배포 전 권한 검증에 매우 유용하다. ★
- 출력은 `yes` / `no`로 단순명료하다.

> ★★★ **면접 단골**: "RBAC가 의심되면 `kubectl auth can-i <verb> <resource> --as=system:serviceaccount:<ns>:<sa>`로 해당 SA의 인가 결과를 직접 확인한다. 추측하지 말고 apiserver의 판단을 물어본다."

### 한 줄 요약
apiserver는 **인증(누구냐) → 인가(돼도 되냐) → 어드미션(내용 검사)** 순으로 요청을 처리한다. 인가의 핵심 **RBAC**는 **Role/ClusterRole(권한 묶음)** 을 **RoleBinding/ClusterRoleBinding(주체 연결)** 으로 적용하며, 범위는 바인딩 종류가 결정한다. 파드의 신원은 **ServiceAccount**이고, 1.24+는 만료·audience를 가진 **projected 단기 토큰**을 쓰며, 불필요하면 **automountServiceAccountToken: false**로 끈다. 권한은 전용 SA + 최소 권한으로 주고 **kubectl auth can-i**로 검증한다.

### 참고 (공식 문서)
- RBAC 권한 부여: https://kubernetes.io/docs/reference/access-authn-authz/rbac/
- 인증(Authentication): https://kubernetes.io/docs/reference/access-authn-authz/authentication/
- 인가 개요: https://kubernetes.io/docs/reference/access-authn-authz/authorization/
- ServiceAccount 관리: https://kubernetes.io/docs/concepts/security/service-accounts/
- 파드에 ServiceAccount 설정: https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/
- ServiceAccount 토큰: https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/
