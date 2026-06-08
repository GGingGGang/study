# 리소스·QoS·프로브 (Resources, QoS & Probes)

> 쿠버네티스 · 기본기 심화 · 학습내용: requests/limits(CPU throttling vs OOMKilled), QoS 클래스(Guaranteed/Burstable/BestEffort)와 eviction 순서, LimitRange/ResourceQuota, liveness/readiness/startup 프로브와 파라미터·실패 동작, restartPolicy, graceful shutdown(terminationGracePeriodSeconds)

---

이 문서는 "파드가 자원을 얼마나 쓰고, 살아있는지 어떻게 판단하며, 어떻게 죽는가"를 다룬다. 운영에서 가장 사고가 잦은 영역이라 함정 위주로 자체 완결 정리한다.

## 1. requests와 limits

컨테이너마다 CPU/메모리를 **requests(요청)** 와 **limits(상한)** 로 설정한다.

| 항목 | 의미 | 영향 |
|------|------|------|
| **requests** | 최소 보장량. 스케줄링 기준 | 스케줄러가 이 값을 보고 노드를 고른다(노드 여유 ≥ requests) |
| **limits** | 사용 상한 | 이 이상 못 쓴다. CPU는 throttle, 메모리는 OOMKill |

```yaml
spec:
  containers:
    - name: app
      image: app:1.0
      resources:
        requests:
          cpu: "250m"      # 0.25 코어 보장
          memory: "256Mi"
        limits:
          cpu: "500m"      # 최대 0.5 코어
          memory: "512Mi"  # 512Mi 넘으면 OOMKilled
```

- **CPU 단위**: `1` = 1 코어, `500m` = 0.5 코어(millicore).
- **메모리 단위**: `Mi`(2^20), `Gi`(2^30). `M`/`G`는 10진수라 다르다. 보통 `Mi`/`Gi`를 쓴다.
- **requests만 스케줄링에 쓰인다**. limits는 런타임 cgroup 제한이다. 그래서 requests를 너무 낮게 잡으면 노드가 과밀(overcommit)되어 런타임에 자원 경합이 난다.

### CPU throttling vs 메모리 OOMKilled (★★★ 핵심 차이)

CPU와 메모리는 limit 초과 시 **동작이 완전히 다르다**.

| 자원 | 압축 가능? | limit 초과 시 |
|------|-----------|--------------|
| **CPU** | compressible(압축 가능) | **Throttling**: 속도만 느려짐. 죽지 않음 |
| **Memory** | incompressible(압축 불가) | **OOMKilled**: 컨테이너가 즉시 강제 종료(`exit 137`) |

- **CPU throttling**: limit을 넘으면 커널 CFS가 컨테이너를 주기적으로 멈춘다(쓰로틀). 앱은 죽지 않지만 **지연(latency)이 급증**한다. p99 레이턴시가 튀는데 원인이 안 보이면 CPU throttle을 의심한다.
- **OOMKilled**: 메모리는 회수할 수 없으므로, limit을 넘으면 커널 OOM killer가 컨테이너 프로세스를 죽인다. `kubectl describe pod`에 `Reason: OOMKilled`, 종료코드 137이 찍힌다. restartPolicy에 따라 재시작되며, 반복되면 `CrashLoopBackOff`.

> ★★★ **면접 단골**: "CPU는 compressible이라 limit 초과 시 throttle(느려짐), 메모리는 incompressible이라 OOMKilled(강제 종료)된다. 그래서 메모리 limit은 신중히 잡고, CPU limit은 레이턴시 민감 워크로드에선 빼거나 넉넉히 주기도 한다."

## 2. QoS 클래스와 eviction 순서

requests/limits 설정 조합에 따라 쿠버네티스가 파드에 **QoS(Quality of Service) 클래스**를 자동 부여한다. 이 등급이 **노드 메모리 압박 시 누가 먼저 쫓겨나는가(eviction)** 를 결정한다.

| QoS | 조건 | eviction 우선순위 |
|-----|------|------------------|
| **Guaranteed** | 모든 컨테이너가 CPU·메모리 **requests == limits** (둘 다 설정) | 가장 **마지막**에 쫓겨남(가장 안전) |
| **Burstable** | requests < limits이거나 일부만 설정(Guaranteed/BestEffort 아닌 나머지) | 중간 |
| **BestEffort** | requests/limits **아무것도 설정 안 함** | **가장 먼저** 쫓겨남(가장 위험) |

```yaml
# Guaranteed: requests == limits
resources:
  requests: { cpu: "500m", memory: "512Mi" }
  limits:   { cpu: "500m", memory: "512Mi" }
```

- **노드 자원 압박(특히 메모리)** 이 오면 kubelet이 파드를 **evict(축출)** 한다. 순서는 **BestEffort → Burstable → Guaranteed**. 같은 등급 안에서는 requests 대비 실제 사용량이 많이 초과한 파드가 먼저 쫓겨난다.
- 핵심 워크로드는 **Guaranteed**(requests=limits)로 두면 메모리 압박에 가장 오래 버틴다.
- eviction은 OOMKilled와 다르다. eviction은 **kubelet이 노드 보호를 위해 파드를 통째로 내보내는** 것이고, OOMKilled는 **커널이 컨테이너 프로세스 하나를 죽이는** 것이다. ★

