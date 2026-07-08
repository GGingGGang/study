# 04. 클러스터 라이프사이클 — 업그레이드와 etcd 백업/복원

> 도메인: 클러스터 아키텍처, 설치 및 구성 (25%)
> 시험 포인트: **kubeadm 업그레이드와 etcd 백업/복원은 CKA 최고 빈출 주제.** 절차를 통째로 외우고, 실제 VM에서 최소 3번은 손으로 해볼 것.

---

## 1. 버전 정책 기초

- 버전 표기: `v1.35.2` = 메이저 1, 마이너 35, 패치 2
- **마이너 버전은 한 단계씩만 업그레이드** 가능 (1.33 → 1.34 → 1.35, 건너뛰기 불가)
- 버전 skew(허용 편차):
  - kubelet은 apiserver보다 **최대 3개 마이너 버전까지 낮아도** 됨 (높으면 안 됨)
  - kubectl은 apiserver ±1 마이너
- 순서: **컨트롤 플레인 먼저 → 워커 노드**

## 2. 클러스터 업그레이드 (kubeadm)

### 2-0. 저장소 버전 변경 (모든 노드, 각 노드에서 업그레이드 직전에)
pkgs.k8s.io는 마이너 버전별 저장소이므로 **URL의 버전을 바꿔야 새 패키지가 보인다.**
```bash
# /etc/apt/sources.list.d/kubernetes.list 에서 v1.34 → v1.35 로 수정
sudo sed -i 's/v1.34/v1.35/' /etc/apt/sources.list.d/kubernetes.list
sudo apt-get update
```

### 2-1. 첫 번째 컨트롤 플레인 노드

```bash
# 1) kubeadm 업그레이드
sudo apt-mark unhold kubeadm
sudo apt-get update
sudo apt-cache madison kubeadm            # 설치 가능 버전 확인
sudo apt-get install -y kubeadm=1.35.x-*
sudo apt-mark hold kubeadm
kubeadm version                            # 확인

# 2) 업그레이드 계획 확인 및 적용
sudo kubeadm upgrade plan
sudo kubeadm upgrade apply v1.35.x         # 컨트롤 플레인 컴포넌트 업그레이드

# 3) 노드 비우기
kubectl drain <cp-node> --ignore-daemonsets

# 4) kubelet, kubectl 업그레이드
sudo apt-mark unhold kubelet kubectl
sudo apt-get install -y kubelet=1.35.x-* kubectl=1.35.x-*
sudo apt-mark hold kubelet kubectl
sudo systemctl daemon-reload
sudo systemctl restart kubelet

# 5) 스케줄링 재개
kubectl uncordon <cp-node>
```

### 2-2. 추가 컨트롤 플레인 / 워커 노드

첫 컨트롤 플레인과 거의 같지만 **`upgrade apply` 대신 `upgrade node`**:
```bash
# (해당 노드에 ssh 후) 저장소 변경 → kubeadm 업그레이드 → 그리고:
sudo kubeadm upgrade node

# drain은 kubectl이 되는 곳(컨트롤 플레인 또는 시험의 기본 터미널)에서:
kubectl drain <node> --ignore-daemonsets

# kubelet/kubectl 업그레이드 + 재시작 (위와 동일)
kubectl uncordon <node>
```

### 2-3. 확인
```bash
kubectl get nodes    # VERSION 열 확인
```

### 자주 하는 실수
- 저장소 URL 버전을 안 바꿔서 `apt-cache madison`에 새 버전이 안 보임
- `upgrade apply`(첫 CP 전용)와 `upgrade node`(나머지 전부)를 혼동
- drain을 빼먹거나, 작업 후 uncordon을 빼먹음
- `apt-mark hold`를 풀지 않고 install 시도

## 3. drain / cordon 정리

```bash
kubectl cordon <node>      # 신규 스케줄만 차단 (기존 Pod 유지)
kubectl drain <node> --ignore-daemonsets              # 차단 + 기존 Pod 퇴거
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data   # emptyDir 있는 Pod도 강제
kubectl drain <node> --ignore-daemonsets --force      # 컨트롤러 없는 단독 Pod도 삭제
kubectl uncordon <node>    # 스케줄링 재개
```

