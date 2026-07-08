# 11. 스케줄링과 Pod 어드미션

> 도메인: 워크로드와 스케줄링 (15%)
> 시험 포인트: "리소스 limits, node affinity 등 Pod 어드미션과 스케줄링 구성"이 커리큘럼 문구. taint/toleration + affinity 조합 문제, 특정 노드 배치 문제가 단골.

---

## 1. 리소스 requests와 limits

```yaml
spec:
  containers:
  - name: app
    resources:
      requests:            # 스케줄링 기준 (노드의 남은 요청 가능량과 비교)
        cpu: 250m          # 1000m = 1 코어
        memory: 128Mi
      limits:              # 실행 중 상한
        cpu: 500m          # 초과 시 스로틀링 (죽지 않음)
        memory: 256Mi      # 초과 시 OOMKilled
```

- **requests = 스케줄러가 보는 값. limits = 런타임이 강제하는 값.**
- requests 총합이 노드 용량을 초과하면 → Pod **Pending** (`kubectl describe pod` 이벤트에 "Insufficient cpu/memory")

### QoS 클래스 (퇴거 우선순위에 영향)
| 클래스 | 조건 | 메모리 압박 시 |
|---|---|---|
| Guaranteed | 모든 컨테이너 requests == limits | 마지막에 퇴거 |
| Burstable | requests < limits (일부만 설정 포함) | 중간 |
| BestEffort | 둘 다 없음 | 먼저 퇴거 |

## 2. 특정 노드에 배치하기

### nodeName — 스케줄러 우회 (가장 단순, 강제)
```yaml
spec:
  nodeName: node01
```

### nodeSelector — 레이블 매칭 (가장 흔함)
```bash
kubectl label node node01 disktype=ssd
```
```yaml
spec:
  nodeSelector:
    disktype: ssd
```

### nodeAffinity — 표현식 기반 (nodeSelector의 상위호환)
```yaml
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:      # 필수 조건
        nodeSelectorTerms:
        - matchExpressions:
          - key: disktype
            operator: In                # In | NotIn | Exists | DoesNotExist | Gt | Lt
            values: ["ssd"]
      preferredDuringSchedulingIgnoredDuringExecution:     # 선호 조건 (가중치)
      - weight: 10
        preference:
          matchExpressions:
          - key: zone
            operator: In
            values: ["a"]
```
- `required...` = 만족 못 하면 Pending / `preferred...` = 안 맞아도 배치는 됨
- `IgnoredDuringExecution` = 배치 후 레이블이 바뀌어도 쫓아내지 않음

### podAffinity / podAntiAffinity — 다른 Pod 기준
```yaml
    podAntiAffinity:                    # 같은 앱끼리 다른 노드에 분산
      requiredDuringSchedulingIgnoredDuringExecution:
      - labelSelector:
          matchLabels: { app: web }
        topologyKey: kubernetes.io/hostname     # "같음"의 기준 (노드/존)
```

## 3. Taint와 Toleration — 노드가 Pod를 밀어냄

방향이 반대다: **affinity는 Pod가 노드를 고르고, taint는 노드가 Pod를 거부한다.**

```bash
kubectl taint nodes node01 key1=value1:NoSchedule       # 추가
kubectl taint nodes node01 key1=value1:NoSchedule-      # 제거 (끝에 -)
kubectl describe node node01 | grep Taint               # 확인
```

| effect | 동작 |
|---|---|
| `NoSchedule` | 톨러레이션 없는 새 Pod 스케줄 금지 (기존 Pod 유지) |
| `PreferNoSchedule` | 가능하면 피함 |
| `NoExecute` | 신규 금지 + **기존 Pod도 퇴거** |

```yaml
spec:
  tolerations:
  - key: "key1"
    operator: "Equal"        # Equal(값 비교) | Exists(키 존재만)
    value: "value1"
    effect: "NoSchedule"
  - key: "node-role.kubernetes.io/control-plane"    # 컨트롤 플레인에 띄우기
    operator: "Exists"
    effect: "NoSchedule"
```

