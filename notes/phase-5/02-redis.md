# Redis

## 1. Why — 왜 쓰는가

In-memory key-value store. 캐시 / 세션 / 분산 lock / rate limiting / queue 등 다용도.

**왜 캐시가 필요한가**:
- DB query 매 요청마다 = 응답 느림 + DB 부담
- 같은 query 결과를 메모리에 1ms 이내 응답으로 빼두면 latency 100x 개선
- 토스 스택 핵심 컴포넌트

**Redis의 용도 5가지**:
1. **Cache**: DB query 결과 캐싱
2. **Session store**: JWT, 로그인 세션
3. **Rate limiting**: API 요청 제한 (INCR + TTL)
4. **Distributed lock**: SETNX 또는 Redlock
5. **Queue**: Pub/Sub, Stream (Kafka보다 가벼움)

**대체재**:
- **Memcached**: 더 단순. 자료구조 없음. Redis보다 약함.
- **Hazelcast / Apache Ignite**: Java 기반 IMDG. 복잡.
- **Dragonfly**: Redis-compatible. 더 빠르고 적은 메모리. 신생.
- **Valkey**: Redis fork (라이선스 변경 후). Linux Foundation.

**Redis 라이선스 이슈** (2024.03):
- Redis Inc가 BSL/SSPL로 라이선스 변경 → AWS, Google 등이 Valkey fork
- Valkey는 BSD 라이선스 유지
- 본 프로젝트는 Redis 사용 (Helm chart 성숙도) 또는 Valkey로 마이그레이션 가능. 둘 다 API 호환.

## 2. Architecture — 어떻게 구성되는가

**배포 모드 3가지**:

1. **Standalone (Single instance)**: 1개 Redis. 본 프로젝트 선택.
2. **Sentinel (HA)**: master 1개 + replica N개 + sentinel 3개. master 다운 시 sentinel이 replica를 master로 promote. RAM ~800MB.
3. **Cluster (sharding)**: 노드 3+ + 자동 sharding. 6+ 노드 권장. 본 환경 불가.

**본 프로젝트 Standalone + AOF + PV** 선택 이유:
- Always Free RAM 제약 (Sentinel은 ~800MB, Cluster는 더 큼)
- 단일 인스턴스도 AOF persistence로 데이터 복구 가능
- 캐시 손실 영향이 비즈니스 중단 아님 (재로그인 강제 등)

**Persistence 옵션**:
- **RDB**: 주기적 스냅샷 (예: 5분마다). 빠르나 마지막 스냅샷 이후 데이터 손실 가능.
- **AOF**: 모든 write 명령을 로그로 기록. 거의 손실 없음. 디스크 더 사용.
- **AOF + RDB 병용**: 둘 다 켜기. 본 프로젝트 권장.

## 3. Mechanism — 어떻게 돌아가는가

**Single-threaded I/O model**:
- Redis는 기본적으로 single-threaded (6.0+은 I/O multithreading 일부 지원)
- 따라서 한 명령이 오래 걸리면 다른 명령이 block — `KEYS *` 같은 O(N) 명령 절대 금지
- 대안: `SCAN` (cursor 기반, non-blocking)

**Memory management**:
- `maxmemory` 설정 시 eviction policy 적용
- `allkeys-lru`: 가장 오래 안 쓴 키 삭제 (캐시 패턴)
- `volatile-lru`: TTL 있는 키 중 LRU
- `noeviction`: 가득 차면 write 거부 (default)

**AOF 동작**:
1. Client가 write 명령 (예: SET key value)
2. Redis가 명령을 AOF 버퍼에 추가
3. `appendfsync` 정책에 따라 디스크 sync:
   - `always`: 매 명령마다 fsync (안전, 느림)
   - `everysec`: 1초마다 fsync (권장, 1초 손실 가능)
   - `no`: OS에 위임
4. AOF 파일이 너무 커지면 rewrite (현재 상태를 최소 명령으로 압축)

**재기동 시**:
1. Redis 시작
2. AOF 파일 존재하면 모든 명령 재실행 → 메모리 복원
3. 또는 RDB 스냅샷 load
4. 클라이언트 요청 수신 시작

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Redis 의존 관계.

- **app namespace** — Bitnami Redis Helm chart 설치
- **앱 (Login)** — JWT/세션 캐싱
- **앱 (Core)** — API 응답 캐싱
- **Block Volume PV** — AOF 데이터 저장 (5GB)
- **Prometheus** — Redis exporter sidecar로 메트릭 수집
- **Vault** (Phase 6) — Redis password 주입
- **Istio mTLS** — Ambient 모드 ztunnel이 자동 mTLS. Redis 자체 TLS는 비활성화.

