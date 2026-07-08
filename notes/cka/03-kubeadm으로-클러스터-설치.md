# 03. kubeadm으로 클러스터 설치

> 도메인: 클러스터 아키텍처, 설치 및 구성 (25%)
> 시험 포인트: "기반 인프라 준비 + kubeadm으로 클러스터 생성"은 커리큘럼에 명시된 항목. 시험에서는 보통 일부 단계(join, 특정 설정)만 출제되지만, 전체 흐름을 알아야 응용할 수 있다.

---

## 1. 사전 준비 (모든 노드 공통)

### 1-1. 시스템 요구사항
- 노드당 최소 2GB RAM, 컨트롤 플레인은 CPU 2코어 이상
- 노드 간 네트워크 연결, 고유한 hostname/MAC
- 필수 포트 개방:

| 포트 | 사용처 | 노드 |
|---|---|---|
| 6443 | kube-apiserver | 컨트롤 플레인 |
| 2379-2380 | etcd | 컨트롤 플레인 |
| 10250 | kubelet API | 전체 |
| 10257 | kube-controller-manager | 컨트롤 플레인 |
| 10259 | kube-scheduler | 컨트롤 플레인 |
| 30000-32767 | NodePort 서비스 | 워커 |

### 1-2. swap 비활성화
kubelet은 기본적으로 swap이 켜져 있으면 시작하지 않는다.
```bash
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab    # 재부팅 후에도 유지
```

### 1-3. 커널 모듈과 sysctl
```bash
# 커널 모듈
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF
sudo modprobe overlay
sudo modprobe br_netfilter

# sysctl — IPv4 포워딩은 필수
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
sudo sysctl --system
```

## 2. 컨테이너 런타임 설치 (containerd)

```bash
sudo apt-get update && sudo apt-get install -y containerd

# 기본 설정 생성
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml
```

**핵심: cgroup 드라이버를 systemd로 통일** (kubelet 기본값도 systemd. 불일치하면 노드가 불안정해짐)
```toml
# /etc/containerd/config.toml 에서
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```
```bash
sudo systemctl restart containerd
```

## 3. kubeadm, kubelet, kubectl 설치

패키지 저장소는 **pkgs.k8s.io** (2023년부터 커뮤니티 저장소로 이전됨. 구 Google 저장소 apt.kubernetes.io는 폐기).
**저장소가 마이너 버전별로 분리**되어 있다는 점이 중요 — 업그레이드 시 이 URL을 바꿔야 한다.

```bash
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl gpg

# 서명 키
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.35/deb/Release.key \
  | sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

# 저장소 (v1.35 전용)
echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.35/deb/ /' \
  | sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl     # 의도치 않은 자동 업그레이드 방지
sudo systemctl enable --now kubelet
```

## 4. 컨트롤 플레인 초기화 (컨트롤 플레인 노드에서만)

```bash
sudo kubeadm init \
  --pod-network-cidr=10.244.0.0/16 \
  --apiserver-advertise-address=<컨트롤플레인IP>
```

- `--pod-network-cidr`: CNI 플러그인이 요구하는 대역과 맞출 것 (Flannel 기본 10.244.0.0/16, Calico 192.168.0.0/16 등)
- `--control-plane-endpoint`: HA 구성 시 LB 주소 (05단원)

성공하면 출력되는 안내를 따라:
```bash
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### kubeadm init이 하는 일 (이해하고 있으면 트러블슈팅에 큰 도움)
1. preflight 검사 (swap, 포트, 런타임 등)
2. `/etc/kubernetes/pki/`에 CA와 인증서 생성
3. 컴포넌트별 kubeconfig 생성 (`admin.conf`, `kubelet.conf`, `controller-manager.conf`, `scheduler.conf`)
4. `/etc/kubernetes/manifests/`에 컨트롤 플레인 **static pod** 매니페스트 생성
5. kubelet이 static pod 기동 → 컨트롤 플레인 가동
6. 부트스트랩 토큰 생성, 애드온(CoreDNS, kube-proxy) 설치

## 5. CNI 플러그인 설치

CNI 설치 전에는 노드가 `NotReady`, CoreDNS는 `Pending` 상태다. **이것은 정상.**

```bash
# 예: Flannel
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
# 예: Calico
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.29.0/manifests/calico.yaml
```

설치 확인:
```bash
kubectl get nodes                 # Ready로 바뀜
kubectl get pods -n kube-system   # coredns Running
```

## 6. 워커 노드 조인

`kubeadm init` 출력 마지막의 join 명령을 워커 노드에서 실행:
```bash
sudo kubeadm join <컨트롤플레인IP>:6443 \
  --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>
```

### 토큰을 잃어버렸거나 만료됐을 때 (토큰 TTL 기본 24시간)
```bash
# 컨트롤 플레인에서 — join 명령 전체를 새로 출력해줌
kubeadm token create --print-join-command
```

```bash
kubeadm token list                # 기존 토큰 확인
```

## 7. 설치 후 확인

```bash
kubectl get nodes -o wide
kubectl get pods -A
kubectl cluster-info
# 컨트롤 플레인 노드에 워크로드를 올리고 싶다면 (단일 노드 실습 시)
kubectl taint nodes <node> node-role.kubernetes.io/control-plane:NoSchedule-
```

## 8. 초기화 실패 시 리셋

```bash
sudo kubeadm reset
# CNI 잔여물 정리
sudo rm -rf /etc/cni/net.d
```

## 9. 자주 나오는 함정

| 증상 | 원인 |
|---|---|
| kubelet이 계속 재시작 | swap 미해제, cgroup 드라이버 불일치 |
| 노드 NotReady | CNI 미설치 또는 CNI Pod 죽음 |
| join 실패: token expired | `kubeadm token create --print-join-command`로 재발급 |
| coredns Pending | CNI 미설치 (정상 순서 — CNI부터 설치) |
| init 실패: port in use | 이전 설치 잔여물 → `kubeadm reset` |

## 10. 체크리스트

- [ ] swap off, ip_forward=1, containerd SystemdCgroup=true 3종 세트를 안다
- [ ] pkgs.k8s.io 저장소가 마이너 버전별로 분리됨을 안다 (업그레이드 때 중요)
- [ ] kubeadm init → kubeconfig 복사 → CNI 설치 → join 순서를 안다
- [ ] `kubeadm token create --print-join-command`를 외웠다
- [ ] CNI 설치 전 NotReady는 정상임을 안다
