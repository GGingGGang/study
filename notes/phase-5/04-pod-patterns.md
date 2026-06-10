# Pod 패턴 (Probes + Graceful Shutdown + Topology Spread)

## 1. Why — 왜 쓰는가

운영 환경에서 Pod이 안정적으로 동작하기 위한 4가지 핵심 패턴. 단일 학습 주제는 아니지만 면접에서 가장 자주 묻고 본 프로젝트의 신뢰성을 결정.

**기본 Deployment의 문제**:
- Pod이 트래픽을 받을 준비가 안 됐는데 Service에 등록되어 5xx 발생
- 컨테이너가 deadlock 걸려도 알 수 없음 → 좀비 상태로 트래픽 받음
- Pod 종료 시 in-flight 요청 손실
- Rolling update 중 여러 replica가 같은 노드에 몰려 노드 장애 시 가용성 0%

**4가지 패턴의 해결**:
1. **Probes**: liveness(살아있나) + readiness(준비됐나) + startup(시작 끝났나) 분리 체크
2. **Graceful shutdown**: SIGTERM 핸들링 + preStop sleep으로 in-flight 요청 처리
3. **Topology Spread / Anti-affinity**: replica를 노드에 분산
4. **PodDisruptionBudget (PDB)**: voluntary disruption 시 가용성 보장

## 2. Architecture — 어떻게 구성되는가

이건 도구가 아니라 **패턴**이라 별도 컴포넌트 없음. 모든 게 Pod spec의 일부.

**Probes 3종**:
- **livenessProbe**: 실패 시 컨테이너 재시작. 자기 자신만 체크.
- **readinessProbe**: 실패 시 Service endpoint에서 제외. 외부 의존성 체크.
- **startupProbe**: 시작 느린 앱용. 통과 전까지 liveness 안 함.

**종료 흐름**:
1. Pod 삭제 요청 → API server가 deletionTimestamp 설정
2. 동시에 진행:
   - kubelet이 컨테이너에 SIGTERM 전송
   - Service controller가 Endpoint에서 Pod 제거 (트래픽 차단)
3. `preStop` hook 실행 (선택)
4. `terminationGracePeriodSeconds` (default 30초) 대기
5. 시간 끝나면 SIGKILL

**Topology Spread**:
- `topologySpreadConstraints`: 노드/zone/region 등 topology key 기준으로 균등 분배
- `podAntiAffinity`: 특정 label의 Pod 회피

## 3. Mechanism — 어떻게 돌아가는가

**Probe 동작**:
- kubelet이 주기적(`periodSeconds`)으로 probe 실행
- `failureThreshold` 연속 실패 시 액션
- HTTP/TCP/exec/gRPC 4가지 type

**Liveness vs Readiness 책임 분리 예시** (Login Server):
- `/livez`: HTTP 200 즉시 반환. 자기 자신만 본다. 프로세스 deadlock 감지.
- `/readyz`: MySQL ping + Redis ping. 의존성 중 하나라도 죽으면 503.
- `/startupz`: 초기화 완료(DB connection pool 생성, config load) 시 200.

**Graceful shutdown 예시**:

```yaml
terminationGracePeriodSeconds: 30
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 5"]    # 5초 대기
```

흐름:
1. Pod 삭제 시작
2. preStop sleep 5초 → 그동안 Service controller가 endpoint 갱신 (kube-proxy iptables 룰 업데이트 ~3-5초 소요)
3. SIGTERM 전송 → 앱이 받아서 graceful shutdown 시작
4. 앱이 in-flight 요청 완료 + 새 요청 거부
5. 25초 안에 안 끝나면 SIGKILL

**Topology Spread 동작**:
- Scheduler가 Pod 배치 시 모든 노드의 매칭 Pod 수 계산
- `maxSkew=1`이면 노드 간 Pod 수 차이가 1 이하 유지
- 위반하는 노드는 스케줄링 제외 (DoNotSchedule) 또는 가능하면 회피 (ScheduleAnyway)

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 패턴 적용 위치.

- **모든 앱 Pod** (Login/Core/Batch): 4가지 패턴 전부 적용
- **인프라 컴포넌트**: 대부분 Helm chart가 기본 적용 (ArgoCD, Jenkins 등). 일부 수동 보강.
- **Service** — readiness 통과한 Pod만 endpoint에 포함
- **Istio** — Ambient ztunnel이 readiness 통과 후에야 트래픽 라우팅
- **HPA** — readiness 통과 Pod만 메트릭 계산에 포함

