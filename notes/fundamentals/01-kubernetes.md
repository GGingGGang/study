# Kubernetes (k8s)

## 1. Why — 왜 쓰는가

컨테이너 오케스트레이션 사실상 표준. 단순히 "컨테이너를 자동으로 띄우는 도구"가 아니라 **선언적 인프라 시스템** 자체.

**컨테이너만으로는 부족한 이유**:
- Docker 단독: 컨테이너 죽으면 직접 재시작해야 함, 여러 노드에 분산 배치 안 됨, 무중단 배포 어려움, 헬스체크 없음
- docker-compose: 단일 호스트만, 스케일링 없음, 노드 장애 대응 없음
- 노드 10대 + 컨테이너 100개 환경에서 운영 폭발

**k8s가 해결하는 문제**:
- **선언적 상태 관리**: "Pod 3개 떠 있어야 함" 선언만 하면 알아서 유지
- **자가 치유**: 컨테이너/노드 죽으면 자동 재배치
- **로드 밸런싱**: Service가 자동으로 트래픽 분산
- **스케일링**: HPA로 부하 따라 자동 증감
- **무중단 배포**: rolling update, blue-green, canary 기본 지원
- **자원 관리**: CPU/메모리 requests/limits로 노드 자원 효율 극대화

**대체재 (역사적 맥락)**:
- Docker Swarm: 단순하나 기능 제한, Docker Inc 사실상 포기
- Apache Mesos: Twitter/Apple 사용, 복잡도 높음, 쇠퇴
- Nomad (HashiCorp): k8s보다 단순, BSL 라이선스
- **k8s**: CNCF graduated, 모든 클라우드 매니지드 제공, 생태계 압도적

2026년 기준 사실상 표준이라 "왜 k8s?"는 거의 안 묻고 "k8s를 어떻게 운영했나?"가 핵심.

## 2. Architecture — 어떻게 구성되는가

**Control Plane** (마스터, OKE Basic은 매니지드라 안 보임):

- **kube-apiserver**: 모든 요청의 진입점. REST API 노출, 인증/인가/admission control. 본 프로젝트 OKE에서 6443 포트.
- **etcd**: 모든 클러스터 상태를 저장하는 분산 key-value store. Raft 합의 알고리즘. OKE에서는 보이지 않음.
- **kube-scheduler**: 새 Pod이 어느 노드에 갈지 결정. 자원, affinity, taint/toleration 등 고려.
- **kube-controller-manager**: 다수 controller 묶음. Deployment, ReplicaSet, Endpoint 등 각 리소스의 reconciliation loop 실행.
- **cloud-controller-manager**: 클라우드 특화 controller (OCI LB 자동 프로비저닝, Block Volume 마운트 등). OKE에서 OCI 통합.

**Worker Node** (본 프로젝트 A1.Flex 2개):

- **kubelet**: 노드의 agent. 자신에게 할당된 Pod을 띄우고 헬스 보고.
- **kube-proxy**: Service 추상화를 위한 iptables/IPVS 룰 관리. Cilium chaining에서는 일부 대체됨.
- **container runtime**: containerd (Docker 아님, k8s 1.24+에서 dockershim 제거).
- **CNI plugin**: pod 네트워크 (본 프로젝트 Flannel).
- **CSI plugin**: 스토리지 마운트 (본 프로젝트 OCI Block Volume CSI).

**핵심 추상화**:
- **Pod**: 최소 배포 단위. 1개 이상 컨테이너의 묶음. 같은 네트워크 namespace, 같은 storage 공유.
- **Workload 컨트롤러**: Deployment(stateless), StatefulSet(stateful, 안정적 ID), DaemonSet(노드당 1개), Job(일회성), CronJob(스케줄).
- **Service**: Pod 묶음에 안정적인 가상 IP/DNS 제공. ClusterIP / NodePort / LoadBalancer / ExternalName.
- **ConfigMap / Secret**: 설정/시크릿 데이터.
- **Namespace**: 리소스 논리적 분리. RBAC 기준.