> ★ **함정**: BestEffort 파드는 노드가 조금만 빡빡해져도 1순위로 쫓겨난다. 운영 워크로드에 requests를 안 잡는 것은 사실상 "제일 먼저 버려도 좋다"고 선언하는 것과 같다.

## 3. LimitRange와 ResourceQuota

requests/limits를 **개별 파드가 알아서** 잡으면 누락·과다 설정이 생긴다. 네임스페이스 단위로 강제하는 두 장치가 있다.

| 리소스 | 적용 단위 | 역할 |
|--------|----------|------|
| **LimitRange** | **개별 컨테이너/파드** | 기본값(default) 주입, 최소/최대 한도 강제 |
| **ResourceQuota** | **네임스페이스 합계** | NS 전체의 자원 총량·오브젝트 개수 상한 |

```yaml
# LimitRange: 설정 안 한 컨테이너에 기본 requests/limits를 주입하고 한도 강제
apiVersion: v1
kind: LimitRange
metadata: { name: defaults, namespace: ggang-app }
spec:
  limits:
    - type: Container
      default:        { cpu: "500m", memory: "512Mi" }   # limits 기본값
      defaultRequest: { cpu: "250m", memory: "256Mi" }   # requests 기본값
      max:            { cpu: "2",    memory: "2Gi" }      # 상한
      min:            { cpu: "50m",  memory: "64Mi" }     # 하한
```

```yaml
# ResourceQuota: 네임스페이스 전체 합계 제한
apiVersion: v1
kind: ResourceQuota
metadata: { name: ns-quota, namespace: ggang-app }
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    pods: "50"                # 파드 개수 상한
    count/services: "20"
```

- **함정**: 네임스페이스에 ResourceQuota가 `requests.cpu`/`limits.memory` 같은 항목을 강제하면, **requests/limits를 안 적은 파드는 생성이 거부**된다. 이때 LimitRange로 기본값을 주입하면 사용자가 일일이 안 적어도 통과한다. 둘은 짝으로 쓰는 게 보통이다. ★

## 4. 프로브(Probe): liveness / readiness / startup

kubelet이 컨테이너의 상태를 주기적으로 검사하는 헬스체크다. 세 종류가 **목적이 완전히 다르다**.

| 프로브 | 질문 | 실패 시 동작 |
|--------|------|-------------|
| **liveness** | "**살아있나?**" (정상 동작 중인가) | 컨테이너를 **재시작**(restart) |
| **readiness** | "**트래픽 받을 준비됐나?**" | **Service 엔드포인트에서 제외**(재시작 X) |
| **startup** | "**초기 기동 끝났나?**" | (성공 전까지) liveness/readiness를 **보류** |

검사 방식 3가지: `httpGet`(2xx/3xx면 성공), `tcpSocket`(연결되면 성공), `exec`(명령 exit 0이면 성공). gRPC 헬스체크도 지원(`grpc`).

```yaml
spec:
  containers:
    - name: app
      image: app:1.0
      ports: [{ containerPort: 8080 }]
      readinessProbe:
        httpGet: { path: /readyz, port: 8080 }
        periodSeconds: 5
        failureThreshold: 3
      livenessProbe:
        httpGet: { path: /healthz, port: 8080 }
        periodSeconds: 10
        failureThreshold: 3
      startupProbe:                          # 기동이 느린 앱 보호
        httpGet: { path: /healthz, port: 8080 }
        failureThreshold: 30
        periodSeconds: 10                     # 최대 30*10 = 300초까지 기동 허용
```

### 주요 파라미터

| 파라미터 | 의미 |
|----------|------|
| `initialDelaySeconds` | 컨테이너 시작 후 첫 검사까지 대기 |
| `periodSeconds` | 검사 주기 |
| `timeoutSeconds` | 한 번 검사의 타임아웃 |
| `failureThreshold` | 연속 몇 번 실패해야 "실패" 판정 |
| `successThreshold` | 연속 몇 번 성공해야 "성공" 판정(readiness는 1 초과 가능) |

### 함정과 면접 포인트

> ★★★ **liveness vs readiness 구분**: liveness 실패는 **컨테이너 재시작**, readiness 실패는 **트래픽 차단(엔드포인트 제외)만**. 일시적으로 바빠서 응답이 느린 앱에 liveness를 빡빡하게 걸면 멀쩡한 컨테이너가 계속 재시작되는 **재시작 루프**에 빠진다. "잠깐 부하로 못 받는다"는 readiness로, "회복 불가능하게 망가졌다"는 liveness로 표현해야 한다.