- drain이 거부되는 흔한 이유: DaemonSet Pod(→ `--ignore-daemonsets`), emptyDir 사용 Pod(→ `--delete-emptydir-data`), 컨트롤러 없는 naked Pod(→ `--force`, 데이터 소실 주의)

## 4. etcd 백업

etcd는 컨트롤 플레인 노드에서 static pod로 실행 중. 인증서 경로는 `/etc/kubernetes/pki/etcd/`.

```bash
# (etcdctl이 없으면: apt-get install etcd-client, 시험 환경엔 보통 설치돼 있음)
ETCDCTL_API=3 etcdctl snapshot save /opt/backup/etcd-snap.db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key
```

- etcdctl v3.4+는 기본 API가 3이라 `ETCDCTL_API=3` 생략 가능하지만, 습관적으로 붙이면 안전.
- 인증서 경로가 기억 안 나면 etcd static pod에서 확인:
  ```bash
  cat /etc/kubernetes/manifests/etcd.yaml | grep -E "cert|key|trusted"
  # 또는
  kubectl -n kube-system describe pod etcd-<node> | grep -E "cert|key"
  ```

### 백업 상태 확인
```bash
ETCDCTL_API=3 etcdctl snapshot status /opt/backup/etcd-snap.db --write-out=table
# 참고: snapshot status는 최신 버전에서 etcdutl로 옮겨감 — etcdutl snapshot status ...
```

## 5. etcd 복원

**복원은 새 데이터 디렉터리에 스냅샷을 풀고, etcd가 그 디렉터리를 보도록 바꾸는 작업이다.**

```bash
# 1) 스냅샷을 새 디렉터리로 복원 (etcdutl 권장, etcdctl snapshot restore는 deprecated)
sudo etcdutl snapshot restore /opt/backup/etcd-snap.db \
  --data-dir /var/lib/etcd-restore
# (etcdutl이 없는 환경이면: ETCDCTL_API=3 etcdctl snapshot restore ... --data-dir ...)

# 2) etcd static pod가 새 디렉터리를 쓰도록 수정
sudo vim /etc/kubernetes/manifests/etcd.yaml
```
```yaml
  volumes:
  - hostPath:
      path: /var/lib/etcd-restore    # ← 기존 /var/lib/etcd 에서 변경
      type: DirectoryOrNotExist
    name: etcd-data
```
```bash
# 3) kubelet이 etcd Pod를 자동 재생성 — 1~2분 대기
watch crictl ps                    # etcd 컨테이너 재기동 확인
kubectl get pods -A                # 클러스터 상태 복원 확인
```

- hostPath의 `path`만 바꾸면 컨테이너 안 마운트 경로(`/var/lib/etcd`)는 그대로라 `--data-dir` 인자를 건드릴 필요가 없다. (볼륨 path 수정이 가장 실수 없는 방법)
- etcd 재생성이 오래 걸리면: `sudo systemctl restart kubelet`, 또는 매니페스트를 잠시 디렉터리 밖으로 옮겼다가 다시 넣기.

## 6. 인증서 관리

kubeadm 인증서는 기본 **1년** 유효. (클러스터 업그레이드 시 자동 갱신됨)

```bash
sudo kubeadm certs check-expiration      # 만료일 확인
sudo kubeadm certs renew all             # 전체 갱신
sudo kubeadm certs renew apiserver       # 개별 갱신
# 갱신 후 컨트롤 플레인 static pod 재시작 필요 (매니페스트를 밖으로 뺐다 넣거나 kubelet 재시작)
```

수동 확인 (openssl):
```bash
openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates
```

## 7. 체크리스트

- [ ] 업그레이드 순서(저장소 변경 → kubeadm → upgrade apply/node → drain → kubelet/kubectl → uncordon)를 안 보고 쓸 수 있다
- [ ] `upgrade apply`는 첫 CP, `upgrade node`는 나머지 — 구분한다
- [ ] etcd 백업 명령을 인증서 3개 옵션 포함해 외웠다
- [ ] 복원 = 새 data-dir로 restore + etcd.yaml의 hostPath 수정 흐름을 안다
- [ ] drain 옵션 3종(`--ignore-daemonsets`, `--delete-emptydir-data`, `--force`)의 용도를 안다
- [ ] `kubeadm certs check-expiration / renew`를 안다
