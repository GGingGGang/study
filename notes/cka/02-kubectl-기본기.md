# 02. kubectl 기본기

> 도메인: 전 영역 공통
> 시험 포인트: CKA는 속도 싸움이다. `--dry-run=client -o yaml`과 명령형(imperative) 명령을 몸에 익히는 것이 합격의 절반.

---

## 1. kubeconfig와 컨텍스트

kubectl은 `~/.kube/config`(또는 `KUBECONFIG` 환경변수, `--kubeconfig` 플래그)를 읽는다.

```yaml
# kubeconfig 구조
clusters:    # 접속할 클러스터 (server URL + CA)
users:       # 인증 정보 (인증서, 토큰)
contexts:    # cluster + user + (namespace) 조합
current-context: ...
```

```bash
kubectl config get-contexts                  # 컨텍스트 목록
kubectl config use-context <name>            # 컨텍스트 전환 (시험에서 문제마다 실행!)
kubectl config current-context               # 현재 컨텍스트 확인
kubectl config set-context --current --namespace=dev   # 현재 컨텍스트 기본 네임스페이스 변경
kubectl config view --minify                 # 현재 컨텍스트 정보만 보기
```

> **시험 팁**: 모든 문제 상단에 `kubectl config use-context ...` 명령이 주어진다. 무조건 먼저 실행할 것.

## 2. 기본 조회 명령

```bash
kubectl get pods                             # 현재 네임스페이스
kubectl get pods -n kube-system              # 특정 네임스페이스
kubectl get pods -A                          # 모든 네임스페이스 (--all-namespaces)
kubectl get pods -o wide                     # 노드/IP까지 표시
kubectl get pod nginx -o yaml                # 전체 YAML
kubectl get pods --show-labels
kubectl get pods -l app=web                  # 레이블 셀렉터
kubectl get pods -l 'env in (dev,test)'
kubectl get all -n dev                       # 주요 리소스 한번에
kubectl describe pod nginx                   # 상세 + 이벤트 (트러블슈팅 1순위)
kubectl get events --sort-by=.metadata.creationTimestamp
```

### 리소스 종류 찾기
```bash
kubectl api-resources                        # 모든 리소스 종류 + 축약형 + apiGroup
kubectl api-resources --namespaced=true     # 네임스페이스 리소스만
kubectl explain pod.spec.containers         # 필드 문서 (YAML 구조 까먹었을 때)
kubectl explain deployment.spec.strategy --recursive
```

### 주요 축약형
`po`(pods), `deploy`, `svc`, `ns`, `no`(nodes), `cm`(configmaps), `sa`, `pv`, `pvc`, `netpol`, `sc`(storageclasses), `ds`(daemonsets), `sts`(statefulsets), `rs`, `ing`(ingresses), `ep`(endpoints), `crd`

## 3. 리소스 생성 — 명령형이 빠르다

### Pod / Deployment
```bash
kubectl run nginx --image=nginx                              # Pod 생성
kubectl run nginx --image=nginx --port=80 --labels=app=web
kubectl create deployment web --image=nginx --replicas=3
```

### Service
```bash
kubectl expose deployment web --port=80 --target-port=8080          # ClusterIP
kubectl expose pod nginx --port=80 --name=nginx-svc
kubectl create service nodeport web --tcp=80:8080 --node-port=30080
```

### 기타
```bash
kubectl create configmap app-config --from-literal=KEY=value
kubectl create secret generic db-secret --from-literal=password=1234
kubectl create job myjob --image=busybox -- echo hello
kubectl create cronjob mycj --image=busybox --schedule="*/5 * * * *" -- echo hi
kubectl create namespace dev
kubectl create serviceaccount mysa
kubectl create role / rolebinding / clusterrole / clusterrolebinding   # 06단원
```

## 4. --dry-run=client -o yaml : YAML 뼈대 생성

**CKA 핵심 기술.** 맨손으로 YAML을 치지 말고 뼈대를 만들어 수정한다.

```bash
kubectl run nginx --image=nginx --dry-run=client -o yaml > pod.yaml
kubectl create deploy web --image=nginx --replicas=3 --dry-run=client -o yaml > deploy.yaml
kubectl expose deploy web --port=80 --dry-run=client -o yaml > svc.yaml
vim pod.yaml   # 필요한 부분 수정
kubectl apply -f pod.yaml
```

시험에서 자주 쓰는 변수 세팅 (시험 환경에 alias `k`는 이미 있음):
```bash
export do="--dry-run=client -o yaml"
export now="--force --grace-period=0"
# 사용 예
k run test --image=busybox $do > p.yaml
k delete pod test $now
```

## 5. 수정 명령

```bash
kubectl edit deploy web                      # 에디터로 직접 수정 (즉시 적용)
kubectl set image deploy/web nginx=nginx:1.27       # 이미지 변경
kubectl scale deploy web --replicas=5
kubectl label pod nginx env=prod             # 레이블 추가
kubectl label pod nginx env-                 # 레이블 제거
kubectl annotate pod nginx desc="hello"
kubectl patch deploy web -p '{"spec":{"replicas":2}}'
```

> **주의**: Pod는 대부분의 필드가 불변(immutable). `kubectl edit pod`로 이미지 외의 것을 바꾸려 하면 거부된다. 이럴 땐:
> ```bash
> kubectl get pod nginx -o yaml > p.yaml   # 백업
> vim p.yaml                               # 수정
> kubectl delete pod nginx $now
> kubectl apply -f p.yaml                  # 재생성
> ```
> 또는 `kubectl edit`가 거부되면 임시 파일 경로를 알려주는데(`/tmp/kubectl-edit-....yaml`), 그 파일로 `kubectl replace --force -f <경로>` 해도 된다.

## 6. 실행/디버깅

```bash
kubectl logs nginx                           # 로그
kubectl logs nginx -c sidecar                # 멀티컨테이너 중 특정 컨테이너
kubectl logs nginx --previous               # 재시작 전 컨테이너 로그 (CrashLoop 진단)
kubectl logs -f deploy/web --tail=50
kubectl exec -it nginx -- sh                 # 컨테이너 접속
kubectl exec nginx -- cat /etc/config/key    # 단일 명령
kubectl port-forward svc/web 8080:80         # 로컬 → 서비스 포워딩
kubectl cp nginx:/var/log/app.log ./app.log
kubectl debug -it nginx --image=busybox --target=nginx   # 임시(ephemeral) 컨테이너 붙이기
```

### 일회용 테스트 Pod (네트워크 검증에 필수)
```bash
kubectl run tmp --image=busybox --rm -it --restart=Never -- wget -qO- http://web-svc:80
kubectl run tmp --image=busybox --rm -it --restart=Never -- nslookup kubernetes.default
```

## 7. 출력 가공

```bash
kubectl get pods -o jsonpath='{.items[*].metadata.name}'
kubectl get nodes -o jsonpath='{.items[*].status.addresses[?(@.type=="InternalIP")].address}'
kubectl get pods --sort-by=.metadata.creationTimestamp
kubectl get pv --sort-by=.spec.capacity.storage
kubectl get pods -o custom-columns='NAME:.metadata.name,IMAGE:.spec.containers[*].image'
kubectl get pods -o name                     # pod/nginx 형태 (스크립트용)
```

> jsonpath 문법이 기억 안 나면 시험 중 문서 검색: "kubectl cheat sheet" 페이지에 예제가 많다.

## 8. apply vs create vs replace

| 명령 | 특성 |
|---|---|
| `kubectl create -f` | 없으면 생성, 있으면 에러 |
| `kubectl apply -f` | 없으면 생성, 있으면 병합 업데이트 (**기본으로 이걸 쓸 것**) |
| `kubectl replace -f` | 기존 객체 전체 교체 (없으면 에러) |
| `kubectl replace --force -f` | 삭제 후 재생성 (불변 필드 수정 시) |

## 9. 시험 환경 vim 세팅 (선택)

```bash
cat <<EOF >> ~/.vimrc
set ts=2 sw=2 et
EOF
```
- `ts`(tabstop), `sw`(shiftwidth), `et`(expandtab): 탭을 스페이스 2칸으로 — YAML 들여쓰기 사고 방지.
- vim에서 블록 들여쓰기: `V`로 줄 선택 → `>` 또는 `<`

## 10. 체크리스트

- [ ] `kubectl config use-context`가 손에 익었다
- [ ] run/create deploy/expose + `$do`로 30초 안에 YAML 뼈대를 만들 수 있다
- [ ] Pod 불변 필드 수정 시 delete → apply 재생성 흐름을 안다
- [ ] `kubectl explain`으로 YAML 구조를 찾을 수 있다
- [ ] 일회용 busybox Pod로 서비스/DNS를 검증할 수 있다
