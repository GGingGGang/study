# 실전 kubectl 치트시트 (kubectl Cheat Sheet)

> 쿠버네티스 · 실전·취준 · 학습내용: 현업·면접에서 손이 먼저 나가야 하는 kubectl 명령을 표로 정리 — 조회(get/describe/-o wide·yaml), 디버깅(logs/exec/debug/events/top), 롤아웃(rollout/scale/set image), 적용·삭제(apply/delete/diff), port-forward, 컨텍스트·네임스페이스, 출력 가공(jsonpath/custom-columns/sort-by), explain, label/annotate, dry-run, 별칭·watch 같은 실전 팁

---

## 1. 가장 먼저 깔고 가는 설정 ★★★

면접에서 "평소 어떻게 쓰냐"는 질문에 답이 되고, 실무 속도를 결정한다.

```bash
# 1) 별칭 (~/.bashrc, ~/.zshrc)
alias k=kubectl

# 2) 자동완성 + 별칭에도 자동완성 적용
source <(kubectl completion bash)        # zsh면 completion zsh
complete -o default -F __start_kubectl k

# 3) 현재 컨텍스트/네임스페이스를 프롬프트에 표시하고 싶으면 kube-ps1 같은 도구
```

**`kubectl`은 `~/.kube/config`의 `current-context`가 가리키는 클러스터에 명령을 보낸다.** 사고의 90%는 "엉뚱한 클러스터/네임스페이스에 명령을 날린 것"이다. 무언가 하기 전에 **"내가 어디에 떠 있는지"부터 확인**하는 습관(아래 6번)이 가장 중요하다.

---

## 2. 조회 (get / describe) ★★★

| 목적 | 명령 |
|------|------|
| 파드 목록 | `k get pods` |
| 노드 IP·이미지 등 추가 정보 | `k get pods -o wide` |
| 전체 네임스페이스 | `k get pods -A` (= `--all-namespaces`) |
| 특정 네임스페이스 | `k get pods -n istio-system` |
| 여러 리소스 한 번에 | `k get deploy,svc,pod -n app` |
| 전체 매니페스트 보기 | `k get pod <이름> -o yaml` |
| JSON | `k get pod <이름> -o json` |
| 라벨 컬럼까지 | `k get pods --show-labels` |
| 라벨 셀렉터로 필터 | `k get pods -l app=web,tier=frontend` |
| 상세·이벤트·조건 한 번에 | `k describe pod <이름>` |
| 실시간 갱신 | `k get pods -w` (= `--watch`) |
| 모든 API 리소스 종류 | `k api-resources` |
| 이 클러스터의 CRD 종류 확인 | `k api-resources \| grep -i gateway` |

**`describe`는 디버깅의 출발점**이다. 맨 아래 `Events:` 섹션에 스케줄 실패·이미지 풀 실패·프로브 실패 같은 원인이 사람이 읽을 수 있는 문장으로 찍힌다. **`get -o yaml`은 "실제 적용된 최종 상태"** (디폴트 값·컨트롤러가 채운 필드 포함)를 본다.

```bash
# 자주 쓰는 조합: 죽은/이상한 파드만 빠르게
k get pods -A | grep -vE 'Running|Completed'
```

---

## 3. 디버깅 (logs / exec / debug / events / top) ★★★

| 목적 | 명령 |
|------|------|
| 로그 보기 | `k logs <pod>` |
| 실시간 추적 | `k logs -f <pod>` |
| **재시작 직전(죽은) 컨테이너 로그** | `k logs --previous <pod>` (= `-p`) |
| 멀티 컨테이너 중 특정 컨테이너 | `k logs <pod> -c <container>` |
| 사이드카 포함 전부 | `k logs <pod> --all-containers` |
| 최근 N줄 / 최근 시간 | `k logs <pod> --tail=100 --since=10m` |
| 셸 접속 | `k exec -it <pod> -- sh` (or `bash`) |
| 단발 명령 | `k exec <pod> -- env` |
| 이벤트 시간순 정렬 | `k get events --sort-by=.lastTimestamp -A` |
| 특정 객체 이벤트만 | `k events --for pod/<pod>` |
| 파드 리소스 사용량 | `k top pod -A` (metrics-server 필요) |
| 노드 리소스 사용량 | `k top node` |

