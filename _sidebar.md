- [홈](/)

- 쿠버네티스 · 아키텍처 기준
  - [00 — 일반 아키텍처 (MSA·플랫폼)](notes/kubernetes/00-아키텍처-일반.md)
  - [01 — 내 레포 구조 (oci-always-free-k8s)](notes/kubernetes/01-아키텍처-내-레포-구조.md)

- 쿠버네티스 · 인프라
  - [02 — 기본기: 클러스터 아키텍처](notes/kubernetes/02-기본기-클러스터-아키텍처.md)
  - [03 — 기본기: 워크로드와 리소스](notes/kubernetes/03-기본기-워크로드와-리소스.md)
  - [04 — Gateway API: 철학과 아키텍처](notes/kubernetes/04-gateway-api-철학과-아키텍처.md)
  - [05 — Gateway API: 기능 상세](notes/kubernetes/05-gateway-api-기능-상세.md)
  - [06 — Istio: 개요와 아키텍처](notes/kubernetes/06-istio-개요와-아키텍처.md)
  - [07 — Istio: 트래픽 관리](notes/kubernetes/07-istio-트래픽-관리.md)
  - [08 — Istio: 보안 (mTLS·인가)](notes/kubernetes/08-istio-보안.md)
  - [09 — Istio: Ambient와 관측성](notes/kubernetes/09-istio-ambient와-관측성.md)
  - [10 — cert-manager (TLS 자동화)](notes/kubernetes/10-cert-manager.md)
  - [11 — external-dns (DNS 자동화)](notes/kubernetes/11-external-dns.md)
  - [12 — Prometheus (메트릭)](notes/kubernetes/12-prometheus.md)
  - [13 — Loki (로그)](notes/kubernetes/13-loki.md)
  - [14 — Grafana (시각화)](notes/kubernetes/14-grafana.md)
  - [15 — Kiali (메시 콘솔)](notes/kubernetes/15-kiali.md)
  - [16 — OpenBao (시크릿 관리)](notes/kubernetes/16-openbao.md)

- 쿠버네티스 · 기본기 심화
  - [21 — 스케줄링 (affinity·taint)](notes/kubernetes/21-기본기심화-스케줄링.md)
  - [22 — RBAC와 ServiceAccount](notes/kubernetes/22-기본기심화-RBAC와-서비스어카운트.md)
  - [23 — 리소스·QoS·프로브](notes/kubernetes/23-기본기심화-리소스-QoS-프로브.md)
  - [24 — 오토스케일 (HPA·VPA)](notes/kubernetes/24-기본기심화-오토스케일.md)

- 쿠버네티스 · GitOps
  - [17 — GitOps: 철학과 원칙](notes/kubernetes/17-gitops-철학과-원칙.md)
  - [18 — GitOps: 구현 패턴](notes/kubernetes/18-gitops-구현-패턴.md)
  - [19 — ArgoCD (GitOps CD)](notes/kubernetes/19-argocd.md)

- 쿠버네티스 · CI/CD
  - [20 — Jenkins (CI)](notes/kubernetes/20-jenkins.md)

- 쿠버네티스 · 실전·취준
  - [25 — kubectl 치트시트](notes/kubernetes/25-실전-kubectl-치트시트.md)
  - [26 — 트러블슈팅 플레이북](notes/kubernetes/26-실전-트러블슈팅-플레이북.md)
  - [27 — 면접 예상질문](notes/kubernetes/27-실전-면접-예상질문.md)

- 플랫폼 로드맵 · 기반 (Fundamentals)
  - [01 — Kubernetes (컨트롤플레인·워크로드·OKE 제약)](notes/fundamentals/01-kubernetes.md)
  - [02 — Helm (Chart·3-way merge·ArgoCD 결합)](notes/fundamentals/02-helm.md)

