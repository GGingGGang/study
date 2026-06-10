# Vault / OpenBao

## 1. Why — 왜 쓰는가

시크릿 관리 도구. DB 패스워드, API 토큰, TLS 인증서, encryption key 등을 안전하게 저장하고 앱에 주입.

**k8s Secret만으로는 부족한 이유**:
- etcd에 base64 encoded (암호화 아님) — etcd 접근 권한 있으면 모든 시크릿 노출
- 시크릿 rotation 수동 — 만료된 토큰 갱신이 운영 부담
- audit log 부족 — 누가 언제 어떤 시크릿 읽었는지 추적 불가
- secret sprawl — 매니페스트에 secret 박혀있어 GitOps에 평문 secret 누출 위험

**Vault/OpenBao의 해결**:
- **Dynamic secrets**: DB 패스워드를 요청 시점에 동적 생성 + 짧은 TTL
- **Encryption as a Service**: 앱 데이터를 Vault에 보내서 암호화/복호화 위임
- **Transit Engine**: 다른 시스템의 auto-unseal 키
- **PKI Engine**: 내부 CA로 mTLS 인증서 발급
- **Audit log**: 모든 시크릿 접근 기록

**Vault vs OpenBao 라이선스 이슈**:
- HashiCorp Vault: 2023.08부터 **BSL 1.1** 라이선스 (OSI 정의상 OSS 아님)
- OpenBao: Linux Foundation OpenSSF fork. MPL 2.0 라이선스 유지. IBM 등 적극 기여.
- 2026-05 기준 OpenBao 2.5.0 production-ready
- API/Helm chart/Agent Injector 모두 Vault 호환 → 마이그레이션 비용 낮음

**본 프로젝트 OpenBao 채택 narrative**: "self-host 환경에서 BSL 영향은 작지만 라이선스 자유도 + 미래 변경 리스크 차단 + 자유 라이선스 컨셉 일관성"

**대체재**:
- **AWS Secrets Manager / GCP Secret Manager**: SaaS, 클라우드 종속, 비용
- **External Secrets Operator (ESO)**: Vault/AWS SM/GCP SM 등을 k8s Secret으로 동기화. Vault Agent Injector와 함께 또는 대안으로 사용.
- **Sealed Secrets**: 매니페스트에 암호화된 secret을 commit. Git에 안전하게 저장 가능하나 dynamic secret 못 함.
- **Vault/OpenBao**: 모든 기능 풀세트, 가장 광범위

## 2. Architecture — 어떻게 구성되는가

**Vault/OpenBao 컴포넌트**:
- **Server**: 핵심 binary. HTTP/gRPC API 노출.
- **Storage backend**: 시크릿 영구 저장. 본 프로젝트 **Raft** (내장, k8s에서 표준).
- **Seal**: 데이터를 암호화하는 master key. 평문으로 디스크에 없음.
- **Auto-unseal**: 외부 KMS(OCI Vault Transit)로 master key 복호화 자동화.

**핵심 추상화**:
- **Path**: 시크릿 위치 (예: `secret/data/app/login/db`)
- **Engine**: 시크릿 종류별 처리
  - `kv` (Key-Value): 일반 정적 secret
  - `database`: 동적 DB credential 생성
  - `pki`: 내부 CA + 인증서 발급
  - `transit`: encryption as a service (다른 Vault auto-unseal 등)
  - `aws/gcp/oci`: 클라우드 IAM credential 동적 발급
- **Auth method**: 인증 방식
  - `kubernetes`: SA JWT 검증
  - `token`: 직접 토큰
  - `userpass`, `oidc`, `aws/oci`: 외부 인증
- **Policy**: HCL 문법으로 path별 권한 정의 (read/write/delete)

**Vault Agent Injector**:
- k8s Mutating Admission Webhook
- Pod annotation에 `vault.hashicorp.com/agent-inject: "true"` 보면 자동으로 init container 주입
- Init container가 Vault에서 시크릿 가져와서 Pod의 volume에 mount

## 3. Mechanism — 어떻게 돌아가는가

