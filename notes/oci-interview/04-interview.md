# 면접 질문과 설명 연습

기준일: **2026-10-16**. 답변은 선언된 구성에 근거한 예시다. 직접 수행한 운영·실험·성과는 본인의 기록으로 뒷받침되는 범위에서 덧붙인다. 개별 애플리케이션 구현은 다루지 않는다.

## 90초 프로젝트 소개 예시

> OCI의 제한된 자원에서 인프라부터 배포까지 일관되게 관리하는 Kubernetes 플랫폼을 구성했습니다. Terraform이 네트워크와 OKE Basic, ARM 워커, 데이터베이스와 KMS를 선언하고, Argo CD가 플랫폼별 Helm chart와 Git values를 동기화하도록 구성했습니다.
>
> 외부 요청은 OCI NLB에서 Istio Gateway로 전달되고, cert-manager와 external-dns가 인증서와 DNS 갱신을 담당합니다. Jenkins는 동적 agent에서 이미지를 빌드한 뒤 취약점 검사와 서명을 거쳐 GitOps 태그를 변경합니다. Kubernetes admission에서는 Kyverno가 대상 이미지 서명을 검증합니다.
>
> 자원 절약을 위해 단일 인스턴스와 비영속 구성을 사용한 부분이 있어, 가용성과 데이터 복구의 한계를 구분해서 설명하고 있습니다. 현재 우선 확인할 과제는 OpenBao의 영속성, 공유 관측 볼륨의 용량, 테넌트의 무료 적용 범위입니다.

근거: [스택과 제약](notes/oci-interview/00-overview.md), [파이프라인](notes/oci-interview/01-pipelines.md). “구성했습니다”라는 표현은 본인이 설계·구축한 범위에 맞게 조정한다.

## 자주 받을 질문과 답변의 핵심

| 질문 | 이 프로젝트에 맞는 답변 | 이어질 질문 |
| --- | --- | --- |
| 왜 OKE Basic과 ARM인가? | 관리형 제어 평면과 제한된 자원 예산을 고려한 선택으로 해석할 수 있다. ARM 이미지 호환성과 직접 관리할 워커 책임이 생긴다. 선택 동기의 확정 근거가 없으면 설계 해석이라고 밝힌다 | 빌드 이미지와 실행 이미지가 ARM64인지 어떻게 확인했나? |
| 워커 두 대면 HA인가? | 같은 AD이고 여러 플랫폼이 단일 인스턴스다. 복제·배치·볼륨·외부 의존성까지 봐야 한다 | 노드 한 대 장애 시 재배치 가능한 여유 자원은? |
| 왜 subnet을 나눴나? | API, 외부 LB, worker, DB를 분리하고 각 경로·허용 포트를 따로 선언했다 | API는 왜 public이며 누가 6443에 접근 가능한가? |
| NLB와 Gateway가 중복 아닌가? | NLB는 외부 L4 연결을 전달하고 Istio Gateway는 TLS 종료와 HTTPRoute 적용을 담당한다 | 인증서가 잘못됐을 때 어느 계층을 먼저 볼까? |
| 왜 external-dns와 cert-manager 둘 다 필요한가? | 주소 레코드 관리와 인증서 발급·갱신은 별도 작업이다 | 각 TXT 레코드는 어떤 목적이며 누가 지우는가? |
| ambient면 보안이 끝난 건가? | namespace enrollment와 STRICT 강제·인가 정책은 다르다. 현재 저장소에 후자의 정책이 없음을 밝힌다 | L4와 L7의 정책·관측 범위는 어떻게 다른가? |
| Terraform과 Argo CD는 어떻게 나눴나? | Terraform은 OCI 리소스, Argo CD는 Kubernetes 플랫폼 리소스를 관리한다. 초기 설치·Secret 준비는 별도다 | 두 도구가 동일 리소스를 관리하면 어떤 문제가 생기나? |
| App of Apps면 전부 자동인가? | 부모는 자식 Application을 자동 반영하지만 현재 플랫폼 자식 앱은 수동 sync다 | Git values가 바뀌었는데 배포가 안 되면 어디를 볼까? |
| Jenkins에서 바로 kubectl apply하면 안 되나? | 현재는 CI 산출물을 GitOps 상태로 기록하고 Argo CD가 동기화한다. 변경 이력과 배포 책임을 명확히 한다 | main 직접 push의 승인·동시 갱신 위험은? |
| Trivy·cosign·Kyverno가 각각 필요한 이유는? | 취약점 검사, 산출물 서명, 배포 시 신뢰 검증을 서로 다른 시점에 수행한다 | 스캔 실패 이미지도 이미 registry에 있지 않나? |
| Git SHA 태그를 쓰면 불변인가? | 추적에는 유리하지만 태그 재지정을 자동으로 금지하지는 않는다. 현재 digest 고정 옵션은 꺼져 있다 | 빌드·스캔·서명·배포가 동일 digest를 가리키게 하려면? |
| KMS auto-unseal이면 OpenBao 데이터는 안전한가? | 키 접근과 데이터 보존은 별도다. 현재 emptyDir·1 replica로 Pod 교체 시 데이터 유실 위험이 있다 | snapshot은 어디서 만들며 복원 검증은 했나? |
| Prometheus와 Loki가 왜 같은 PVC를 쓰나? | 추가 볼륨을 피하려는 구성으로 해석된다. 용량·노드·장애 경계를 공유하는 대가가 있다 | 메트릭 retention 상한과 로그 사용량이 충돌하면? |
| 비용이 정말 0원인가? | 현재 선언값을 무료량으로 단정할 수 없다. 테넌트 사용량·무료 혜택·청구 자료가 필요하다 | 부트 볼륨·백업·네트워크까지 포함했나? |