## 3. Mechanism — 어떻게 돌아가는가

**선언적 API + Reconciliation Loop**:

1. 사용자가 `kubectl apply -f deploy.yaml` 실행
2. kubectl이 manifest를 etcd 형식으로 변환해서 kube-apiserver에 전송
3. kube-apiserver가 인증 → 인가(RBAC) → admission control(PSA, webhook) 통과 후 etcd에 저장
4. 관련 controller(예: Deployment controller)가 etcd watch로 변경 감지
5. Controller가 desired state(매니페스트)와 actual state(현재 클러스터) 비교
6. 차이 있으면 새 Pod 생성 요청을 etcd에 기록
7. Scheduler가 새 Pod의 노드 결정
8. 해당 노드의 kubelet이 etcd watch로 자기 노드에 할당된 Pod 발견
9. kubelet이 container runtime(containerd)에게 컨테이너 시작 명령
10. CNI plugin이 Pod 네트워크 설정, CSI plugin이 볼륨 마운트
11. kubelet이 헬스 체크 시작, 상태를 etcd에 보고

**핵심 원칙**: 모든 컴포넌트가 etcd를 source of truth로 보고 비동기로 동작. 어떤 컴포넌트가 죽어도 살아나면 etcd 보고 자기 일 계속. **eventually consistent** 모델.

**Controller 패턴**: 어떤 CRD든 `desired state` 선언만 하면 controller가 reconciliation loop로 알아서 맞춤. 이게 cert-manager, ArgoCD, Strimzi 모든 도구의 동작 원리.

## 4. Integration — 어떻게 연결하는가

본 프로젝트에서 k8s는 모든 것의 기반. 거의 모든 컴포넌트가 k8s 네이티브 리소스 또는 CRD 위에서 동작.

- **OKE Basic Cluster** (Phase 1): k8s 자체. control plane은 OCI 매니지드
- **Flannel CNI** (OKE add-on): Pod 네트워크
- **OCI Block Volume CSI** (built-in): PV 프로비저닝
- **OCI Cloud Controller Manager**: LB Service 자동 프로비저닝, NSG 연동
- **모든 후속 phase**: k8s API 위에서 CRD 추가하거나 Pod 형태로 컴포넌트 배포

## 5. Usage — 어떻게 쓰는가

**필수 명령어 카테고리**:

```bash
# 조회
kubectl get pods -n app                    # Pod 목록
kubectl get pods -n app -o wide             # 노드 IP 포함
kubectl describe pod <name> -n app          # 상세 정보 + 이벤트
kubectl logs <pod> -n app -c <container>    # 로그
kubectl logs <pod> -n app --previous        # 죽기 전 로그

# 변경
kubectl apply -f manifest.yaml              # 선언적 적용
kubectl edit deployment <name> -n app       # 직접 수정 (drift 위험, ArgoCD에서 비권장)
kubectl scale deployment <name> --replicas=3 -n app

# 디버깅
kubectl exec -it <pod> -n app -- sh         # 컨테이너 진입
kubectl port-forward svc/<name> 8080:8080   # 로컬로 포워딩
kubectl debug node/<node> -it --image=ubuntu # 노드 디버깅

# 자원 상태
kubectl top nodes                           # 노드 CPU/메모리
kubectl top pods -n app                     # Pod CPU/메모리
kubectl get events -n app --sort-by='.lastTimestamp'
```

**Manifest 예시** (Deployment):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: login
  namespace: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: login
  template:
    metadata:
      labels:
        app: login
    spec:
      containers:
      - name: login
        image: ghcr.io/myorg/login:abc123
        resources:
          requests:
            cpu: 100m
            memory: 64Mi
          limits:
            cpu: 500m
            memory: 128Mi
        livenessProbe:
          httpGet:
            path: /livez
            port: 9090
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /readyz
            port: 9090
          periodSeconds: 5
        lifecycle:
          preStop:
            exec:
              command: ["sleep", "5"]
