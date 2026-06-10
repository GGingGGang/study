# Strimzi Kafka (KRaft mode)

## 1. Why — 왜 쓰는가

**Kafka**: 분산 메시지 큐 + 이벤트 스트리밍 플랫폼. 토스 스택 핵심.
**Strimzi**: Kafka를 Kubernetes-native CRD로 관리하는 Operator. CNCF graduated.

**왜 메시지 큐가 필요한가**:
- service A → B 직접 HTTP 호출: B 다운 시 A도 영향
- Kafka: A가 이벤트 발행, B가 소비. 비동기 + 내구성
- 본 프로젝트: Core(produce) → Batch(consume) 패턴

**왜 Strimzi (대체재 비교)**:
- **Confluent Platform**: Enterprise. 비용. 본 프로젝트 부적합.
- **Bitnami Kafka Helm**: 가능하나 Helm chart 수준 관리. CR 기반 declarative 약함.
- **Strimzi Operator**: CRD로 Kafka cluster 정의. 가장 광범위한 채택. CNCF.

**왜 KRaft mode (vs ZooKeeper)**:
- ZooKeeper mode는 Kafka 외에 별도 분산 시스템 필요 — 운영 부담
- **Kafka 4.0 / Strimzi 0.40+에서 ZooKeeper mode 완전 제거**
- KRaft (Kafka Raft)는 Kafka 자체에 합의 알고리즘 내장. 단일 시스템.
- 신규 프로젝트는 무조건 KRaft

## 2. Architecture — 어떻게 구성되는가

**Strimzi 컴포넌트**:
- **Strimzi Operator**: CRD watch → Kafka cluster 자동 배포
- **Kafka CRD (`Kafka`)**: cluster 정의 (브로커 수, storage, listener 등)
- **KafkaTopic CRD**: 토픽 정의
- **KafkaUser CRD**: 사용자 + ACL

**Kafka cluster 구조** (KRaft 모드):
- **Broker Pod**: 메시지 저장 + 클라이언트 처리. StatefulSet으로 배포.
- **Controller**: Kafka 메타데이터 관리. KRaft에서는 broker가 controller 역할도 겸할 수 있음.
- **본 프로젝트는 단일 broker** (Always Free 환경, broker = controller 겸업)

**Kafka 핵심 추상화**:
- **Topic**: 메시지 카테고리 (예: `transactions`)
- **Partition**: 토픽 내 병렬 처리 단위. partition 수 = 동시 consumer 수 상한
- **Replica**: partition 복제본. RF=3이 production 표준. **본 프로젝트는 RF=1**(단일 broker 한계).
- **Consumer Group**: 같은 토픽을 분담해서 소비하는 consumer 묶음

## 3. Mechanism — 어떻게 돌아가는가

**Produce 흐름**:
1. Producer가 message + key 전송
2. Partitioner가 key 기반으로 partition 결정 (같은 key는 같은 partition)
3. Broker가 partition leader에 write
4. Replica로 복제 (RF > 1 시)
5. ACK 응답

**Consume 흐름**:
1. Consumer가 consumer group으로 가입
2. Broker가 group coordinator로 동작하면서 partition 분배
3. Consumer가 자기 partition의 메시지를 순서대로 읽음
4. Consumer가 offset commit (어디까지 읽었는지)
5. 재기동 시 마지막 commit 위치부터 재개

**KRaft 메타데이터**:
- Topic 생성/삭제, broker leader 변경 등을 Kafka 자체 Raft 합의로 관리
- ZooKeeper 같은 외부 시스템 불필요
- Quorum: controller 노드 과반수 (홀수 권장 — 3 또는 5)
- 본 프로젝트 단일 broker = 단일 controller = quorum 1 (HA 없음)

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Kafka 의존 관계.

- **app namespace** — Strimzi가 `Kafka` CR을 보고 broker StatefulSet 배포
- **앱 (Core)** — Kafka client로 produce
- **앱 (Batch)** — Kafka client로 consume
- **Block Volume PV** — broker data 영구 저장 (25GB)
- **Prometheus** — Strimzi 내장 ServiceMonitor로 Kafka 메트릭 자동 수집
- **Istio mTLS** (Phase 6) — **Strimzi NS는 ztunnel/sidecar 주입 제외 필수** (Kafka 자체 SSL과 충돌)
- **Vault** (Phase 6) — Kafka credentials 주입

## 5. Usage — 어떻게 쓰는가

**Strimzi Operator 설치**:

```bash
helm install strimzi-operator strimzi/strimzi-kafka-operator \
  --namespace app \
  --version 0.45.0 \
  --set watchAnyNamespace=true
```

**Kafka cluster CR** (단일 broker, KRaft):

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: my-kafka
  namespace: app
  annotations:
    strimzi.io/node-pools: enabled
    strimzi.io/kraft: enabled
spec:
  kafka:
    version: 3.9.0
    metadataVersion: 3.9-IV0
    listeners:
    - name: plain
      port: 9092
      type: internal
      tls: false
    - name: tls
      port: 9093
      type: internal
      tls: true
      authentication:
        type: tls
    config:
      offsets.topic.replication.factor: 1
      transaction.state.log.replication.factor: 1
      transaction.state.log.min.isr: 1
      default.replication.factor: 1
      min.insync.replicas: 1
      log.retention.hours: 168       # 7일
    resources:
      requests: { cpu: 200m, memory: 512Mi }
      limits: { cpu: 1, memory: 1Gi }
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

**KafkaNodePool** (Strimzi 0.39+ 권장 패턴, controller + broker 분리 가능):

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaNodePool
metadata:
  name: dual-role
  namespace: app
  labels:
    strimzi.io/cluster: my-kafka
spec:
  replicas: 1
  roles:
    - controller
    - broker
  storage:
    type: persistent-claim
    size: 25Gi
    class: oci-bv
    deleteClaim: false
```

**Topic 생성** (KafkaTopic CR):

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: transactions
  namespace: app
  labels:
    strimzi.io/cluster: my-kafka
spec:
  partitions: 3
  replicas: 1                  # 단일 broker
  config:
    retention.ms: 604800000    # 7일
    segment.bytes: 1073741824
```

**Istio NS 제외 설정** (Phase 6과 연결):

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: app
  labels:
    istio.io/dataplane-mode: none    # Ambient 제외
    # 또는 istio-injection: disabled (sidecar mode)
```

**클라이언트 연결** (앱 코드):
- Bootstrap server: `my-kafka-kafka-bootstrap.app.svc.cluster.local:9092`
- TLS 사용 시 9093 포트 + 인증서 (Strimzi가 자동 생성)

**검증**:

```bash
# Kafka cluster 상태
kubectl get kafka my-kafka -n app -o jsonpath='{.status.conditions[0].type}'

# Topic 목록
kubectl get kafkatopic -n app

# Pod 안에서 메시지 produce/consume 테스트
kubectl exec -it my-kafka-dual-role-0 -n app -- \
  bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic transactions

kubectl exec -it my-kafka-dual-role-0 -n app -- \
  bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic transactions --from-beginning