모든 구현 사실의 출처는 [스택 표](notes/oci-interview/00-overview.md), [파이프라인 단계별 근거](notes/oci-interview/01-pipelines.md), [흐름별 소스](notes/oci-interview/03-data-flows.md)에 있다. 설계 이유가 주석·결정 기록으로 확정되지 않은 경우 위 답변은 코드에서의 추론이다.

## 장애 시나리오로 설명 연습하기

### 공개 webhook이 도착하지 않는다

**확인 순서:** DNS 주소 → NLB backend health → Gateway listener·TLS → HTTPRoute Accepted·ResolvedRefs → Service endpoint → Jenkins 응답.

DNS는 정상인데 TLS가 실패하면 인증서·listener를 확인하고, TLS가 성공했는데 404면 host/path 및 backend 라우팅을 확인한다. 5xx는 status code의 발생 주체와 upstream 연결 상태를 함께 확인한다. 한 증상만으로 계층을 단정하지 않는다.

### CI는 성공했지만 새 이미지가 실행되지 않는다

**확인 순서:** GitOps 실제 커밋·태그 → Argo targetRevision·자동 sync 설정 → diff·Sync·Health → admission 이벤트 → image pull → rollout·readiness.

Jenkins의 성공 범위가 Git push까지라는 점과 플랫폼 자식 앱의 수동 sync를 먼저 설명한다. 현재 리소스의 실패 이벤트를 보기 전에 pipeline 전체를 다시 실행하는 식으로 답하지 않는다.

### 노드 하나가 내려갔다

**확인 순서:** 노드 조건 → 영향받은 Pod → replica·배치 조건·남은 requests → PVC attachment·접근 모드 → 재기동 후 데이터 상태.

특히 관측 노드 라벨이 한 노드에만 있으면 Prometheus와 Loki의 이동이 제한될 수 있다. Redis 메모리, OpenBao emptyDir, NATS PVC를 같은 복구 방식으로 묶지 않는다.

### 메트릭과 로그 저장이 함께 불안정하다

**확인 순서:** 공유 PVC 사용량·I/O → Prometheus와 Loki 오류 → WAL·보존 정리 → 노드 자원 압박.

파일을 지워 복구하는 명령부터 제안하지 않는다. 먼저 데이터 소유 경로와 보존·복구 가능성을 확인한다. 향후 개선은 별도 볼륨, 보존량 조정, 저장소 분리 등을 비용과 함께 판단한다.

## 운영 상태를 확인할 때 사용할 읽기 명령

아래는 **실행하지 않은 확인용 명령**이다. 올바른 kube context와 권한을 가진 환경에서 사용한다. API·도구 버전에 따라 리소스 이름과 필드를 확인한다.

```bash
kubectl config current-context
kubectl get nodes -o wide
kubectl get pods -A -o wide
kubectl get events -A --sort-by=.lastTimestamp
kubectl get applications -n cicd
kubectl get gateway,httproute -A
kubectl describe gateway public-gateway -n istio-system
kubectl get certificate,certificaterequest -A
kubectl get orders.acme.cert-manager.io,challenges.acme.cert-manager.io -A
kubectl get endpointslices.discovery.k8s.io -A
kubectl get pvc -A
kubectl get pv
kubectl get clusterpolicy
kubectl get peerauthentications.security.istio.io,authorizationpolicies.security.istio.io -A
kubectl auth can-i create pods --as=system:serviceaccount:cicd:jenkins -n build
kubectl top nodes
kubectl top pods -A
```

`auth can-i --as`에는 impersonation 권한이 필요하고 `top`은 metrics-server에 의존한다. 명령 성공 자체보다 그 결과가 흐름의 어느 연결을 확인하는지 말하는 것이 중요하다.

## 개선 우선순위를 묻는다면

다음은 **면접용 개선 제안**이며 실제 변경이나 검증 완료 항목이 아니다.

1. **유실 위험부터:** OpenBao 영속화와 백업·복원, HeatWave 삭제 보호·백업 정책을 확인한다. 잃으면 재구축하기 어려운 데이터가 우선이다.
2. **운영 예산 확인:** A1 무료 적용 범위, 실제 부트·데이터 볼륨과 백업 사용량, 공유 PVC 여유를 확인한다.
3. **배포 신뢰 보강:** digest 기준의 검사·서명·배포 일관성, 서명 키 접근·회전, main 직접 push 통제를 검토한다.
4. **장애 범위 줄이기:** 관측 저장소 공유와 단일 노드 배치, 단일 데이터 구성 요소의 복구 목표를 정한다.
5. **필요한 관측 완성:** 실제 수집할 로그와 접근 권한을 정한 뒤 수집기를 연결한다. 설치 도구 수보다 장애 탐지·원인 확인에 필요한 신호를 우선한다.

## 면접 직전 연습

- 빈 종이에 [파이프라인](notes/oci-interview/01-pipelines.md)의 세 흐름을 각각 그린다.
- [데이터 흐름](notes/oci-interview/03-data-flows.md)에서 DNS·TLS·API·Secret·메트릭 경로를 소리 내어 설명한다.
- 질문 하나당 **현재 설정 → 선택 이유 또는 추론 → 제약 → 확인 근거** 순서로 1분 안에 답한다.
- 직접 경험한 장애 사례가 있으면 증상·확인한 사실·조치·결과를 운영 기록으로 보충한다. 확인하지 않은 성능·비용·복구 성과는 만들지 않는다.
