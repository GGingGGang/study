# 08. 확장 인터페이스(CNI·CSI·CRI)와 CRD, Operator

> 도메인: 클러스터 아키텍처, 설치 및 구성 (25%)
> 시험 포인트: 2025 개정판 신규 항목. "확장 인터페이스 이해", "CRD 이해, Operator 설치 및 구성"이 명시됨. CRD 조회, CR 생성, Helm/매니페스트로 Operator 설치 유형이 나온다.

---

## 1. 확장 인터페이스 3형제

쿠버네티스는 런타임·네트워크·스토리지를 직접 구현하지 않고 **표준 인터페이스**로 위임한다.

### CRI (Container Runtime Interface)
- kubelet ↔ 컨테이너 런타임 간 gRPC 규약
- 구현체: **containerd**(사실상 표준), CRI-O
- 런타임 소켓: `/run/containerd/containerd.sock` (kubelet 설정/`kubeadm`의 `--cri-socket`)
- 노드에서 진단: `crictl ps`, `crictl pods`, `crictl logs`, `crictl images`
  - crictl 설정: `/etc/crictl.yaml` (runtime-endpoint)

### CNI (Container Network Interface)
- Pod에 네트워크 인터페이스와 IP를 부여하는 플러그인 규약
- 구현체: Calico, Flannel, Cilium, Weave 등
- 파일 위치 (트러블슈팅 필수 암기):
  - 설정: `/etc/cni/net.d/` — 없거나 깨져 있으면 노드 NotReady
  - 바이너리: `/opt/cni/bin/`
- kubelet이 Pod 생성 시 CNI 플러그인을 호출해 네트워크 연결

### CSI (Container Storage Interface)
- 스토리지 벤더가 드라이버를 만들어 꽂는 규약
- 구현체: AWS EBS CSI, Ceph CSI, Longhorn 등
- StorageClass의 `provisioner` 필드에 CSI 드라이버 이름이 들어감 (17단원)
- 확인: `kubectl get csidrivers`, `kubectl get csinodes`

## 2. CRD (Custom Resource Definition)

쿠버네티스 API에 **새로운 리소스 타입을 추가**하는 방법. CRD를 등록하면 `kubectl`로 내장 리소스처럼 다룰 수 있다.

### 2-1. CRD 구조
```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com     # 규칙: <plural>.<group>
spec:
  group: stable.example.com
  scope: Namespaced                      # 또는 Cluster
  names:
    plural: crontabs
    singular: crontab
    kind: CronTab
    shortNames: ["ct"]
  versions:
  - name: v1
    served: true                         # API로 제공 여부
    storage: true                        # etcd 저장 버전 (하나만 true)
    schema:
      openAPIV3Schema:                   # 유효성 검증 스키마
        type: object
        properties:
          spec:
            type: object
            properties:
              cronSpec:
                type: string
              replicas:
                type: integer
```

### 2-2. Custom Resource(CR) 사용
```yaml
apiVersion: stable.example.com/v1
kind: CronTab
metadata:
  name: my-crontab
spec:
  cronSpec: "* * * * */5"
  replicas: 2
```

### 2-3. 조회 명령 (시험 빈출)
```bash
kubectl get crd                                   # 클러스터의 모든 CRD
kubectl get crd crontabs.stable.example.com -o yaml
kubectl describe crd crontabs.stable.example.com
kubectl explain crontab.spec                      # CRD도 explain 가능
kubectl get crontabs -A                           # CR 인스턴스 조회
kubectl api-resources | grep example.com          # 그룹으로 찾기
```

> 시험 유형 예: "cert-manager가 설치돼 있다. 이 클러스터의 cert-manager 관련 CRD 목록을 파일로 저장하라" → `kubectl get crd | grep cert-manager`

## 3. Operator

**Operator = CRD + 커스텀 컨트롤러.**
사람이 하던 운영 지식(설치, 백업, 장애 복구, 업그레이드)을 컨트롤러 코드로 자동화한 패턴.

- CRD가 "무엇을 원하는지"의 스키마라면, Operator의 컨트롤러는 그 CR을 감시하며 실제 상태를 수렴시키는 **조정 루프**를 돈다.
- 예시:
  - **cert-manager**: `Certificate` CR을 만들면 인증서를 발급/갱신
  - **Prometheus Operator**: `Prometheus`, `ServiceMonitor` CR로 모니터링 스택 관리
  - **etcd/PostgreSQL Operator**: DB 클러스터 생성, 백업, 페일오버 자동화

### 3-1. Operator 설치 방법 (시험은 보통 이 중 하나를 시킴)

```bash
# (a) 매니페스트 직접 적용
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.0/cert-manager.yaml

# (b) Helm 차트 (CRD 포함 설치)
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true
```

### 3-2. 설치 확인 흐름
```bash
kubectl get crd | grep cert-manager        # CRD 등록 확인
kubectl get pods -n cert-manager           # 컨트롤러 Pod 확인
kubectl get certificates -A                # CR 동작 확인
```

## 4. 그 밖의 확장 지점 (개념만)

- **Admission Webhook** (Validating/Mutating): 요청을 검증·변형하는 HTTP 콜백 — Kyverno, OPA Gatekeeper가 이 방식
- **Aggregated API Server**: apiserver 뒤에 별도 API 서버를 붙임 — metrics-server(`apiservices` 리소스)가 이 방식
  ```bash
  kubectl get apiservices | grep metrics
  ```
- **Device Plugin**: GPU 같은 특수 하드웨어 노출

## 5. 체크리스트

- [ ] CRI/CNI/CSI가 각각 무엇과 무엇 사이의 인터페이스인지 말할 수 있다
- [ ] `/etc/cni/net.d/`, `/opt/cni/bin/`, containerd 소켓 경로를 외웠다
- [ ] `crictl ps/logs`를 노드 트러블슈팅에 쓸 수 있다
- [ ] CRD YAML의 group/names/versions/scope 구조를 읽을 수 있다
- [ ] `kubectl get crd`, CR 조회, `kubectl explain <cr>`을 안다
- [ ] Operator = CRD + 컨트롤러 패턴임을 설명할 수 있다
- [ ] Helm으로 Operator(CRD 포함)를 설치할 수 있다
