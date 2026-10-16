# OCI Kubernetes 플랫폼 면접 준비

작성·소스 확인일: **2026-10-16**. 분석 범위는 `oci-always-free-k8s`의 Terraform, Kubernetes 기반 구성, 플랫폼과 CI/CD다. 개별 애플리케이션의 구현과 업무 데이터 흐름은 제외한다.

이 문서는 **Git에 선언된 구성**을 설명한다. 실제 클러스터의 설치 여부, 장애 복구 성공, 성능, 청구액을 검증한 운영 보고서는 아니다. 설계 의도는 코드로 확인한 사실과 구별해 표시한다.

## 읽는 순서

| 문서 | 읽고 나서 설명할 수 있어야 하는 것 |
| --- | --- |
| [파이프라인](notes/oci-interview/01-pipelines.md) | 인프라 생성, 플랫폼 배포, 이미지 배포가 각각 어떻게 진행되는가 |
| [필수 사전 지식](notes/oci-interview/02-prerequisites.md) | 이 구성의 동작과 장애를 이해하는 데 필요한 최소 개념 |
| [데이터 흐름 그래프](notes/oci-interview/03-data-flows.md) | 요청, DNS, 인증서, 관리 접근, 시크릿, 관측 데이터의 이동 |
| [면접 질문과 설명 연습](notes/oci-interview/04-interview.md) | 선택 이유, 제약, 개선 순서를 근거와 함께 말하기 |

## 프로젝트를 한 문장으로 설명하기

> OCI의 제한된 자원 위에 Terraform으로 OKE와 네트워크를 선언하고, Argo CD로 플랫폼 구성을 관리하며, Jenkins의 이미지 검사·서명과 Kyverno의 배포 시 검증을 연결한 Kubernetes 플랫폼입니다.

이 설명은 구성의 요약이다. 비용 절감률, 가용성 수치, 처리량 등의 성과는 측정 자료가 있을 때 추가한다.

## 기술 스택과 맡은 역할