## 5. Usage — 어떻게 쓰는가

**완전한 Pod spec 예시** (Login Server):

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
      serviceAccountName: login
      
      # 노드 분산
      topologySpreadConstraints:
      - maxSkew: 1
        topologyKey: kubernetes.io/hostname
        whenUnsatisfiable: DoNotSchedule
        labelSelector:
          matchLabels:
            app: login
      
      # 종료 grace period
      terminationGracePeriodSeconds: 30
      
      containers:
      - name: login
        image: ghcr.io/myorg/login:abc123
        ports:
        - name: http
          containerPort: 8080
        - name: metrics
          containerPort: 9090
        
        # Probes
        livenessProbe:
          httpGet:
            path: /livez
            port: 9090
          periodSeconds: 10
          timeoutSeconds: 2
          failureThreshold: 3
          # initialDelaySeconds 없음 (startup probe로 대체)
        
        readinessProbe:
          httpGet:
            path: /readyz
            port: 9090
          periodSeconds: 5
          timeoutSeconds: 2
          failureThreshold: 2
          successThreshold: 1
        
        startupProbe:
          httpGet:
            path: /startupz
            port: 9090
          periodSeconds: 3
          failureThreshold: 20        # 60초 startup 허용
        
        # Graceful shutdown
        lifecycle:
          preStop:
            exec:
              command: ["/bin/sh", "-c", "sleep 5"]
        
        # 자원
        resources:
          requests: { cpu: 100m, memory: 64Mi }
          limits: { cpu: 500m, memory: 128Mi }
        
        # Security
        securityContext:
          runAsNonRoot: true
          runAsUser: 1000
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop: ["ALL"]
```

**PodDisruptionBudget**:

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: login
  namespace: app
spec:
  minAvailable: 1                    # 최소 1개는 살아있어야 함
  selector:
    matchLabels:
      app: login
```

**앱 측 구현** (Go Login Server):

```go
import (
    "context"
    "net/http"
    "os"
    "os/signal"
    "syscall"
    "time"
)

func main() {
    // Readiness state
    ready := atomic.Bool{}
    
    // HTTP server
    mux := http.NewServeMux()
    mux.HandleFunc("/livez", func(w http.ResponseWriter, r *http.Request) {
        w.WriteHeader(http.StatusOK)   // 프로세스만 체크
    })
    mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
        if !ready.Load() {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        // MySQL + Redis ping
        if err := db.PingContext(r.Context()); err != nil {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        if err := redis.Ping(r.Context()).Err(); err != nil {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    })
    mux.HandleFunc("/startupz", func(w http.ResponseWriter, r *http.Request) {
        if !ready.Load() {
            w.WriteHeader(http.StatusServiceUnavailable)
            return
        }
        w.WriteHeader(http.StatusOK)
    })
    
    srv := &http.Server{Addr: ":8080", Handler: mux}
    
    // 시작 작업 (DB connection pool 등)
    initApp(ctx)
    ready.Store(true)
    
    // Graceful shutdown
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
    
    go func() {
        srv.ListenAndServe()
    }()
    
    <-stop
    ready.Store(false)               // readiness 실패 시작
    
    // 5초 grace (preStop 동안 endpoint 갱신 대기)
    time.Sleep(5 * time.Second)
    
    // In-flight 요청 완료 대기
    ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
    defer cancel()
    srv.Shutdown(ctx)
}
```

## 6. Configuration — 어떤 설정이 있는가

**Probe 옵션**:
- `initialDelaySeconds`: 첫 probe 전 대기 (startupProbe 사용 시 0)
- `periodSeconds`: probe 주기
- `timeoutSeconds`: probe 응답 대기 (default 1s, P99 latency보다 약간 큰 값 권장)
- `failureThreshold`: 연속 실패 임계값
- `successThreshold`: 회복 판정 횟수 (liveness/startup은 1만 가능)

**Probe type 4가지**:
- `httpGet`: HTTP GET. 본 프로젝트 표준.
- `tcpSocket`: TCP connect만. 단순 port check.
- `exec`: 컨테이너 안에서 명령 실행. 무거움.
- `grpc`: gRPC health check protocol (k8s 1.27+ stable)

**Graceful shutdown 옵션**:
- `terminationGracePeriodSeconds`: 30 (default), 60-90 권장 (DB query 긴 경우)
- `preStop.exec.command`: sleep, drain script 등
- `preStop.httpGet`: HTTP 호출