**Seal/Unseal 메커니즘**:
1. Vault 시작 시 storage(Raft) 데이터는 master key로 암호화 상태 — 사용 불가
2. Master key는 unseal key로 암호화되어 있음
3. **수동 unseal**: 운영자가 unseal key를 입력 (Shamir Secret Sharing — 5개 key 중 3개 필요)
4. **Auto-unseal** (본 프로젝트): OCI Vault Transit이 unseal key를 자동 복호화 → 운영자 개입 없음
5. Unseal 완료 후 Vault가 client 요청 처리

**Pod에 secret 주입 흐름** (Vault Agent Injector):
1. App Pod manifest에 annotation 추가:
   ```yaml
   vault.hashicorp.com/agent-inject: "true"
   vault.hashicorp.com/role: "login"
   vault.hashicorp.com/agent-inject-secret-db: "secret/data/app/login/db"
   ```
2. Pod 생성 요청 → Admission Webhook이 init container `vault-agent-init` 추가
3. Init container 시작 → SA token으로 Vault에 인증 (`kubernetes` auth)
4. Vault가 SA + role 매칭 확인 → policy 적용 → 시크릿 반환
5. Init container가 시크릿을 `/vault/secrets/db` 파일로 작성
6. App container가 그 파일을 read

**Dynamic database credential**:
1. App이 Vault에 `database/creds/login` 요청
2. Vault가 MySQL에 새 user 생성 (랜덤 username/password + 1시간 TTL)
3. App에게 credential 반환
4. App이 1시간 후 갱신 또는 새 credential 요청
5. TTL 만료 시 Vault가 user 자동 삭제

## 4. Integration — 어떻게 연결하는가

본 프로젝트의 Vault/OpenBao 의존 관계.

- **vault namespace** — Vault Helm chart 설치
- **OCI Vault** (Phase 1 IAM 모듈) — Transit seal로 auto-unseal
- **OCI IAM Policy** (Phase 1) — Vault pod의 Dynamic Group이 Transit key 사용 권한
- **Block Volume PV** — Raft data 저장 (10GB)
- **Vault Agent Injector** — vault namespace에 함께 설치, 모든 namespace의 Pod에 webhook 적용
- **앱 (Phase 5)** — annotation으로 시크릿 자동 주입
- **Jenkins** (Phase 3 4종 secret) — 마이그레이션 대상 (k8s Secret → Vault)
- **Velero** (Phase 7) — Vault snapshot 별도 자동화 필요 (Velero로 안 됨)

## 5. Usage — 어떻게 쓰는가

**Helm 설치** (OpenBao):

```bash
helm install vault openbao/openbao \
  --namespace vault --create-namespace \
  --version 0.10+ \
  -f vault-values.yaml
```

vault-values.yaml:
```yaml
server:
  ha:
    enabled: true
    replicas: 1                  # 노드 2개 환경 한계
    raft:
      enabled: true
      setNodeId: true
      config: |
        ui = true
        listener "tcp" {
          tls_disable = 1        # Istio mTLS로 보호
          address = "[::]:8200"
          cluster_address = "[::]:8201"
        }
        
        storage "raft" {
          path = "/vault/data"
        }
        
        seal "ocikms" {
          key_ocid              = "<oci-vault-key-ocid>"
          crypto_endpoint       = "https://<...>.kms.<region>.oraclecloud.com"
          management_endpoint   = "https://kms.<region>.oraclecloud.com"
          auth_type_api_key     = "false"   # Instance Principal
        }
        
        service_registration "kubernetes" {}
  
  dataStorage:
    enabled: true
    size: 10Gi
    storageClass: oci-bv
  
  serviceAccount:
    create: true
    name: vault
    
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits: { cpu: 500m, memory: 512Mi }

injector:
  enabled: true
  
ui:
  enabled: true
```

**OCI IAM Policy 추가** (Phase 1):
```
Allow dynamic-group vault-unseal to use keys in compartment <x> where target.key.id = '<unseal-key-ocid>'
```

**초기 설정** (Vault 시작 후 1회):

```bash
# Pod 안에서
kubectl exec -it vault-0 -n vault -- sh

# 초기화 (recovery key 5개 생성, threshold 3)
vault operator init -recovery-shares=5 -recovery-threshold=3
# → root token + recovery keys 출력. 안전한 곳에 저장!

# Auto-unseal로 unseal 자동 완료됨
vault status
# Sealed: false 확인
```

**Kubernetes auth 활성화**:

```bash
vault login <root-token>
vault auth enable kubernetes

# JWT/CA로 인증
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc"
```

**Policy 생성**:

```bash
# login-policy.hcl
cat > login-policy.hcl <<EOF
path "secret/data/app/login/*" {
  capabilities = ["read"]
}
EOF

vault policy write login login-policy.hcl
```

**Role 생성** (SA와 policy 매핑):

```bash
vault write auth/kubernetes/role/login \
  bound_service_account_names=login \
  bound_service_account_namespaces=app \
  policies=login \
  ttl=1h
```

**Secret 저장**:

```bash
vault kv put secret/app/login/db \
  username="login_app" \
  password="<random-strong>"
```

**App Pod annotation** (Vault Agent Injector 사용):

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: login
  namespace: app
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "login"
        vault.hashicorp.com/agent-inject-secret-db: "secret/data/app/login/db"
        vault.hashicorp.com/agent-inject-template-db: |
          {{- with secret "secret/data/app/login/db" -}}
          DB_USER={{ .Data.data.username }}
          DB_PASSWORD={{ .Data.data.password }}
          {{- end }}
    spec:
      serviceAccountName: login
      containers:
      - name: login
        env:
        - name: DB_CONFIG_PATH
          value: /vault/secrets/db
```

## 6. Configuration — 어떤 설정이 있는가

**Seal types**:
- `shamir`: 수동 unseal (5개 key 중 3개). 운영 부담 큼.
- `ocikms` / `awskms` / `azurekeyvault`: 클라우드 KMS auto-unseal. 본 프로젝트.
- `transit`: 다른 Vault 인스턴스로 auto-unseal

**Storage backends**:
- `raft` (권장): 내장. k8s에서 표준.
- `consul`: HashiCorp Consul (deprecated 진행 중)
- `dynamodb` / `etcd` / `mysql`: 외부 storage

**Auth methods**:
- `kubernetes`: SA JWT
- `token`: 직접 토큰
- `userpass`: 사용자/비밀번호
- `oidc`: OIDC (GitHub, Google 등)
- `cert`: client TLS 인증서

**Vault Agent Injector annotations**:
- `vault.hashicorp.com/agent-inject`: "true" 활성화
- `vault.hashicorp.com/role`: Vault role
- `vault.hashicorp.com/agent-inject-secret-<name>`: 시크릿 path
- `vault.hashicorp.com/agent-inject-template-<name>`: 출력 형식 (consul-template 문법)
- `vault.hashicorp.com/agent-pre-populate-only`: init만 + sidecar 안 함
- `vault.hashicorp.com/agent-inject-status`: 모니터링용

**Token TTL**:
- `default_lease_ttl`: 기본 시크릿 TTL (default 32일)
- `max_lease_ttl`: 최대 TTL
- 본 프로젝트 ttl=1h로 짧게 + 자동 갱신

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Kubernetes 1.27+**
- **Vault 1.18+ / OpenBao 2.x+** (2026-05 권장)
- **Vault Helm chart**: Vault & OpenBao 모두 호환 (chart는 사실상 동일)
- **Vault Agent Injector**: k8s 1.27+, Vault 1.x 또는 OpenBao 2.x
- **OCI KMS auto-unseal**: Instance Principal 또는 API key 인증
- **Block Volume**: Raft data용, 최소 10GB

## 8. 면접 예상 질문 & 답변

**Q1. k8s Secret만으로 부족한 이유가 뭐예요?**
> 세 가지입니다. (1) etcd에 base64로만 저장되어 etcd 접근 권한 있으면 평문 노출. (2) Secret rotation 수동이라 만료된 토큰 갱신이 운영 부담. (3) audit log 부족 — 누가 어떤 secret을 언제 읽었는지 추적 불가. 또 GitOps 환경에서 평문 Secret이 매니페스트에 commit될 위험도 있습니다. Vault는 dynamic secret(요청 시점 생성 + TTL), audit log, encryption at rest(storage backend 자체 암호화), 외부 KMS 통합 같은 기능으로 이 문제들을 해결합니다.

**Q2. Vault 대신 OpenBao 골랐는데 왜요?**
> HashiCorp Vault가 2023.08부터 BSL 1.1로 라이선스 변경되어 OSI 정의상 OSS가 아닙니다. OpenBao는 BSL 직전 마지막 MPL 2.0 버전을 fork해서 Linux Foundation OpenSSF 거버넌스로 운영됩니다. 2026-05 기준 OpenBao 2.5.0이 production-ready고, IBM 등이 적극 기여 중입니다. API/Helm chart/Agent Injector 모두 Vault 호환이라 마이그레이션 비용도 낮습니다. 본 프로젝트는 self-host 환경이라 BSL 영향이 작긴 하지만, 라이선스 자유도 + 미래 변경 리스크 차단 + 자유 라이선스 컨셉 일관성으로 OpenBao 채택했습니다.

**Q3. Auto-unseal이 왜 필요해요?**
> 수동 unseal은 운영 부담이 큽니다. Vault 재시작마다 운영자가 unseal key(5개 중 3개)를 입력해야 하고, 새벽에 Pod이 재기동되면 새벽에 운영자 호출됩니다. Auto-unseal은 외부 KMS(본 프로젝트는 OCI Vault Transit)가 unseal key를 자동 복호화해서 Vault가 시작 시 자동으로 unseal됩니다. 트레이드오프는 외부 KMS에 의존성이 생기는 점인데, OCI Vault는 HA + audit log 제공이라 위험 작습니다.

**Q4. 1 replica Raft가 위험하지 않나요?**
> 위험합니다. Vault 단일 인스턴스라 Pod 다운 시 새 Pod 생성이 시크릿 못 받아서 Init container 무한 대기 상태가 됩니다. 이미 띄워진 Pod은 정상 동작(메모리에 secret 보유)하지만 rolling update가 막힙니다. 본 프로젝트는 노드 2개 환경에서 3 replica Raft가 anti-affinity 불충족이라 1 replica로 갈 수밖에 없습니다. 대신 (1) auto-unseal로 빠른 재기동, (2) Velero/Vault snapshot으로 빠른 복구, (3) PV는 Block Volume Backup 우선순위 1로 보호 — 세 가지로 완화합니다. RTO 5분(PV 정상) ~ 15분(PV 손상) 명시.

**Q5. Vault Agent Injector가 어떻게 동작해요?**
> Mutating Admission Webhook입니다. Pod 생성 요청 시 webhook이 annotation `vault.hashicorp.com/agent-inject: "true"`를 보면 자동으로 init container 추가합니다. Init container가 SA JWT로 Vault에 인증하고(Kubernetes auth method), Vault가 SA + role 매핑 확인 후 policy에 따라 secret 반환합니다. Init container가 secret을 `/vault/secrets/<name>` 파일로 작성하고, app container가 그 파일을 read합니다. 결과적으로 앱 코드에 Vault SDK 불필요하고 매니페스트 annotation만으로 secret 주입이 끝납니다.

**Q6. Dynamic database secret과 static secret 차이는?**
> Static은 운영자가 미리 저장한 고정 secret입니다(예: API key). Dynamic은 요청 시점에 Vault가 생성합니다 — DB의 경우 Vault가 MySQL에 새 user 생성 후 username/password 반환하고 짧은 TTL(1시간) 후 자동 삭제. 장점은 (1) credential이 매번 다름 → 유출 시 영향 최소, (2) TTL로 자동 회전, (3) 누가 언제 어떤 user 만들었는지 audit. 본 프로젝트는 dynamic이 이상적이지만 단순성 우선으로 static + 주기적 manual rotation으로 시작하고 향후 dynamic 확장 가능합니다.

**Q7. Vault Agent Injector vs External Secrets Operator(ESO) 어느 게 나아요?**
> 차이가 있습니다. Vault Agent Injector는 (1) Pod 안에 secret 파일 직접 mount, (2) Pod 재시작 시점에 fresh secret, (3) secret 회전 시 Pod 재시작 필요. ESO는 (1) k8s Secret으로 동기화, (2) controller가 주기적으로 Vault에서 fetch해서 Secret 업데이트, (3) Pod 재시작 없이 secret rotation 가능 (envFrom 같은 경우). 본 프로젝트는 Vault Agent Injector로 시작하고 rotation 필요 시 ESO 검토. 면접에서 둘의 트레이드오프를 답할 수 있어야 합니다.

**Q8. OCI Vault Transit으로 auto-unseal하면 OCI 의존성이 생기는데 괜찮나요?**
> 트레이드오프입니다. OCI 의존성이 생기지만 (1) OCI Vault는 HA + audit log 제공, (2) Always Free 키 20개 한도 안에서 무료, (3) 수동 unseal 운영 부담 회피. 만약 OCI 의존성을 피하려면 (a) Shamir 수동 unseal — 운영 부담 큼, (b) Transit unseal with another Vault — 무한 루프 위험. 본 프로젝트는 OCI 위에 올라가 있으므로 OCI Vault 의존이 자연스럽고 회피 가치 작습니다.

**Q9. Vault 백업은 어떻게 해요?**
> Vault Raft snapshot을 OCI Object Storage에 주기적 업로드합니다. **Vault OSS와 OpenBao는 auto-snapshot 미지원** — 그 기능은 Vault Enterprise 전용입니다. 그래서 CronJob 또는 OpenBao Raft Snapshot Agent로 매일 `vault operator raft snapshot save` 실행 후 Object Storage 업로드. snapshot 자체가 unseal key로 암호화돼 있지만 추가로 OCI Vault Transit으로 한 번 더 암호화하는 게 권장. 본 프로젝트는 Phase 7에서 이 자동화를 다룹니다.

**Q10. Vault policy 작성할 때 주의사항은?**
> 세 가지. (1) **최소 권한 원칙** — 각 앱이 정확히 자기 secret path만 read 가능. wildcard `*` 남용 금지. (2) **deny rules 명시적** — 특정 path는 명시적으로 거부. (3) **path versioning 인지** — kv v2는 `secret/data/...`로 접근하고, secret 자체는 `secret/metadata/...`에 있어 별도 권한 필요. 본 프로젝트는 service별 policy 분리(login, core, batch 각각) + 운영자용 admin policy 별도 + audit log로 모든 접근 추적.

**Q11. Vault Agent Injector가 죽으면 어떻게 되나요?**
> 이미 실행 중인 Pod은 영향 없습니다 — 시크릿이 이미 메모리에 있어요. 영향은 새 Pod 생성에서 발생합니다. Webhook이 응답 안 하면 admission이 실패하고 Pod 생성 자체가 막힙니다. webhook의 `failurePolicy: Fail`이 default라 안전 측면. 단점은 webhook 다운 시 모든 새 Pod이 막혀서 service 영향. 그래서 (1) Injector를 1 replica 이상 권장 (본 프로젝트는 자원 제약상 1), (2) Prometheus로 webhook latency/error 즉시 alert.

**Q12. Vault PKI engine으로 mTLS 인증서 발급은 어떻게 해요?**
> Vault PKI engine을 활성화한 후 (1) root CA 생성 (Vault 자체 또는 외부 CA로 sign된 intermediate), (2) Role 정의 (어떤 도메인, 어떤 TTL의 인증서 발급 가능한지), (3) 앱이 `pki/issue/<role>` API 호출하면 인증서 + 개인키 + CA chain 반환. cert-manager Vault Issuer로 통합 가능. 본 프로젝트는 외부 트래픽은 Let's Encrypt(cert-manager), 내부 mTLS는 Istio 내장 CA로 분리 — 단순성 우선이라 Vault PKI 도입 안 함. 면접에서 "고급 시나리오로 Vault PKI 검토 가치 있음"이라 답할 수 있습니다.