## 5. Usage — 어떻게 쓰는가

**설치** (Bitnami Helm chart):

```bash
helm install redis bitnami/redis \
  --namespace app \
  --version 20.x \
  -f redis-values.yaml
```

redis-values.yaml:
```yaml
architecture: standalone        # Sentinel/Cluster 대신

auth:
  enabled: true
  existingSecret: redis-auth     # Vault Agent Injector로 주입
  existingSecretPasswordKey: password

master:
  persistence:
    enabled: true
    storageClass: oci-bv
    size: 5Gi
  configuration: |
    maxmemory 200mb
    maxmemory-policy allkeys-lru
    appendonly yes               # AOF 활성화
    appendfsync everysec         # 1초마다 디스크 sync
    save 900 1                   # RDB도 병용 (15분에 1개 이상 변경 시)
    save 300 10
  resources:
    requests: { cpu: 50m, memory: 128Mi }
    limits: { cpu: 200m, memory: 256Mi }

metrics:
  enabled: true                  # Prometheus exporter sidecar
  serviceMonitor:
    enabled: true
    labels:
      release: prometheus

# Disable replica (standalone)
replica:
  replicaCount: 0
```

**Secret 생성** (Phase 6 전까지는 plain Secret):

```bash
kubectl create secret generic redis-auth -n app \
  --from-literal=password=<strong-random>
```

**앱에서 사용** (Go 예시):

```go
import "github.com/redis/go-redis/v9"

rdb := redis.NewClient(&redis.Options{
    Addr:     "redis-master.app.svc.cluster.local:6379",
    Password: os.Getenv("REDIS_PASSWORD"),
    DB:       0,
})

// Set with TTL
rdb.Set(ctx, "user:123:session", token, 30*time.Minute)

// Get
val, err := rdb.Get(ctx, "user:123:session").Result()

// Increment for rate limiting
count, err := rdb.Incr(ctx, "rate:user:123").Result()
if count == 1 {
    rdb.Expire(ctx, "rate:user:123", time.Minute)
}
```

**자주 쓰는 명령**:

```redis
SET key value EX 300              # 300초 TTL
GET key
DEL key
EXPIRE key 300                    # TTL 변경
TTL key                           # 남은 TTL
INCR counter                      # 정수 +1
HSET user:123 name "Alice" age 30 # Hash
HGET user:123 name
LPUSH queue:tasks "task1"         # List push
RPOP queue:tasks                  # List pop
SADD tags:user:123 "tag1"         # Set
SMEMBERS tags:user:123
ZADD leaderboard 100 "user1"      # Sorted set
ZRANGE leaderboard 0 9 WITHSCORES # Top 10
```

**Pub/Sub**:
```redis
SUBSCRIBE channel:notifications
PUBLISH channel:notifications "new message"
```

**Stream** (Kafka 대안, 가벼움):
```redis
XADD events * type login user 123
XREAD STREAMS events $
```

## 6. Configuration — 어떤 설정이 있는가

**maxmemory 정책**:
- `allkeys-lru`: 본 프로젝트. 캐시 용도.
- `allkeys-lfu`: Least Frequently Used. LRU보다 정확.
- `volatile-lru`: TTL 있는 키만 LRU 대상
- `noeviction`: 가득 차면 write 거부 (session store 등 손실 안 되는 데이터)

**AOF 옵션**:
- `appendfsync everysec`: 1초마다 sync. 본 프로젝트 표준.
- `appendfsync always`: 매 명령마다. 매우 느림.
- `auto-aof-rewrite-percentage 100`: AOF가 base 대비 100% 증가하면 rewrite

**RDB 옵션**:
- `save 900 1`: 15분에 1개 이상 변경 시 스냅샷
- `save 300 10`: 5분에 10개 이상
- 여러 조건 OR

**Network**:
- `bind`: listen IP
- `protected-mode`: localhost 외 거부 (k8s에선 비활성화)
- `requirepass`: 비밀번호 (auth 사용)

**Slowlog**:
- `slowlog-log-slower-than 10000`: 10ms 이상 명령 기록 (microsecond 단위)
- `SLOWLOG GET 10`: 최근 10개 느린 명령

**Replication** (Sentinel/Cluster 사용 시만):
- `replica-priority`: failover 우선순위
- `min-replicas-to-write`: write 받기 위한 최소 replica 수

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Redis 7.x** (2026-05 권장. 7.4+ stable)
- **Valkey 7.x+**: Redis 7 API 호환. 마이그레이션 가능
- **Bitnami Helm chart**: standalone/sentinel/cluster 모두 지원
- **Kubernetes 1.27+**
- **PV 호환**: AOF는 어떤 storage에서도 동작. OCI Block Volume 정합.
- **ARM64**: Redis official image ARM64 multi-arch 지원

## 8. 면접 예상 질문 & 답변

**Q1. Redis 단일 인스턴스 골랐는데 HA 안 한 이유는?**
> Always Free 24GB RAM 환경 제약입니다. Sentinel은 master 1 + replica 1 + sentinel 3 = 5 Pod에 ~800MB 필요하고, Cluster는 노드 6개 이상 권장이라 본 환경에선 아예 불가능합니다. 단일 인스턴스 + AOF + PV 백업으로 가는데, 캐시 손실의 비즈니스 영향이 critical 아니라는 전제(JWT 캐시 손실 → 재로그인 강제 정도)입니다. 면접에서 "production은 Sentinel 또는 Cluster 권장, 본 환경은 자원 한계로 단일 + AOF + Velero 백업 전략"이라 답합니다.

**Q2. RDB와 AOF 차이는?**
> RDB는 주기적으로 메모리 전체 스냅샷을 디스크에 저장하는 방식이라 빠르고 디스크 효율적이지만 마지막 스냅샷 이후 데이터 손실 가능합니다. AOF는 모든 write 명령을 로그로 기록해서 거의 손실 없이 복구 가능하나 디스크 사용량과 disk I/O가 더 큽니다. 본 프로젝트는 **둘 다 활성화** — AOF가 primary, RDB는 보조. AOF의 appendfsync을 everysec로 두면 최대 1초 손실, 디스크 부담은 감당 가능 수준입니다.

**Q3. Redis가 single-threaded인 게 문제 안 되나요?**
> 일반 사용엔 문제 없습니다. 메모리 접근이 매우 빠르고(~1μs), single-threaded라 lock 오버헤드도 없어서 초당 100K+ 명령 처리 가능합니다. 문제는 (1) `KEYS *` 같은 O(N) 명령을 절대 쓰면 안 됨 — SCAN으로 대체, (2) Lua script가 길면 다른 명령 block — 짧게 유지, (3) 대용량 value(MB 이상)를 자주 read하면 latency 증가. Redis 6+은 I/O multithreading 일부 지원하나 명령 실행 자체는 여전히 single-threaded입니다.

**Q4. 캐시 무효화 전략은 어떻게 해요?**
> 본 프로젝트는 TTL 기반 cache invalidation입니다. SET 시 EX로 TTL을 명시(예: 5분)하고 만료 시 자동 삭제. 강제 무효화는 (1) Cache-aside 패턴 — DB 업데이트 후 앱이 명시적 DELETE, (2) Pub/Sub 패턴 — 한 service가 DB 업데이트 후 Redis Pub로 다른 service들의 캐시 무효화 알림. 본 프로젝트는 단순한 TTL + 명시적 DELETE 조합으로 갑니다. Write-through (DB와 캐시 동시 갱신)는 더 복잡한 패턴이라 본 환경엔 과합니다.

**Q5. Memcached 대신 Redis 고른 이유는?**
> Memcached는 단순 key-value만 가능합니다. Redis는 (1) List, Set, Hash, Sorted Set, Stream 같은 자료구조 — leaderboard, queue, distributed lock 같은 패턴이 atomic하게 구현됩니다, (2) Persistence (AOF/RDB) — 재기동 시 데이터 복구, (3) Pub/Sub + Stream으로 가벼운 이벤트 처리, (4) Lua script로 server-side 로직. 본 프로젝트는 JWT 세션(Hash), rate limiting(INCR + EXPIRE) 같은 패턴이 명확해서 Redis가 정합입니다.

**Q6. KEYS * 가 왜 위험해요?**
> single-threaded라 KEYS * 명령이 모든 키를 스캔하는 동안 다른 모든 명령이 block됩니다. 100만 키면 수 초 동안 Redis가 멈춥니다. 클라이언트들은 timeout 에러를 받고, 의존하는 service 전체가 영향. 대신 `SCAN cursor MATCH pattern COUNT 100`을 사용하면 cursor 기반 incremental 스캔이라 다른 명령을 block 안 합니다. 본 프로젝트는 KEYS * 사용 자체를 코드 리뷰로 금지합니다.