| 영역 | 코드에서 확인한 구성 | 면접에서 설명할 핵심 | 근거 |
| --- | --- | --- | --- |
| 인프라 선언 | Terraform `>=1.12.0`, OCI provider `~>6.0`, OCI backend | state, 의존성 그래프, 변경 계획과 실제 적용 | [provider](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/provider.tf), [모듈 연결](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/main.tf) |
| 클러스터 | OKE Basic, Flannel Overlay, ARM A1.Flex 2노드 | 관리형 제어 평면과 직접 책임지는 워커의 경계 | [OKE 모듈](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/modules/oke/main.tf) |
| 네트워크 | VCN, 4개 subnet, IGW·NAT·Service Gateway, Security List·NSG | 외부 인입, 외부 통신, OCI 내부 서비스 경로 구분 | [networking](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/modules/networking/main.tf), [iam](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/modules/iam/main.tf) |
| 서비스 인입 | OCI NLB, Gateway API, Istio Gateway | L4 전달, TLS 종료, HTTP 라우팅의 역할 분담 | [Gateway](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/infra/istio/gateway.yaml) |
| DNS·인증서 | external-dns, Cloudflare, cert-manager, ACME DNS-01 | 서비스 주소 갱신과 도메인 소유권 증명이 서로 다른 작업인 이유 | [DNS](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/infra/external-dns/values.yaml), [Issuer](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/infra/cert-manager/cluster-issuer.yaml) |
| 메시 구성 | Istio CNI, istiod, ztunnel, namespace ambient label | 제어 평면과 데이터 평면, 외부 TLS와 내부 mTLS의 경계 | [Istio 구성](https://github.com/GGingGGang/oci-always-free-k8s/tree/99b7238/kubernetes/infra/istio), [namespace](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/infra/namespaces/namespaces.yaml) |
| CI | Jenkins JCasC, Kubernetes 동적 agent, Kaniko, Trivy, cosign, GHCR | 빌드 실행 위치, 검사 실패 처리, 서명 키와 이미지 산출물 | [Jenkins values](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/jenkins/values.yaml) |
| CD | Argo CD, AppProject, App of Apps, Helm values | Git desired state를 API 리소스로 만드는 조정 과정 | [root](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/argocd/root.yaml), [Applications](https://github.com/GGingGGang/oci-always-free-k8s/tree/99b7238/kubernetes/platform/argocd/apps) |
| 배포 보안 | PSA, RBAC, Kyverno 이미지 서명 검증 | 실행 권한, API 권한, 이미지 신뢰가 각각 막는 위험 | [RBAC](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/jenkins/rbac.yaml), [이미지 정책](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/kyverno/policies/verify-image-signature.yaml) |
| 시크릿 | Kubernetes Secret, OpenBao Raft, OCI KMS | Secret 전달, 암호화 해제, 데이터 영속성의 차이 | [OpenBao](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/openbao/values.yaml), [KMS](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/modules/kms/main.tf) |
| 데이터 기반 | HeatWave MySQL, Redis, NATS JetStream | 관리형 DB, 메모리 저장소, 메시지 저장소의 장애·영속성 차이 | [DB](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/terraform/modules/database/main.tf), [Redis](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/redis/redis.yaml), [NATS](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/nats/values.yaml) |
| 관측 | Prometheus, Alertmanager, Loki | 메트릭 수집, 알림 전달, 로그 적재가 각각 필요한 이유 | [KPS](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/monitoring/kps/values.yaml), [Loki](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/platform/monitoring/loki/values.yaml) |
| 관리 접근 | Tailscale userspace subnet router | 공개 서비스 경로와 운영자 접근 경로 분리 | [Tailscale](https://github.com/GGingGGang/oci-always-free-k8s/blob/99b7238/kubernetes/infra/tailscale/deployment.yaml) |

## 실제 설정으로 말할 수 있는 범위

| 확인한 사실 | 면접에서 피해야 할 확대 해석 |
| --- | --- |
| 워커는 노드당 2 OCPU·12 GB, 총 4 OCPU·24 GB이며 같은 availability domain에 배치 | “현재 무료 한도 안이다”, “리전 장애에도 고가용성이다” |
| OKE API endpoint는 public이며 외부 6443 접근을 `allowed_cidr` NSG로 허용 | “클러스터 전체가 private이다” |
| 일부 namespace에 ambient label 존재 | “전 구간 STRICT mTLS와 접근 인가를 강제했다” |
| Kyverno는 대상 namespace·이미지에 서명 검증 Enforce, digest 관련 옵션은 false | “모든 이미지가 digest로 고정되어 있다” |
| OpenBao는 Raft 1 replica, 데이터는 `emptyDir`, KMS 값은 placeholder | “HA와 영속화, auto-unseal이 운영 환경에서 검증되었다” |
| Prometheus는 50 Gi PVC, Loki는 같은 PVC의 `loki` subPath 사용 | “로그·메트릭 저장소가 물리적으로 분리되어 있다” |
| Loki Application과 values 존재, Grafana는 `enabled: false`, 수집기 Alloy 선언은 없음 | “전체 로그 수집과 Grafana 조회가 완성되었다” |
| Redis는 `emptyDir`, RDB·AOF 비활성. NATS는 file store와 50 Gi PVC, cluster 비활성 | “모든 데이터 계층이 복제·복구 가능하다” |
| `bao-snapshots` 버킷 선언 존재 | “정기 백업과 복구 훈련이 자동화되어 있다” |

위 표의 근거는 기술 스택 표의 해당 설정 파일이다. 특히 루트 README에는 Loki를 후속 항목으로 소개하는 오래된 문장이 남아 있으므로, 최신 `monitoring/loki/values.yaml`과 `argocd/apps/loki.yaml`을 우선한다.

## 비용 질문에서 꼭 짚을 점

저장소 이름만으로 무료 운영을 보장할 수 없다. **2026-10-16 확인한 Oracle 공식 문서**는 A1 무료량을 월 1,500 OCPU-hour·9,000 GB-hour로 안내한다. 저장소의 총 4 OCPU·24 GB 선언과 구별하고, 테넌트의 적용 혜택과 사용량으로 판단한다. [Oracle Always Free](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

스토리지 비용은 PVC 요청량뿐 아니라 부트 볼륨, 실제 할당량, 백업까지 합쳐 살펴야 한다. Prometheus·NATS의 PVC 선언과 실제 청구량은 같은 개념이 아니다. 면접에서는 “무료 제약을 고려해 설계했으며, 현재 무과금 여부는 청구 내역으로 확인한다”라고 답할 수 있다.

## 출처와 시점

- 인프라 저장소 분석 기준: 커밋 `99b7238`, 커밋 시각 **2026-10-13 14:45 +09:00**. 위 링크는 이 스냅샷에 고정했다.
- CI 실행 순서는 연결된 공유 라이브러리 `f762a6d`, **2026-09-28 21:19 +09:00**를 보조 근거로 사용한다. 개별 서비스 소스는 학습 범위에 넣지 않는다.
- 외부 공식 문서는 **2026-10-16 열람** 기준이다. 원문 작성일을 표시하지 않는 페이지는 작성일 미상으로 취급한다. 열람일을 발행일로 해석하지 않는다.
- 2년 이상 지난 자료를 근거로 추가할 때는 해당 문서의 버전과 현재 설정의 호환 여부를 다시 확인한다.