- 플랫폼 로드맵 · Phase 2 — 쿠버네티스 기반
  - [01 — Gateway API (3-tier·canary·TLS)](notes/phase-2/01-gateway-api.md)
  - [02 — Istio (Ambient·HBONE·SPIFFE mTLS)](notes/phase-2/02-istio.md)
  - [03 — cert-manager (ACME DNS-01·ClusterIssuer)](notes/phase-2/03-cert-manager.md)
  - [04 — external-dns (TXT registry·Cloudflare)](notes/phase-2/04-external-dns.md)
  - [05 — RBAC (deny by default·SA Token)](notes/phase-2/05-rbac.md)

- 플랫폼 로드맵 · Phase 3 — CI/CD
  - [01 — ArgoCD (GitOps·ApplicationSet·sync wave)](notes/phase-3/01-argocd.md)
  - [02 — Jenkins (동적 agent·ARM64·JCasC)](notes/phase-3/02-jenkins.md)
  - [03 — GHCR (multi-arch·SHA 태그·cosign)](notes/phase-3/03-ghcr.md)

- 플랫폼 로드맵 · Phase 4 — 모니터링
  - [01 — kube-prometheus-stack (Operator·PromQL)](notes/phase-4/01-kube-prometheus-stack.md)
  - [02 — Thanos (downsampling·장기 보관)](notes/phase-4/02-thanos.md)
  - [03 — Loki·Alloy (LogQL·라벨 인덱싱)](notes/phase-4/03-loki-alloy.md)
  - [04 — Tempo (OTLP·분산 트레이싱)](notes/phase-4/04-tempo.md)
  - [05 — Kiali (메시 토폴로지·mTLS 시각화)](notes/phase-4/05-kiali.md)

- 플랫폼 로드맵 · Phase 5 — 애플리케이션 인프라
  - [01 — Strimzi Kafka (KRaft·declarative)](notes/phase-5/01-strimzi-kafka.md)
  - [02 — Redis (AOF·Valkey·rate limit)](notes/phase-5/02-redis.md)
  - [03 — HPA·Prometheus Adapter (커스텀 메트릭)](notes/phase-5/03-hpa-prometheus-adapter.md)
  - [04 — Pod 패턴 (프로브·graceful shutdown·PDB)](notes/phase-5/04-pod-patterns.md)
  - [05 — Dockerfile 표준 (distroless·non-root·SBOM)](notes/phase-5/05-dockerfile-standards.md)

- 플랫폼 로드맵 · Phase 6 — 보안
  - [01 — Vault·OpenBao (Agent Injector·dynamic secret)](notes/phase-6/01-vault-openbao.md)
  - [02 — Istio mTLS (STRICT 전환·AuthorizationPolicy)](notes/phase-6/02-istio-mtls.md)
  - [03 — Cilium chaining (eBPF·NetworkPolicy·Hubble)](notes/phase-6/03-cilium-chaining.md)
  - [04 — NetworkPolicy (default-deny·audit mode)](notes/phase-6/04-networkpolicy.md)
  - [05 — Trivy (5종 스캔·fix-available 차단)](notes/phase-6/05-trivy.md)
  - [06 — PSA (restricted 프로파일)](notes/phase-6/06-psa.md)
  - [07 — Kyverno·cosign (verifyImages·keyless)](notes/phase-6/07-kyverno-cosign.md)
  - [08 — 알림 (SLO·burn rate·runbook)](notes/phase-6/08-alerting.md)
  - [09 — k6 (부하 테스트·threshold)](notes/phase-6/09-k6.md)

- 플랫폼 로드맵 · Phase 7 — DR
  - [01 — HeatWave 백업 (PITR·삭제 보호)](notes/phase-7/01-heatwave-backup.md)
  - [02 — Block Volume 백업 (한도·tag 자동연결)](notes/phase-7/02-block-volume-backup.md)
  - [03 — Velero (S3 호환·CSI snapshot)](notes/phase-7/03-velero.md)
  - [04 — Vault 스냅샷 (Raft·CronJob)](notes/phase-7/04-vault-snapshot.md)