**Q7. Rate limiting을 Redis로 어떻게 구현해요?**
> 가장 단순한 패턴: INCR + EXPIRE. 클라이언트 IP나 user_id를 key로 INCR 명령으로 카운터 증가시키고, 첫 번째 호출이면 EXPIRE로 1분 TTL 설정. 카운터가 임계값(예: 100)을 넘으면 거부. 더 정교한 패턴은 sliding window log (Sorted Set에 timestamp 저장 후 ZREMRANGEBYSCORE로 오래된 entry 제거) 또는 token bucket (Lua script). 본 프로젝트는 fixed window(INCR + EXPIRE)로 시작합니다.

**Q8. Distributed lock은 어떻게 구현해요?**
> 가장 단순한 패턴: `SET key value NX EX 30`. NX는 "키가 없을 때만 set", EX 30은 30초 TTL. 성공하면 lock 획득, 실패하면 다른 client가 잡고 있는 거. 작업 끝나면 DEL로 해제. 단점은 (1) 작업이 30초 넘으면 다른 client가 잡을 수 있음, (2) Sentinel/Cluster에서 split brain 가능. 더 안전한 패턴은 **Redlock** — 5개 Redis 인스턴스에 동시에 lock 시도해서 과반수 성공 시 acquired. 본 프로젝트는 단일 인스턴스라 simple lock으로 충분합니다.

**Q9. Redis 메트릭 중 중요한 5개는?**
> (1) `redis_memory_used_bytes` / `redis_memory_max_bytes`: 메모리 사용률 (80% 넘으면 eviction 시작), (2) `redis_commands_processed_total`: 초당 명령 수, (3) `redis_keyspace_hits` / `redis_keyspace_misses`: 캐시 hit ratio (낮으면 캐시 전략 재검토), (4) `redis_connected_clients`: 동시 연결 수, (5) `redis_slowlog_length`: 느린 명령 누적. 본 프로젝트는 메모리 사용률 80%, hit ratio 50% 미만, slowlog 증가를 alert 룰로 박아둡니다.

**Q10. Redis 라이선스 이슈는 어떻게 처리해요?**
> Redis Inc가 2024-03에 BSL/SSPL로 변경 → OSI 정의상 OSS 아님. 본 프로젝트가 self-host라 라이선스 영향은 미미하지만, 미래 변경 리스크 + 자유 라이선스 컨셉 일관성을 위해 Valkey 마이그레이션을 검토 가능합니다. Valkey는 Linux Foundation 거버넌스 + BSD 라이선스 + Redis 7 API 완전 호환. 본 프로젝트는 단기적으로 Redis 사용하나 Phase 6 Vault/OpenBao 결정과 같은 narrative로 라이선스 자유도 검토 가치 있다고 답합니다. 마이그레이션은 Bitnami Valkey chart로 chart만 교체하면 됩니다.

**Q11. Redis cluster 마이그레이션 시점은?**
> 본 프로젝트는 단일 인스턴스로 충분하나 production 확장 시 다음 신호가 오면 cluster 검토: (1) 메모리 사용량이 single instance RAM의 70% 도달, (2) network bandwidth가 단일 인스턴스 NIC 한계 도달, (3) 단일 장애점 제거 필요 (HA 요구), (4) 데이터 sharding으로 hot key 분산 필요. Sentinel은 (1) HA만 필요 시, Cluster는 (1)+(2)+sharding 필요 시. 본 프로젝트는 트래픽 모델상 single로 충분하고 RAM도 200MB로 제한해서 안전합니다.

**Q12. Redis가 죽으면 앱은 어떻게 동작해요?**
> 본 프로젝트는 cache-aside 패턴이라 (1) JWT 세션: 재로그인 강제, (2) API 응답 캐시: DB 직접 조회로 fallback (latency 증가하지만 동작). 즉 Redis 다운이 비즈니스 중단은 아니지만 latency 악화. 앱 코드에 Redis client timeout 짧게 설정(예: 100ms)해서 Redis 응답 없으면 즉시 DB로 fallback하는 방어 로직 필수. 본 프로젝트는 Phase 5 앱 패턴 study에서 이걸 명시합니다. Redis 재기동은 AOF로 1분 이내 복구.