**Topology spread 옵션**:
- `topologyKey`: `kubernetes.io/hostname` (노드), `topology.kubernetes.io/zone` (AZ), `topology.kubernetes.io/region` (리전)
- `maxSkew`: 노드 간 Pod 수 차이 허용
- `whenUnsatisfiable`: `DoNotSchedule`(강제) vs `ScheduleAnyway`(soft)

**PDB**:
- `minAvailable`: 최소 가용 Pod 수
- `maxUnavailable`: 최대 다운 가능 Pod 수
- voluntary disruption(drain 등)에만 적용. 노드 장애 같은 involuntary disruption 보호 안 됨.

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.25+** (모든 패턴 stable)
- **gRPC probe**: 1.27+ stable
- **topologySpreadConstraints**: 1.25+ stable
- **PDB**: `policy/v1` 사용 (`policy/v1beta1`은 deprecated)

## 8. 면접 예상 질문 & 답변

**Q1. liveness, readiness, startup probe 차이 다 설명해주세요.**
> liveness는 "프로세스가 살아있는가" 체크입니다. 실패하면 컨테이너 재시작합니다. 자기 자신만 보고 외부 의존성은 안 봅니다. 예: HTTP 200 즉시 반환. readiness는 "트래픽 받을 준비됐는가"입니다. 실패하면 Service endpoint에서 제외되어 트래픽이 안 옵니다. 외부 의존성(DB, Redis, Kafka) 체크합니다. startup은 "초기화 끝났는가"입니다. 통과 전까지 liveness/readiness가 동작 안 합니다. Java처럼 시작 느린 앱(60초+)에 필수. 본 프로젝트는 모든 앱에 셋 다 분리 구현합니다.

**Q2. liveness가 DB ping 같은 거 하면 안 되는 이유는?**
> DB가 일시적으로 끊겼는데 liveness가 실패하면 컨테이너 재시작합니다. 재시작해도 DB가 안 살아있으면 또 실패해서 CrashLoopBackOff가 됩니다. DB 일시 장애가 앱 재시작으로 악화됩니다. liveness는 프로세스 자체 deadlock 같은 자기 문제만 봐야 합니다. DB ping은 readiness에 두면 Service endpoint에서 빠질 뿐 재시작은 안 됩니다 — DB 복구되면 자동으로 endpoint에 다시 추가됩니다.

**Q3. preStop sleep 5초가 왜 필요해요?**
> Pod 삭제 시 두 일이 동시에 일어납니다: (1) Service controller가 endpoint에서 Pod IP 제거, (2) kubelet이 SIGTERM 전송. 문제는 (1)이 kube-proxy의 iptables 룰 업데이트까지 ~3-5초 걸리는데 (2)는 즉시라, SIGTERM 받자마자 앱이 종료를 시작하지만 외부 트래픽은 아직 도착할 수 있습니다 — 그 요청들이 connection reset 받습니다. preStop sleep 5초는 SIGTERM 보내기 전 5초 대기해서 endpoint 갱신이 완료되도록 합니다. 이 시간 동안 새 트래픽은 안 오고 in-flight 요청만 처리됩니다.

**Q4. terminationGracePeriodSeconds를 어떻게 정해요?**
> P99 응답 시간 + 5초 마진을 기준으로 합니다. 본 프로젝트 앱은 P99 latency 1초 정도라 30초가 충분합니다. 만약 DB query가 10초 걸리는 backend job이면 60초 이상 잡아야 합니다. 너무 짧으면 in-flight 요청 손실, 너무 길면 rolling update가 느려집니다. Java 같은 GC 있는 언어는 graceful shutdown이 더 오래 걸려 60-90초 권장. 본 프로젝트는 Go 기준 30초로 시작하고 측정 후 조정.

**Q5. topologySpreadConstraints와 podAntiAffinity 차이는?**
> topologySpread는 더 새로운 (k8s 1.18+) API로 균등 분배가 본질입니다. `maxSkew=1`이면 노드별 Pod 수 차이가 1 이하 유지됩니다. podAntiAffinity는 더 오래된 (k8s 1.6+) API로 회피 본질입니다. "같은 label의 Pod이 있는 노드는 피하기"를 표현합니다. topologySpread가 더 표현력 있고 균등성이 명확해서 신규 프로젝트 권장입니다. 본 프로젝트는 topologySpread만 사용합니다.

**Q6. PodDisruptionBudget이 뭐고 왜 필요해요?**
> 운영자가 `kubectl drain` 같은 voluntary disruption을 할 때, 한 번에 너무 많은 Pod이 동시 다운되는 것을 막는 메커니즘입니다. `minAvailable: 1`이면 같은 selector의 Pod이 항상 1개 이상 살아있게 강제됩니다. drain이 PDB 위반하면 kubectl drain이 기다립니다. 단 노드 장애 같은 involuntary disruption은 PDB가 보호 못 합니다 — 그건 replica 수 + topologySpread로 방어합니다. 본 프로젝트는 모든 service에 PDB 적용.

**Q7. readiness probe failureThreshold를 짧게 하면 안 좋아요?**
> 너무 짧으면 일시적 응답 지연에 과민 반응해서 trafic이 oscillation 합니다. 예: failureThreshold=1 + periodSeconds=1이면 1초 응답 늦으면 즉시 endpoint에서 제외. 다른 Pod에 부하 몰리고, 다음 probe 1초 후 다시 ready로 복귀하는 oscillation. 본 프로젝트는 readiness failureThreshold=2 + periodSeconds=5라 10초 동안 2회 실패해야 endpoint 제외, 적당한 hysteresis.

**Q8. probe의 timeoutSeconds를 어떻게 정해요?**
> 정상 응답 P99 latency보다 약간 큰 값입니다. 본 프로젝트 /livez는 즉시 응답이라 timeout 2초로 충분합니다. /readyz는 DB ping 포함이라 P99 200ms 정도, timeout 2초도 충분. 너무 짧으면 false negative(정상인데 timeout으로 실패) 발생, 너무 길면 진짜 deadlock 감지 늦어집니다. 측정 기반으로 조정.

**Q9. SIGTERM 처리 안 하면 어떻게 돼요?**
> SIGTERM 받자마자 컨테이너가 즉시 종료됩니다. 그 시점에 진행 중이던 HTTP 요청은 connection reset, DB transaction은 rollback, Kafka commit 안 된 메시지는 재처리됩니다. 결제 같은 critical 비즈니스 로직에서 결제 진행 중 SIGKILL 받으면 데이터 불일치 가능. Go는 `signal.Notify`로 핸들링, Java는 shutdown hook으로 처리. 본 프로젝트는 모든 앱에 signal handler + graceful shutdown 표준 패턴 강제합니다.

**Q10. gRPC probe vs HTTP probe 어떤 거 써요?**
> 본 프로젝트는 HTTP를 씁니다. gRPC probe(k8s 1.27+ stable)는 gRPC health checking protocol을 구현해야 하고, debugging 시 curl로 안 됩니다(grpcurl 필요). HTTP /livez, /readyz는 단순하고 어느 도구로든 테스트 가능합니다. gRPC-only 서비스(예: 내부 RPC만 쓰는 마이크로서비스)라도 운영 endpoint는 HTTP로 분리하는 게 보통이고 본 프로젝트 표준입니다.

**Q11. topologySpreadConstraints maxSkew=1이 너무 빡빡하지 않나요?**
> 노드 2개 환경에서 replica 2개면 maxSkew=1이라 1-1 분배 강제. replica 3개면 2-1 분배. 노드 3개로 늘면 replica 6개를 2-2-2로 분배. 빡빡하지 않습니다. 본 프로젝트는 `whenUnsatisfiable: DoNotSchedule`로 강제하는데, 노드 1개만 살아있는 상황(노드 1개 maintenance 등)에서는 Pod이 schedule 못 되어 pending됩니다. 이게 의도된 동작 — 노드 하나만 살아있으면 모든 replica가 거기 몰려서 노드 죽으면 전멸이라 차라리 pending이 안전.

**Q12. 본 프로젝트에서 가장 흔한 Pod 패턴 실수는 뭐예요?**
> 세 가지가 가장 흔합니다. (1) liveness에 외부 의존성 체크 — DB 일시 장애가 앱 무한 재시작으로 악화. (2) graceful shutdown 미구현 — rolling update마다 connection reset. (3) topology spread 누락 — 두 replica가 같은 노드에 몰려 노드 죽으면 가용성 0%. 본 프로젝트의 Pod 패턴 template은 이 셋을 모두 방어합니다. 면접에서 자주 묻는 영역이라 직접 manifest 보여주면서 설명할 수 있어야 합니다.