```

## 6. Configuration — 어떤 설정이 있는가

**Resource requests/limits**:
- `requests`: 스케줄러가 노드 선택 시 보장하는 최소 자원. 실제 사용량 아님.
- `limits`: 컨테이너가 넘으면 OOMKilled(메모리) 또는 throttling(CPU).
- requests = limits 권장 (QoS class Guaranteed, OOM 우선순위 가장 낮음)

**Probes**:
- `livenessProbe`: 실패 시 컨테이너 재시작
- `readinessProbe`: 실패 시 Service endpoint에서 제외 (트래픽 차단)
- `startupProbe`: 시작 느린 앱용, 통과 전까지 liveness 안 함

**Pod 종료 흐름** (graceful shutdown):
1. SIGTERM 전송
2. `terminationGracePeriodSeconds`(default 30초) 대기
3. preStop hook 실행 (있으면)
4. 시간 끝나면 SIGKILL
5. 동시에 Service endpoint에서 제거 (rolling update 시)

**Security Context**:
- `runAsNonRoot: true`: root로 실행 금지 (PSA restricted 필수)
- `readOnlyRootFilesystem: true`: 루트 파일시스템 읽기 전용
- `allowPrivilegeEscalation: false`: 권한 상승 금지
- `capabilities.drop: ["ALL"]`: Linux capability 모두 제거

**Affinity / Anti-affinity**:
- `nodeSelector`: 단순한 라벨 매칭
- `nodeAffinity`: 노드 선택 룰 (필수/선호)
- `podAntiAffinity`: 같은 노드에 다른 Pod 회피 (HA 위함)
- `topologySpreadConstraints`: 노드 간 균등 분배 (본 프로젝트 권장)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **kubectl 버전**: 클러스터 버전과 ±1 minor 호환 (1.34 클러스터엔 1.33~1.35 kubectl)
- **API 버전 진화**: alpha → beta → v1 → deprecated. 본 프로젝트는 v1만 사용. beta 신규 사용 금지.
- **Deprecation policy**: API는 v1 이전 단계에서만 제거 가능. v1 GA되면 1년 또는 3 release 유예
- **Container runtime**: containerd 1.6+ (dockershim 제거됨, Docker runtime은 더 이상 안 됨)
- **CRI (Container Runtime Interface)**: containerd / CRI-O 사용
- **CNI v1.0+**: Flannel, Cilium, Calico 등
- **CSI v1.0+**: 모든 modern 스토리지 plugin

## 8. 면접 예상 질문 & 답변

**Q1. Pod와 Container 차이가 뭐예요?**
> Container는 Docker나 containerd가 띄우는 단일 프로세스 격리 단위고, Pod은 Kubernetes의 최소 배포 단위입니다. Pod 안에 컨테이너가 1개 이상 있을 수 있고, 같은 Pod의 컨테이너는 네트워크 namespace와 storage volume을 공유합니다. 단일 컨테이너 Pod이 일반적이고, 사이드카 패턴(예: Istio sidecar, log shipper)이 멀티 컨테이너 Pod의 대표 사례입니다. Pod이 죽으면 새 Pod이 만들어지지 같은 Pod이 살아나는 게 아니라서, IP가 바뀌고 state가 사라집니다. 그래서 stateful 앱은 StatefulSet이 보장하는 안정적 ID와 PV가 필요합니다.

**Q2. Deployment, StatefulSet, DaemonSet 차이는?**
> Deployment는 stateless 앱용으로 Pod이 동일하고 순서 없이 띄워지며 IP/이름이 변동됩니다. StatefulSet은 stateful 앱용으로 안정적인 이름(`app-0`, `app-1`)과 순차 시작/종료, Pod마다 별도 PV가 보장됩니다. 데이터베이스, Kafka 브로커, Vault 같은 게 여기 해당합니다. DaemonSet은 모든 노드(또는 선택된 노드)마다 정확히 1개 Pod을 띄우는 것으로, 로그 수집기(Alloy), CNI agent(Cilium), monitoring exporter(node-exporter) 같은 노드별 컴포넌트에 씁니다. 본 프로젝트는 ztunnel, Cilium agent, Alloy가 DaemonSet입니다.

**Q3. Service 타입 네 가지 차이를 설명해주세요.**
> ClusterIP는 클러스터 내부에서만 접근 가능한 가상 IP고 default 타입입니다. NodePort는 모든 노드의 30000-32767 포트에 노출해서 외부에서 노드 IP로 접근 가능하게 합니다. LoadBalancer는 클라우드 controller가 외부 LB를 자동 프로비저닝하고 NodePort에 트래픽을 보내는 방식으로, OKE에서는 OCI Flexible LB가 자동 생성됩니다. ExternalName은 외부 도메인을 cluster DNS로 alias하는 용도로, 외부 RDS나 SaaS endpoint를 Service처럼 쓸 때 사용합니다.

**Q4. etcd가 왜 중요하고 죽으면 어떻게 되나요?**
> etcd는 클러스터의 모든 상태(Pod, Service, Secret, ConfigMap 등)를 저장하는 단일 source of truth입니다. etcd가 죽으면 kube-apiserver가 데이터를 읽고 쓸 수 없어서 모든 변경 작업이 막힙니다. 단 이미 동작 중인 Pod은 그대로 살아있고 트래픽도 처리되는데, 노드가 죽거나 Pod이 죽어도 controller가 새로 만들 수 없게 됩니다. production에서는 etcd 5개 HA 클러스터로 Raft 합의를 유지하지만, OKE Basic은 control plane이 매니지드라 사용자가 etcd를 직접 관리하지 않습니다. 그래서 backup도 OCI가 알아서 합니다.

**Q5. requests와 limits 차이는 뭐고 어떻게 설정해야 해요?**
> requests는 스케줄러가 노드 선택 시 보장하는 최소 자원이고 실제 사용량이 아닙니다. limits는 컨테이너가 넘으면 강제 제약이 걸리는데, 메모리는 OOMKilled로 컨테이너가 죽고 CPU는 throttling으로 성능이 떨어집니다. 본 프로젝트는 requests = limits로 맞춰서 QoS class를 Guaranteed로 만드는 패턴을 권장합니다. 이러면 OOM 발생 시 다른 Pod부터 죽이는 우선순위가 됩니다. 실제 값은 부하 테스트로 P99 사용량을 측정한 후 +20% 마진으로 설정하는 게 표준입니다.

**Q6. livenessProbe와 readinessProbe 차이는?**
> livenessProbe는 "프로세스가 살아있는가"를 체크하고 실패하면 컨테이너를 재시작합니다. readinessProbe는 "트래픽을 받을 준비가 됐는가"를 체크하고 실패하면 Service endpoint에서 제외되어 트래픽이 안 갑니다. 분리한 이유는 책임이 다르기 때문입니다. DB 연결이 일시적으로 끊겨서 트래픽을 못 받을 수는 있지만(readiness 실패) 프로세스를 재시작할 필요는 없습니다(liveness 통과). liveness가 lightweight 자기 체크, readiness가 의존성 체크로 설계하는 게 표준입니다.

**Q7. namespace를 왜 분리하고 어떻게 분리해야 하나요?**
> namespace는 (1) RBAC 단위, (2) ResourceQuota 단위, (3) NetworkPolicy 단위, (4) 이름 충돌 방지 단위입니다. 본 프로젝트는 컴포넌트 lifecycle 기준으로 분리합니다. istio-system은 업그레이드 영향 범위 격리, cert-manager/external-dns는 cluster-wide controller 분리, cicd는 CI/CD 도구 묶음, monitoring은 관측 스택, vault는 시크릿 관리, app은 비즈니스 앱. 일반적으로 "같이 업그레이드되는 컴포넌트끼리" 같은 namespace에 묶는 게 원칙입니다.

**Q8. Pod이 Pending 상태로 떠 있으면 어떻게 디버깅해요?**
> `kubectl describe pod <name>`의 Events 섹션을 먼저 봅니다. 흔한 원인 5가지가 있습니다. (1) FailedScheduling - 노드 자원 부족 또는 affinity 불만족, (2) ImagePullBackOff - 이미지 풀 실패(권한 또는 태그 오타), (3) CrashLoopBackOff - 컨테이너가 계속 죽음(`kubectl logs --previous`로 직전 로그 확인), (4) Init container 실패 - Vault Agent 같은 init이 못 끝남, (5) PVC pending - StorageClass 없거나 quota 초과. 이 5가지가 90% 커버합니다.

**Q9. OKE Basic Cluster의 한계는 뭐예요?**
> 세 가지가 핵심입니다. (1) CNI가 Flannel만 가능하고 OCI VCN-Native CNI는 Enhanced Cluster(유료) 전용입니다. (2) OKE Add-on(cluster autoscaler, OKE Workload Identity 등 선택형 add-on)이 안 됩니다. 단 Block Volume CSI 같은 essential 컴포넌트는 기본 제공됩니다. (3) Control Plane SLA가 없어서 OCI가 SLA 보장 안 합니다. 본 프로젝트는 포트폴리오 + 학습 목적이라 Basic으로 충분하고, production이라면 Enhanced 권장입니다.

**Q10. Imperative 명령(`kubectl create`)과 Declarative 매니페스트(`kubectl apply`) 중 어느 걸 써야 하나요?**
> 무조건 declarative입니다. Imperative는 한 번 실행 후 무엇이 적용됐는지 기록이 없어서 GitOps와 호환되지 않고, ArgoCD가 drift로 감지해서 되돌립니다. 본 프로젝트는 모든 변경을 manifest로 작성하고 Git에 커밋한 후 ArgoCD가 apply하는 흐름만 허용합니다. `kubectl edit`이나 `kubectl scale`도 drift를 만들므로 운영 환경에서는 금지하고, 디버깅용 임시 변경만 허용합니다.

**Q11. CRD가 뭐고 왜 중요해요?**
> Custom Resource Definition입니다. Kubernetes API에 새 리소스 타입을 추가하는 메커니즘으로, cert-manager의 `Certificate`, Istio의 `Gateway`, Argo의 `ApplicationSet` 같은 게 모두 CRD입니다. CRD가 중요한 이유는 (1) k8s가 단순 컨테이너 오케스트레이터가 아니라 확장 가능한 API platform이 된다는 점, (2) 모든 도구가 같은 declarative 패턴을 따라서 kubectl/ArgoCD/RBAC가 그대로 작동한다는 점입니다. controller만 짜면 누구나 자기 도메인의 declarative API를 만들 수 있고, 본 프로젝트는 이미 30+개의 CRD를 사용합니다.

**Q12. Helm chart로 설치한 것과 직접 manifest로 설치한 것 중 어느 게 나은가요?**
> 컴포넌트가 단순하면 manifest, 복잡하면 Helm입니다. 본 프로젝트는 거의 모든 인프라 컴포넌트(Istio, ArgoCD, kube-prometheus-stack, Vault, Strimzi 등)를 Helm으로 설치합니다. 이유는 (1) values.yaml로 환경별 설정 분리가 자연스럽고, (2) upgrade/rollback이 명령 한 줄, (3) 의존성 차트 자동 관리, (4) ArgoCD가 Helm chart를 native source로 지원하기 때문입니다. 앱 코드 매니페스트는 단순해서 Helm 없이 raw manifest로 가는 경우도 있는데, 본 프로젝트는 모든 앱도 Helm chart로 통일했습니다.