> **주의**: toleration은 "그 노드에 갈 수 있게 허용"일 뿐 "그 노드로 보냄"이 아니다. 특정 tainted 노드에 **반드시** 보내려면 toleration + nodeSelector/affinity를 함께 써야 한다.

- 노드 장애 시 자동 taint: `node.kubernetes.io/unreachable:NoExecute` 등 (기본 5분 후 퇴거 — `tolerationSeconds`)

## 4. Static Pod (빈출)

kubelet이 apiserver 없이 `/etc/kubernetes/manifests/`의 YAML을 직접 실행.

```bash
# 해당 노드에 ssh 후
ssh node01
sudo vim /etc/kubernetes/manifests/my-static.yaml    # 파일 생성 = Pod 생성
# 파일 삭제/이동 = Pod 삭제
```
- staticPodPath 확인: `grep staticPodPath /var/lib/kubelet/config.yaml`
- apiserver에는 `<이름>-<노드명>` 형태의 **미러 Pod**로 보인다 (kubectl로 삭제해도 되살아남 — 파일을 지워야 죽는다)
- 시험 유형: "node01에 static pod를 만들어라" → **node01에 ssh해서** 매니페스트 작성. YAML 뼈대는 기본 노드에서 `k run ... $do`로 만들어 복사.

## 5. 우선순위와 선점 — PriorityClass

```yaml
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000           # 높을수록 우선
globalDefault: false
preemptionPolicy: PreemptLowerPriority   # 기본값 (낮은 우선순위 Pod을 쫓아내고 자리 차지)
```
```yaml
# Pod에서
spec:
  priorityClassName: high-priority
```
```bash
kubectl get priorityclass     # system-cluster-critical 등 내장 클래스 존재
```

## 6. 어드미션 기반 제약 (네임스페이스 정책)

### LimitRange — 컨테이너별 기본값/상한
```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-mem-limits
  namespace: dev
spec:
  limits:
  - type: Container
    default:            # limits 미지정 시 기본값
      cpu: 500m
      memory: 256Mi
    defaultRequest:     # requests 미지정 시 기본값
      cpu: 100m
      memory: 128Mi
    max: { cpu: "1", memory: 512Mi }
    min: { cpu: 50m, memory: 64Mi }
```

### ResourceQuota — 네임스페이스 총량 제한
```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: dev-quota
  namespace: dev
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    pods: "20"
```
```bash
kubectl describe quota -n dev      # 사용량/한도 확인
```
- 쿼터 초과 시 Pod 생성이 **어드미션 단계에서 거부**됨 (Pending이 아니라 생성 실패 — 컨트롤러 이벤트에 기록)

## 7. cordon / drain (스케줄링 관점 복습)

```bash
kubectl cordon node01      # SchedulingDisabled — 신규만 차단
kubectl drain node01 --ignore-daemonsets    # 비우기
kubectl uncordon node01
```

## 8. 스케줄링 실패 진단 순서

```bash
kubectl describe pod <pending-pod>    # Events 확인이 90%
```
| 이벤트 메시지 | 원인 |
|---|---|
| Insufficient cpu/memory | requests 대비 노드 여유 부족 |
| node(s) had untolerated taint | taint에 대한 toleration 없음 |
| node(s) didn't match Pod's node affinity/selector | 레이블 불일치 |
| 0/N nodes are available | 위 사유들의 합계 표시 |
| unbound immediate PersistentVolumeClaims | PVC 바인딩 안 됨 (17단원) |

## 9. 체크리스트

- [ ] requests(스케줄링) vs limits(런타임 강제) 차이, 메모리 초과=OOMKilled를 안다
- [ ] nodeSelector와 nodeAffinity(required/preferred)를 쓸 수 있다
- [ ] taint 추가/제거 명령과 3가지 effect를 안다
- [ ] toleration만으로는 배치가 보장되지 않음을 안다
- [ ] static pod의 위치/미러 Pod/삭제 방법을 안다
- [ ] LimitRange와 ResourceQuota의 차이를 안다
- [ ] Pending Pod 진단을 describe 이벤트로 시작한다