**`--previous`는 CrashLoopBackOff의 핵심 무기**다. 컨테이너가 계속 죽으면 현재 로그는 비어 있고, **직전에 죽은 인스턴스의 로그에 진짜 에러**가 있다.

**`kubectl debug`는 distroless·셸 없는 이미지나 노드 자체를 디버깅**할 때 쓴다.

```bash
# 실행 중인 파드에 임시 디버그 컨테이너(ephemeral container) 붙이기
k debug -it <pod> --image=busybox --target=<container>

# 기존 파드를 복제해 커맨드만 바꿔 띄우기 (원본 안 건드림)
k debug <pod> -it --copy-to=debug-pod --container=app -- sh

# 노드에 셸 (호스트 파일시스템은 /host)
k debug node/<node> -it --image=busybox
```

---

## 4. 롤아웃 / 스케일 (rollout / scale / set image) ★★★

| 목적 | 명령 |
|------|------|
| 배포 진행 상황 확인 | `k rollout status deploy/<name>` |
| 롤아웃 이력 | `k rollout history deploy/<name>` |
| **직전 버전으로 롤백** | `k rollout undo deploy/<name>` |
| 특정 리비전으로 롤백 | `k rollout undo deploy/<name> --to-revision=3` |
| **파드 새로 굴리기(재시작)** | `k rollout restart deploy/<name>` |
| 일시정지 / 재개 | `k rollout pause` / `k rollout resume deploy/<name>` |
| 레플리카 수 변경 | `k scale deploy/<name> --replicas=5` |
| 이미지 교체 | `k set image deploy/<name> app=ghcr.io/ggang/app:v2` |
| 조건부 스케일 | `k scale deploy/<name> --current-replicas=3 --replicas=5` |

**`rollout restart`는 매니페스트 변경 없이 파드를 새로 생성**한다(템플릿 어노테이션에 타임스탬프를 박는 방식). ConfigMap/Secret을 바꿨는데 파드가 안 읽을 때, 캐시·커넥션을 갈아끼울 때 쓴다.

**`set image`로 배포하는 건 GitOps와 충돌**한다. ArgoCD가 Git을 진실로 보고 있으면 수동 `set image`는 곧 OutOfSync로 잡혀 되돌려진다. 실무에선 **Git 매니페스트의 태그를 바꾸고 ArgoCD가 동기화**하게 한다. `set image`는 응급·실험용으로만.

---

## 5. 적용 / 삭제 / 차이 (apply / delete / diff) ★★★

| 목적 | 명령 |
|------|------|
| 적용(선언형) | `k apply -f manifest.yaml` |
| 디렉터리 전체 | `k apply -f ./manifests/` |
| 재귀 | `k apply -R -f ./manifests/` |
| URL에서 | `k apply -f https://.../install.yaml` |
| **적용 전 변경분 미리보기** | `k diff -f manifest.yaml` |
| 삭제 | `k delete -f manifest.yaml` |
| 이름으로 삭제 | `k delete pod <name>` |
| 라벨로 일괄 삭제 | `k delete pod -l app=web` |
| 강제 즉시 삭제(주의) | `k delete pod <name> --force --grace-period=0` |
| 부분 패치(merge) | `k patch deploy/<name> -p '{"spec":{"replicas":4}}'` |
| 즉석 편집 | `k edit deploy/<name>` |

**`apply`는 선언형**이라 같은 파일을 여러 번 적용해도 멱등하다(내부적으로 server-side apply / last-applied 비교). 반면 `create`는 명령형이라 이미 있으면 에러난다. **실무는 거의 항상 `apply`.**

**파드가 `Terminating`에서 안 빠질 때는 대개 finalizer 때문**이다. `--force`보다 finalizer 원인을 보는 게 정석이지만, 응급 시:

```bash
k get pod <name> -o yaml | grep -A3 finalizers
# 최후의 수단
k patch pod <name> -p '{"metadata":{"finalizers":null}}'
```

---

## 6. 컨텍스트 / 네임스페이스 (use-context, -n, -A) ★★★

| 목적 | 명령 |
|------|------|
| 컨텍스트 목록 | `k config get-contexts` |
| 현재 컨텍스트 | `k config current-context` |
| 컨텍스트 전환 | `k config use-context <name>` |
| **기본 네임스페이스 고정** | `k config set-context --current --namespace=app` |
| 클러스터 정보 | `k cluster-info` |
| 단발 네임스페이스 지정 | `-n <ns>` |
| 전체 네임스페이스 | `-A` |

OKE 같은 매니지드 클러스터를 여러 개 쓰면 컨텍스트가 늘어난다. **`kubens`/`kubectx`(또는 위 `set-context --current --namespace`)로 기본 네임스페이스를 고정**해두면 `-n`을 매번 안 쳐도 된다. **운영 클러스터에 실수로 명령을 날리는 사고는 거의 다 컨텍스트 확인 누락**이다.

---

## 7. 출력 가공 (jsonpath / custom-columns / sort-by) ★★

스크립트·디버깅에서 필요한 값만 뽑을 때. 면접에서 "이미지 태그만 한 번에 뽑으려면?" 같은 응용 질문이 나온다.

```bash
# 특정 필드만: 모든 파드의 노드명
k get pods -o jsonpath='{.items[*].spec.nodeName}'

# 컨테이너 이미지 목록 (한 줄씩)
k get pods -A -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.containers[*].image}{"\n"}{end}'

# 커스텀 컬럼: 이름 + 상태 + 노드
k get pods -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,NODE:.spec.nodeName'

# 정렬: 재시작 횟수 많은 순 / 생성 시각순
k get pods --sort-by='.status.containerStatuses[0].restartCount'
k get pods --sort-by=.metadata.creationTimestamp

# 시크릿 값 디코드 (base64)
k get secret <name> -o jsonpath='{.data.password}' | base64 -d
```

| 옵션 | 용도 |
|------|------|
| `-o jsonpath=...` | 정밀하게 필드 추출, 스크립트용 |
| `-o custom-columns=...` | 표 형태로 보기 좋게 |
| `--sort-by=<jsonpath>` | 정렬 (restart 횟수·시각 등) |
| `-o name` | `pod/xxx` 형태 이름만 (파이프용) |
| `--no-headers` | 헤더 제거 (스크립트용) |

---

## 8. explain / 스키마 탐색 ★★

**필드 이름·구조가 기억 안 날 때 구글 대신 `explain`.** 클러스터에 설치된 실제 API 버전 기준이라 정확하다.

```bash
k explain pod.spec.containers.resources
k explain deploy.spec.strategy --recursive   # 하위 필드 전부 트리로
k explain gateway.spec --api-version=gateway.networking.k8s.io/v1
```

---

## 9. label / annotate ★

```bash
k label pod <name> env=prod              # 추가
k label pod <name> env=stage --overwrite # 변경
k label pod <name> env-                  # 삭제(키 뒤에 -)
k annotate ingress <name> kubernetes.io/ingress.class=nginx
```

**라벨(label)은 셀렉터로 그룹핑·선택**하는 데(Service가 파드를 고르는 기준 등) 쓰고, **어노테이션(annotation)은 컨트롤러 설정·메타데이터**(cert-manager·external-dns 지시 등)를 담는다. 셀렉터에 쓸 수 있는 건 라벨뿐이다.

---

## 10. dry-run / 매니페스트 생성 ★★★

**YAML을 맨손으로 안 짜고 골격을 뽑는 가장 빠른 방법.** 면접에서도 "파드 YAML 손으로 다 외우냐"에 대한 정답이다.

```bash
# 서버에 적용하지 않고 검증만 (실제 API 검증까지)
k apply -f manifest.yaml --dry-run=server

# Deployment YAML 골격 생성
k create deploy web --image=ghcr.io/ggang/web:v1 \
  --dry-run=client -o yaml > deploy.yaml

# Service / ConfigMap / Secret 골격
k create svc clusterip web --tcp=80:8080 --dry-run=client -o yaml
k create configmap app-cfg --from-literal=KEY=val --dry-run=client -o yaml
k create secret generic db --from-literal=pass=1234 --dry-run=client -o yaml
```

| 모드 | 의미 |
|------|------|
| `--dry-run=client` | 로컬에서 객체만 만들어 출력(서버 미접촉). YAML 생성용 |
| `--dry-run=server` | API 서버가 실제 검증(어드미션 웹훅 포함)하되 저장 안 함 |

---

## 11. port-forward / cp / 접근 ★★

```bash
# 로컬 8080 → 파드 80 (Service에도 가능)
k port-forward pod/<name> 8080:80
k port-forward svc/argocd-server -n argocd 8080:443

# 파일 복사
k cp <pod>:/var/log/app.log ./app.log
k cp ./config.yaml <pod>:/etc/app/config.yaml

# 임시 디버그 파드 띄워서 클러스터 내부에서 curl/DNS 테스트
k run tmp --rm -it --image=nicolaka/netshoot -- bash
```

**`port-forward`는 Ingress/Gateway·LB 없이 클러스터 내부 서비스(ArgoCD·Grafana·Kiali 등 대시보드)에 직접 붙을 때** 1순위로 쓴다. 외부에 노출하지 않고 본인만 접근하므로 디버깅·관리용으로 안전하다.

---

## 12. 권한·진단 부가 명령 ★

```bash
# 내가 이 동작을 할 권한이 있나? (RBAC 디버깅)
k auth can-i create deployments -n app
k auth can-i '*' '*' --all-namespaces        # 클러스터 관리자인가
k auth can-i list pods --as=system:serviceaccount:app:builder  # SA 흉내

# 노드 비우기(점검/교체 시)
k drain <node> --ignore-daemonsets --delete-emptydir-data
k uncordon <node>   # 다시 스케줄 허용
```

---

## 13. 현장에서 진짜 자주 쓰는 한 줄 ★★★

```bash
# 죽지 않는 무한 디버그 파드
k run debug --image=nicolaka/netshoot -- sleep infinity

# Deployment 이름으로 로그 한 번에 (셀렉터로 파드 자동 선택)
k logs -f deploy/<name>

# 재시작 횟수 Top 보기
k get pods -A --sort-by='.status.containerStatuses[0].restartCount' | tail

# 특정 노드에 떠 있는 파드만
k get pods -A -o wide --field-selector spec.nodeName=<node>

# 컨테이너 이미지 한눈에
k get pods -A -o custom-columns='NS:.metadata.namespace,POD:.metadata.name,IMAGE:.spec.containers[*].image'
```

---

### 한 줄 요약
kubectl 실력은 **`describe`로 이벤트를 읽고, `logs -f --previous`로 죽은 컨테이너를 추적하고, `rollout undo`로 되돌리고, `jsonpath`로 원하는 값만 뽑는** 손에서 나온다. 무엇보다 **명령 전에 컨텍스트·네임스페이스를 확인**하는 습관이 사고를 막고, **`--dry-run=client -o yaml`로 골격을 뽑는** 게 YAML 작성의 정석이다.

### 참고 (공식 문서)
- kubectl Cheat Sheet — https://kubernetes.io/docs/reference/kubectl/cheatsheet/
- kubectl Quick Reference / Commands — https://kubernetes.io/docs/reference/kubectl/
- Debug Running Pods (logs/exec/debug) — https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/
- JSONPath Support — https://kubernetes.io/docs/reference/kubectl/jsonpath/
- Managing kubeconfig / contexts — https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/
- kubectl rollout reference — https://kubernetes.io/docs/reference/generated/kubectl/kubectl-commands#rollout