> ★ **startup 프로브의 존재 이유**: 기동이 오래 걸리는 앱(JVM 워밍업, 큰 캐시 로드)에 liveness만 걸면, 기동 중에 liveness가 실패해 무한 재시작된다. **startup 프로브가 성공할 때까지 liveness/readiness를 보류**하므로, 느린 기동을 안전하게 보호한다. `initialDelaySeconds`를 길게 잡는 것보다 startup 프로브가 정석이다.

> ★ **공통 함정**: liveness/readiness가 **같은 의존성(예: DB)** 을 검사하면, DB가 잠깐 끊겼을 때 모든 복제본이 동시에 liveness 실패 → 동시 재시작 → 장애 증폭. liveness는 "프로세스 자체"만 가볍게 검사하는 게 안전하다.

## 5. restartPolicy와 재시작 동작

파드의 `.spec.restartPolicy`가 컨테이너 종료 시 재시작 여부를 정한다.

| 값 | 동작 | 주 용도 |
|----|------|---------|
| **Always**(기본) | 항상 재시작 | Deployment 등 장기 실행 서비스 |
| **OnFailure** | 비정상 종료(exit≠0)만 재시작 | Job(작업 완료형) |
| **Never** | 재시작 안 함 | 일회성 |

- 재시작은 **지수 백오프**(10s, 20s, 40s … 최대 5분)로 점점 늦춰진다. 반복 실패 시 상태가 `CrashLoopBackOff`로 표시된다 — 이건 에러 자체가 아니라 "재시작을 백오프하며 기다리는 중"이라는 뜻이다.
- restartPolicy는 **파드 단위**라 같은 파드의 모든 컨테이너에 동일 적용된다.

## 6. Graceful Shutdown과 terminationGracePeriodSeconds

파드가 종료될 때 갑자기 죽이지 않고 **정리할 시간**을 준다. 무중단 배포의 핵심이다.

### 종료 시퀀스

```
파드 삭제 요청
  │
  ├─▶ ① 파드를 Service 엔드포인트에서 제거(새 트래픽 중단)
  ├─▶ ② preStop 훅 실행(있으면)
  ├─▶ ③ 컨테이너에 SIGTERM 전송  ──┐
  │                                 │ terminationGracePeriodSeconds(기본 30s) 동안 대기
  └─▶ ④ 시간 초과 시 SIGKILL 강제 종료 ┘
```

```yaml
spec:
  terminationGracePeriodSeconds: 45     # SIGTERM 후 최대 45초 유예
  containers:
    - name: app
      image: app:1.0
      lifecycle:
        preStop:
          exec:
            command: ["sh", "-c", "sleep 5"]   # 엔드포인트 전파 대기용
```

- **앱은 SIGTERM을 받아 진행 중 요청을 마무리하고 깔끔히 종료**해야 한다. SIGTERM을 무시하면 결국 SIGKILL로 강제 종료되어 진행 중 요청이 끊긴다.
- **preStop 함정**: 엔드포인트 제거(①)와 SIGTERM(③)은 거의 동시에 비동기로 일어난다. 엔드포인트 제거가 kube-proxy/Istio 등 전 노드에 전파되기 전에 앱이 죽으면, 잠깐 동안 죽은 파드로 트래픽이 가서 502가 난다. 그래서 `preStop`에 짧은 `sleep`(예 5초)을 넣어 **전파될 시간을 벌어주는** 패턴을 흔히 쓴다. ★
- **graceful period가 너무 짧으면**: 긴 요청을 처리 중인 앱이 SIGKILL로 잘려 데이터 유실/끊김. 워크로드 특성에 맞게 늘린다.

> ★★★ **면접 단골**: "파드 종료는 ① 엔드포인트 제거 → ② preStop → ③ SIGTERM → (유예시간 후) ④ SIGKILL 순서다. 앱이 SIGTERM을 처리해 진행 요청을 마무리하고, preStop sleep으로 엔드포인트 전파 지연을 흡수해야 무중단 종료가 된다."

### 한 줄 요약
**requests**(스케줄링 기준·최소 보장) / **limits**(상한)를 잡되, CPU 초과는 **throttle**, 메모리 초과는 **OOMKilled**로 동작이 다르다. requests/limits 조합이 **QoS**(Guaranteed>Burstable>BestEffort)를 정하고 이게 **eviction 순서**를 결정한다. **LimitRange/ResourceQuota**로 네임스페이스 차원에서 강제한다. **liveness(재시작)·readiness(트래픽 차단)·startup(기동 보호)** 는 목적이 다르며 혼동하면 재시작 루프에 빠진다. 종료는 **엔드포인트 제거→preStop→SIGTERM→SIGKILL** 순서로, **terminationGracePeriodSeconds**와 preStop으로 무중단 종료를 만든다.

### 참고 (공식 문서)
- 컨테이너 리소스 관리: https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/
- 파드 QoS 클래스: https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/
- 노드 압박 축출(eviction): https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/
- LimitRange / ResourceQuota: https://kubernetes.io/docs/concepts/policy/resource-quotas/
- Liveness/Readiness/Startup 프로브: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- 파드 종료(graceful shutdown): https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination
