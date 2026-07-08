# 09. 워크로드 — Deployment와 롤링 업데이트

> 도메인: 워크로드와 스케줄링 (15%)
> 시험 포인트: 롤링 업데이트/롤백, 프로브(자가치유), Job/CronJob. "견고하고 자가치유되는 배포 프리미티브 이해"가 커리큘럼 문구.

---

## 1. 워크로드 리소스 지도

| 리소스 | 용도 |
|---|---|
| **Pod** | 최소 실행 단위 (직접 쓰는 일은 드묾) |
| **ReplicaSet** | Pod 복제본 수 유지 (Deployment가 관리하므로 직접 안 만듦) |
| **Deployment** | 무상태 앱 표준. 롤링 업데이트/롤백 제공 |
| **StatefulSet** | 상태 유지 앱. 고정된 이름/스토리지/순서 |
| **DaemonSet** | 모든(또는 선택된) 노드에 1개씩 (로그 수집기, CNI 등) |
| **Job** | 완료를 목표로 하는 일회성 작업 |
| **CronJob** | 스케줄에 따라 Job 생성 |

## 2. Pod 핵심

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: web
  labels:
    app: web
spec:
  containers:
  - name: nginx
    image: nginx:1.27
    ports:
    - containerPort: 80
    env:
    - name: MODE
      value: "prod"
    resources:
      requests: { cpu: 100m, memory: 128Mi }
      limits:   { cpu: 500m, memory: 256Mi }
  restartPolicy: Always        # Always(기본) | OnFailure | Never
```

### Init 컨테이너
앱 컨테이너 **시작 전에 순서대로** 완료돼야 하는 준비 작업.
```yaml
spec:
  initContainers:
  - name: wait-db
    image: busybox
    command: ['sh', '-c', 'until nslookup db; do sleep 2; done']
  containers:
  - ...
```

### 사이드카 컨테이너 (v1.33 GA)
init 컨테이너에 `restartPolicy: Always`를 주면 **앱과 함께 계속 실행되는 사이드카**가 된다 (로그 수집 등).
```yaml
  initContainers:
  - name: log-shipper
    image: fluent-bit
    restartPolicy: Always      # 이것이 사이드카를 만드는 스위치
```

## 3. 자가치유(self-healing) — 프로브

| 프로브 | 실패 시 동작 | 용도 |
|---|---|---|
| **livenessProbe** | 컨테이너 **재시작** | 죽었는데 프로세스만 살아있는 상태 감지 |
| **readinessProbe** | **Service에서 제외** (재시작 안 함) | 트래픽 받을 준비 여부 |
| **startupProbe** | 성공할 때까지 다른 프로브 지연 | 기동이 느린 앱 보호 |

```yaml
    livenessProbe:
      httpGet: { path: /healthz, port: 8080 }
      initialDelaySeconds: 5
      periodSeconds: 10
      failureThreshold: 3
    readinessProbe:
      tcpSocket: { port: 8080 }
      periodSeconds: 5
    startupProbe:
      exec:
        command: ["cat", "/tmp/ready"]
      failureThreshold: 30
      periodSeconds: 10
```
- 방식 3종: `httpGet`, `tcpSocket`, `exec` (+`grpc`)
- readiness 실패 → Endpoints에서 빠짐 → "Service가 응답 안 함" 트러블슈팅의 단골 원인

## 4. Deployment

```bash
kubectl create deploy web --image=nginx:1.26 --replicas=3 $do > d.yaml
```
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  selector:
    matchLabels:
      app: web          # ← template.labels와 반드시 일치 (불일치 = 생성 거부)
  strategy:
    type: RollingUpdate  # 또는 Recreate (전부 죽이고 새로)
    rollingUpdate:
      maxSurge: 25%        # 초과 생성 허용량 (기본 25%)
      maxUnavailable: 25%  # 동시 중단 허용량 (기본 25%)
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
      - name: nginx
        image: nginx:1.26
```

- `maxSurge: 1, maxUnavailable: 0` → 무중단 보수적 배포
- `Recreate` → 구버전과 신버전이 공존하면 안 되는 앱

## 5. 롤링 업데이트와 롤백 (빈출)

```bash
# 업데이트 트리거 (템플릿 변경)
kubectl set image deploy/web nginx=nginx:1.27
# 또는 kubectl edit deploy web

# 진행 상태
kubectl rollout status deploy/web
kubectl rollout pause deploy/web          # 일시정지
kubectl rollout resume deploy/web

# 이력
kubectl rollout history deploy/web
kubectl rollout history deploy/web --revision=2    # 특정 리비전 상세

# 롤백
kubectl rollout undo deploy/web                    # 직전 리비전으로
kubectl rollout undo deploy/web --to-revision=1    # 특정 리비전으로

# 재기동 (이미지 그대로 Pod만 갈아끼움)
kubectl rollout restart deploy/web
```

- 리비전 보존 개수: `spec.revisionHistoryLimit` (기본 10)
- history의 CHANGE-CAUSE를 남기려면: `kubectl annotate deploy/web kubernetes.io/change-cause="nginx 1.27로 업데이트"`

## 6. DaemonSet

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-agent
  namespace: kube-system
spec:
  selector:
    matchLabels: { app: log-agent }
  template:
    metadata:
      labels: { app: log-agent }
    spec:
      tolerations:                       # 컨트롤 플레인에도 띄우려면
      - key: node-role.kubernetes.io/control-plane
        effect: NoSchedule
      containers:
      - name: agent
        image: fluent-bit
```
- 명령형 생성 명령이 없으므로: `kubectl create deploy ... $do`로 만들고 kind를 DaemonSet으로 고친 뒤 `replicas`/`strategy` 삭제.

## 7. Job / CronJob

```bash
kubectl create job calc --image=perl -- perl -e 'print 3.14'
kubectl create cronjob backup --image=busybox --schedule="0 2 * * *" -- sh -c 'echo backup'
```
```yaml
apiVersion: batch/v1
kind: Job
spec:
  completions: 5        # 총 성공 횟수
  parallelism: 2        # 동시 실행 수
  backoffLimit: 4       # 재시도 한도 (초과 시 Job Failed)
  activeDeadlineSeconds: 120   # 전체 제한시간
  template:
    spec:
      restartPolicy: Never     # Job은 Never 또는 OnFailure만 가능
      containers: [...]
```
```yaml
apiVersion: batch/v1
kind: CronJob
spec:
  schedule: "*/5 * * * *"          # 분 시 일 월 요일
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  concurrencyPolicy: Forbid        # Allow(기본) | Forbid | Replace
  jobTemplate:
    spec:                          # ← Job의 spec이 이 아래에
      template:
        spec:
          restartPolicy: Never
          containers: [...]
```

## 8. StatefulSet (개념 위주)

- Pod 이름 고정(`web-0, web-1, ...`), 순서 보장, Pod마다 전용 PVC(`volumeClaimTemplates`)
- **Headless Service**(`clusterIP: None`)와 함께 사용 — Pod별 DNS: `web-0.svc명.ns.svc.cluster.local`
- CKA에서는 깊게 안 나오지만 개념 문제로 등장 가능

## 9. 체크리스트

- [ ] liveness/readiness/startup 프로브의 실패 시 동작 차이를 안다
- [ ] rollout status/history/undo/restart를 안 보고 쓸 수 있다
- [ ] maxSurge/maxUnavailable의 의미를 안다
- [ ] selector.matchLabels ↔ template.labels 일치 규칙을 안다
- [ ] Job의 completions/parallelism/backoffLimit, CronJob의 schedule 형식을 안다
- [ ] init 컨테이너 vs 사이드카(restartPolicy: Always) 차이를 안다