```

## 6. Configuration — 어떤 설정이 있는가

**Replication factor**:
- production: RF=3, min.insync.replicas=2 (1 broker 다운에도 동작)
- 본 프로젝트: RF=1 (단일 broker라 어쩔 수 없음). production 한계 명시 필수.

**Listener types**:
- `internal`: 클러스터 내부만
- `nodeport`: NodePort로 외부 노출
- `loadbalancer`: LB로 외부 노출
- `route`: OpenShift
- `cluster-ip`: ClusterIP only

**Authentication**:
- `tls`: mTLS 클라이언트 인증서
- `scram-sha-512`: 비밀번호
- `oauth`: OAuth2 토큰

**Retention 설정**:
- `log.retention.hours`: 시간 기준 (default 168 = 7일)
- `log.retention.bytes`: 크기 기준
- 본 프로젝트는 시간 + 크기 둘 다 설정해서 디스크 보호

**Topic-level config**:
- `cleanup.policy`: `delete`(시간/크기 기반) vs `compact`(key 기반 dedupe)
- `retention.ms`: 토픽별 보관 기간 override
- `partitions`: 한 번 정하면 늘리기만 가능, 줄이기 불가

**Strimzi 메트릭**:
- 자동으로 JMX exporter 포함
- ServiceMonitor 자동 생성 (Phase 4 ServiceMonitor 컨벤션과 호환)

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kafka 3.9+ / 4.0** (2026-05 권장). ZooKeeper mode 완전 제거.
- **Strimzi 0.40+** (KRaft 안정. 0.45+ 권장)
- **Kubernetes 1.27+**
- **Java 17+** (브로커 JVM)
- **Block Volume**: 최소 50GB/볼륨 한계 → 본 프로젝트는 25GB로 설정하나 실제로는 50GB 할당될 수 있음
- **Istio**: ztunnel/sidecar 주입 제외 필수 (호환성 깨짐)
- **ARM64**: Kafka official image ARM64 지원, Strimzi operator도 ARM64 지원

## 8. 면접 예상 질문 & 답변

**Q1. Kafka가 왜 필요해요? HTTP API 호출로 충분하지 않나요?**
> 동기 vs 비동기 차이입니다. service A가 B를 HTTP로 호출하면 B 다운 시 A도 영향받습니다. Kafka는 (1) Producer가 broker에 이벤트 발행하면 Consumer 상태와 무관하게 성공 응답을 받습니다, (2) Consumer는 자기 속도로 처리하고 partition 확장으로 병렬 처리 가능, (3) 메시지가 디스크에 저장되어 재처리 가능. 본 프로젝트의 Core(거래 발생) → Batch(정산 집계) 흐름은 결과가 즉시 필요 없고 신뢰성이 더 중요해서 Kafka가 적합합니다.

**Q2. KRaft mode 골랐는데 ZooKeeper는요?**
> ZooKeeper mode는 **Kafka 4.0 / Strimzi 0.40+에서 완전 제거**됐습니다. 신규 프로젝트가 ZooKeeper로 시작하면 곧 EOL이라 KRaft가 유일한 선택입니다. KRaft의 장점은 (1) Kafka 외 별도 분산 시스템 불필요 — 운영 단순, (2) 메타데이터 처리가 더 빠름, (3) 토픽 수 백만 개 이상 확장 가능. 단점은 production 마이그레이션 도구가 아직 완전하지 않다는 정도였는데 2026 기준 거의 해결됐습니다.

**Q3. 본 프로젝트 단일 broker는 production 환경 같지 않은데, 어떻게 답해요?**
> 정직하게 한계 명시합니다. "Always Free 환경에서 단일 broker로 학습/포트폴리오 목적이고, production은 최소 3 broker + RF=3 + min.insync.replicas=2가 표준"이라고 답합니다. 본 프로젝트의 단일 broker는 (1) broker 다운 시 모든 producer/consumer 중단, (2) RF=1이라 메시지 손실 가능, (3) 메시지가 디스크에 있어 broker가 복구되면 메시지는 살아있지만 다운타임 발생. 면접에서 "Strimzi NodePool CR의 replicas를 3으로 늘리고 default.replication.factor=3, min.insync.replicas=2로 바꾸면 production-ready"라고 확장 narrative 준비.

**Q4. Strimzi 안 쓰고 Helm chart로 Kafka 설치하면 안 되나요?**
> 가능하지만 Strimzi가 더 나은 이유: (1) Kafka cluster 정의가 단일 CR — `Kafka` 리소스만 만들면 broker/controller StatefulSet + Service + ConfigMap이 자동 생성됩니다, (2) Topic과 User도 CRD로 declarative 관리 — GitOps 통합 매끄러움, (3) rolling update, scaling, version upgrade가 Operator가 처리, (4) 메트릭/ServiceMonitor 자동 통합. Bitnami Helm chart는 Kafka를 띄울 수는 있지만 Topic은 imperative로 만들고 운영 자동화 부족. Strimzi가 CNCF graduated 표준입니다.

**Q5. Topic의 partition 수는 어떻게 정해요?**
> Consumer 병렬도의 상한입니다. partition 3개면 같은 consumer group의 consumer 최대 3개가 병렬 처리 가능합니다. 그 이상 consumer가 있으면 idle 상태. 본 프로젝트는 partition 3으로 설정했는데, 트래픽이 작아서 1개로도 충분하지만 확장 여지를 둡니다. **주의**: partition은 늘릴 수는 있지만 줄일 수는 없고, partition 늘리면 key→partition 매핑이 변경되어 순서 보장이 깨질 수 있습니다. 그래서 초기에 약간 넉넉하게 잡는 게 표준입니다.

**Q6. Kafka client library는 뭘 써요?**
> 본 프로젝트는 앱 레벨이 미정이지만 Go 기준으로 답하면 franz-go(twmb)가 표준입니다. 사유: (1) pure Go라 cross-compile 자유로움, (2) Shopify/sarama 대비 2.5x 빠름, (3) context 지원 (sarama는 미지원), (4) 활발한 개발. confluent-kafka-go는 cgo 의존이라 ARM64 빌드 복잡. Spring Boot라면 Spring Kafka가 표준이고 Reactor Kafka도 좋습니다. 면접에선 "팀 언어 + 트래픽 패턴에 맞춰 결정"이라 답합니다.

**Q7. Consumer Group이 뭐고 왜 중요해요?**
> 같은 토픽을 분담해서 소비하는 consumer 묶음입니다. group A의 consumer 3개가 partition 3을 1:1로 분배받으면 병렬 처리됩니다. group B의 consumer 1개도 같은 토픽을 처음부터 다시 소비 가능 — 즉 같은 데이터를 여러 용도로 분리 처리 가능합니다. 본 프로젝트는 Batch가 group `batch-consumer`로 가입하고 거래 이벤트를 소비합니다. 미래에 알림 시스템이 추가되면 group `notification-consumer`로 같은 이벤트를 별도로 소비할 수 있는 확장성이 있습니다.

**Q8. Kafka offset commit은 어떻게 동작해요?**
> Consumer가 메시지를 읽은 후 "여기까지 처리 완료"를 broker에 알리는 메커니즘입니다. Auto-commit(주기적 자동) vs Manual commit(앱이 명시적)이 있습니다. **At-least-once 보장**을 위해서는 처리 완료 후 manual commit 권장 — 처리 실패 시 commit 안 하고 재처리됩니다. 본 프로젝트의 Batch는 정산 결과 DB 저장 완료 후 commit하는 패턴이라 메시지 손실 없이 재처리 가능합니다. Auto-commit은 처리 실패 시 메시지 손실 위험.

**Q9. Strimzi NS에 Istio sidecar 주입 안 하는 이유는?**
> Kafka는 자체 binary 프로토콜 + SSL/SASL을 사용합니다. Istio sidecar/ztunnel이 트래픽을 가로채면 (1) HTTP/2 기반 mTLS와 Kafka SSL이 이중 암호화되어 핸드셰이크가 깨지고, (2) Istio가 Kafka 프로토콜을 이해 못해서 일부 명령이 차단될 수 있습니다. 해결책은 Strimzi NS에 `istio.io/dataplane-mode: none` (Ambient) 또는 `istio-injection: disabled` (sidecar)을 명시해서 mesh 가입 자체를 막는 것입니다. 보안은 Strimzi 자체 listener TLS + SASL로 대체합니다.

**Q10. Kafka 데이터 백업은 어떻게 해요?**
> 본 프로젝트는 (1) Block Volume Backup 5개 한도 중 Kafka PV를 우선순위 4로 배치, (2) Kafka 자체 MirrorMaker 같은 cross-cluster 복제는 안 함 (단일 클러스터), (3) Velero가 PV CSI snapshot 백업. 단일 broker 환경의 한계는 명확히 인지하고, production이라면 RF=3 자체가 백업의 일부이고 cross-region replication을 추가하는 게 표준입니다. 본 프로젝트의 RTO/RPO는 Phase 7 표에서 "broker 손상 시 15분 RTO, 메시지 손실 가능"으로 명시합니다.

**Q11. Kafka 메트릭 중에 무엇을 봐야 해요?**
> 핵심 5가지: (1) `kafka_server_brokertopicmetrics_messagesin_total` — 토픽별 produce rate, (2) `kafka_consumer_consumer_fetch_manager_metrics_records_lag` — consumer lag (가장 중요, partition별 미처리 메시지 수), (3) `kafka_log_log_size` — 디스크 사용량, (4) `kafka_network_request_metrics_totaltimems` — request latency, (5) `kafka_server_replica_manager_under_replicated_partitions` — RF 부족 (단일 broker는 무관). 본 프로젝트는 consumer lag을 가장 중요하게 alert (lag > 1000이면 처리 늦어지는 신호).

**Q12. Compaction과 deletion 차이는?**
> Topic의 `cleanup.policy` 옵션입니다. `delete`(default)는 시간(retention.ms) 또는 크기(retention.bytes) 기준으로 오래된 메시지 삭제. `compact`는 같은 key의 메시지가 여러 개 있으면 가장 최신만 유지(deduplication). Compaction은 "user_id → 마지막 상태" 같은 key-value 스냅샷 용도(Kafka Streams의 state store 등)에 씁니다. 본 프로젝트의 transactions 토픽은 delete policy로 7일 retention입니다.
