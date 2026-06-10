# Alerting (Alertmanager + Slack + SLO/SLI)

## 1. Why — 왜 쓰는가

모니터링은 메트릭 수집만으로는 부족. **사고를 자동 감지해서 적절한 사람에게 적절한 시점에 알림** 보내는 게 운영 핵심. Phase 4의 Prometheus가 메트릭을 수집했다면, Phase 6-B의 Alertmanager는 그걸 actionable alert로 변환.

**알람 없는 모니터링의 문제**:
- 사람이 대시보드를 24/7 보고 있을 수 없음
- 대규모 환경에서 어느 메트릭이 위험한지 사람이 판단 불가
- 사고 발생 → 사용자가 신고 → 알게 됨 (RTO 폭증)

**Alerting의 해결**:
- PromQL 룰로 사고 조건 자동 감지
- Alertmanager가 grouping/silencing/routing 처리
- Slack, Email, PagerDuty 등 채널 통합
- SLO/SLI 정의로 "어느 정도가 사고인가" 객관적 기준

**SLO/SLI**:
- **SLI** (Service Level Indicator): 측정 가능한 지표 (예: 5분 평균 에러율, P99 latency)
- **SLO** (Service Level Objective): SLI 목표값 (예: "에러율 0.1% 미만 99.9% 시간")
- **Error budget**: 1 - SLO. SLO 위반 허용량. 빠르게 소진되면 alert.

**대체재**:
- **Datadog/New Relic monitors**: SaaS, 유료
- **PagerDuty 자체 alert**: PagerDuty가 별도 룰 평가 (덜 일반적)
- **Grafana Alerting**: Grafana 11+ 강력, Alertmanager 대체 가능
- **Alertmanager**: Prometheus 표준. 본 프로젝트 정합.

## 2. Architecture — 어떻게 구성되는가

**컴포넌트**:
- **Prometheus**: PrometheusRule CR 평가, alert 생성
- **Alertmanager**: alert 받아서 routing/grouping/silencing 처리
- **AlertmanagerConfig CR**: namespace 단위 routing 정책
- **Slack**: 알람 수신 채널 (webhook)
- **OCI Notification**: 인프라 레벨 알람 (선택, 인증 복잡)

**Alert lifecycle**:
1. **Pending**: 조건 만족, but `for` 시간 (예: 5분) 안 됨
2. **Firing**: 조건 + for 시간 만족 → Alertmanager로 전송
3. **Resolved**: 조건 해제 → resolved notification

**Alertmanager 기능**:
- **Grouping**: 같은 service의 여러 alert 묶음 (spam 방지)
- **Inhibition**: 한 alert이 다른 alert을 억제 (예: 노드 down 시 그 노드의 Pod alert 무시)
- **Silencing**: 일정 시간 알람 차단 (maintenance window)
- **Routing**: severity별 다른 채널 전송

## 3. Mechanism — 어떻게 돌아가는가

**Alert 생성 흐름**:
1. PrometheusRule CR에 알람 조건 정의 (예: `up{job="login"} == 0 for 5m`)
2. Prometheus가 평가 주기(default 30s)마다 PromQL 실행
3. 조건 만족 시 alert pending → 5분 후 firing
4. Firing alert을 Alertmanager로 push
5. Alertmanager가 grouping 적용 (같은 service 묶음)
6. Inhibition/silencing 평가
7. Routing 룰로 적절한 receiver 결정
8. Slack webhook 호출

**SLO/SLI 평가**:
- SLI를 PrometheusRule의 recording rule로 미리 계산
- 예: `sli:availability:rate5m`로 5분 가용성
- SLO 위반은 error budget burn rate로 alert
- "1시간 burn rate가 14.4 이상이면 critical" (월 SLO 99.9% 기준 = 2일치 budget을 1시간에 소진)

## 4. Integration — 어떻게 연결하는가

본 프로젝트 의존 관계.

- **Prometheus** (Phase 4) — PrometheusRule CR 평가
- **kube-prometheus-stack** — Alertmanager 자동 포함
- **Slack workspace** — webhook URL 발급
- **OCI Notification** (선택) — 인증 복잡, Alertmanager → 어댑터(OCI Function) → Notification
- **Vault** — Slack webhook URL 저장

**알람 elevation** (단계적):
1. Phase 4에서 default rules 활성화 → 인프라 레벨 알람 (노드 down, PV full 등) 즉시 동작
2. Phase 5에서 앱 추가 → 앱별 alert rule 추가
3. Phase 6-B에서 본격 — SLO/SLI 정의 + Slack 채널 분리 + escalation

## 5. Usage — 어떻게 쓰는가

**Alertmanager config** (kube-prometheus-stack values.yaml):

```yaml
alertmanager:
  config:
    global:
      slack_api_url_file: /etc/alertmanager/slack-webhook   # Vault 주입
    
    route:
      receiver: slack-default
      group_by: [namespace, alertname]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
      - matchers: [severity="critical"]
        receiver: slack-critical
        continue: true                # 다음 route도 검사
        group_wait: 0s                # 즉시
      - matchers: [severity="warning"]
        receiver: slack-warning
    
    receivers:
    - name: slack-critical
      slack_configs:
      - channel: "#alerts-critical"
        send_resolved: true
        title: "🔴 {{ .GroupLabels.alertname }}"
        text: |
          {{ range .Alerts }}
          *Service:* {{ .Labels.service }}
          *Severity:* {{ .Labels.severity }}
          *Description:* {{ .Annotations.description }}
          *Runbook:* {{ .Annotations.runbook_url }}
          {{ end }}
    - name: slack-warning
      slack_configs:
      - channel: "#alerts-warning"
        send_resolved: true
    - name: slack-default
      slack_configs:
      - channel: "#alerts-general"
    
    inhibit_rules:
    - source_matchers: [severity="critical"]
      target_matchers: [severity="warning"]
      equal: [namespace, alertname]
```

**PrometheusRule 예시 (앱 알람)**:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: login-alerts
  namespace: app
  labels:
    release: prometheus
spec:
  groups:
  - name: login.availability
    rules:
    # SLI recording rule
    - record: sli:login:availability:rate5m
      expr: |
        sum(rate(http_requests_total{job="login",status!~"5.."}[5m]))
        / sum(rate(http_requests_total{job="login"}[5m]))
    
    # SLO alert (burn rate)
    - alert: LoginErrorBudgetBurnFast
      expr: |
        (1 - sli:login:availability:rate5m) > 0.001 * 14.4
      for: 5m
      labels:
        severity: critical
        service: login
      annotations:
        summary: "Login error budget burning fast"
        description: "Login SLO 99.9% budget will be exhausted in <2 days at current rate"
        runbook_url: "https://wiki.example.com/runbook/login-slo"
    
    # 일반 알람
    - alert: LoginHighLatency
      expr: |
        histogram_quantile(0.99, 
          sum by (le) (rate(http_request_duration_seconds_bucket{job="login"}[5m]))
        ) > 1
      for: 10m
      labels:
        severity: warning
        service: login
      annotations:
        summary: "Login P99 latency > 1s for 10m"
```

**Silencing** (maintenance window):

```bash
# UI에서 silence 생성 또는 amtool 사용
amtool silence add \
  --alertmanager.url=http://alertmanager.monitoring.svc:9093 \
  alertname=LoginHighLatency \
  --duration=1h \
  --comment="Planned DB upgrade"
```

## 6. Configuration — 어떤 설정이 있는가

**Route 옵션**:
- `group_by`: 같이 묶을 label
- `group_wait`: 첫 alert 후 추가 alert 기다림 (default 30s)
- `group_interval`: 같은 group 알람 재전송 간격
- `repeat_interval`: 동일 alert 재알람 간격 (default 4h)
- `matchers`: routing 조건 (label 매칭)

**Slack 옵션**:
- `channel`: 채널명
- `send_resolved`: 해결 시 알림 (recommended true)
- `title`, `text`: Go template 형식
- `actions`: 버튼 추가 가능 (silence, ack 등)

**SLO 표준 burn rate**:
- 1시간 14.4: 2일 안에 월 SLO budget 소진 → critical
- 6시간 6: 12일 안에 소진 → warning
- 3일 1: 정상 페이스 → 정보성
- Google SRE book 권장

**Severity 정의** (본 프로젝트):
- **critical**: 즉시 대응 필요. 서비스 영향. Slack critical 채널 + (운영 환경이면) PagerDuty
- **warning**: 단기 추세 악화. 영업시간 내 대응. Slack warning 채널
- **info**: 참고만. Slack general

## 7. Compatibility — 어떤 호환성이 요구되는가

- **Alertmanager 0.27+** (kube-prometheus-stack 70.x+에 포함)
- **PrometheusRule v1**
- **Slack webhook**: workspace admin이 발급
- **Grafana Alerting** (대안): Grafana 11+ unified alerting
- **OCI Notification**: HTTPS 직접 호출 불가 (서명 인증), 어댑터 필요

## 8. 면접 예상 질문 & 답변

**Q1. SLO/SLI/SLA 차이가 뭐예요?**
> SLI(Service Level Indicator)는 측정 가능한 지표 — 5분 평균 에러율, P99 latency 같은 수치. SLO(Service Level Objective)는 SLI의 목표 — "에러율 0.1% 미만 99.9% 시간". SLA(Service Level Agreement)는 SLO를 계약화한 것 — 위반 시 환불 등 외부 약속. SLA는 보통 SLO보다 느슨하게 (예: SLO 99.9%, SLA 99.5%). 본 프로젝트는 SLO 정의 + error budget burn rate로 alert. SLA는 포트폴리오 범위 밖.

**Q2. Error budget burn rate가 뭐고 왜 중요해요?**
> SLO 위반 허용량(error budget)이 얼마나 빠르게 소진되는지 측정합니다. 월 SLO 99.9%면 한 달에 0.1% (~43분) 다운타임 허용. 1시간 burn rate 14.4면 "현재 페이스로 2일 안에 한 달치 budget 소진" — critical. 6시간 burn rate 6이면 "12일 소진" — warning. 단순 임계값 alert("에러율 1% 넘었어")보다 정확함 — 짧은 spike는 무시, 지속적 악화만 잡음. Google SRE book 표준 패턴.

**Q3. Alertmanager grouping이 왜 중요해요?**
> Alert spam 방지입니다. 노드 1개 down 시 그 노드의 모든 Pod alert이 동시에 100개 발생할 수 있는데, grouping 없으면 Slack에 100개 메시지가 1초에 쏟아져서 진짜 문제를 못 봅니다. `group_by: [alertname, namespace]`로 묶으면 "Node X down + Pod 100개 영향"이 한 메시지로 묶임. 본 프로젝트는 alertname + namespace로 grouping.

**Q4. Inhibition vs Silencing 차이는?**
> Inhibition은 자동, alert 간 관계 기반. "Node down alert이 firing이면 그 노드의 Pod alert 자동 억제" — 매번 노드 down 마다 자동 적용. Silencing은 수동, 시간 기반. "내일 새벽 DB 업그레이드 동안 LoginHighLatency alert 차단" — 운영자가 명시적으로 설정. 본 프로젝트는 inhibition rules에 critical → warning 억제 (같은 alertname + namespace) 정의해서 같은 사고가 critical/warning 둘 다 발생하면 critical만 알림.

**Q5. Slack 한 채널에 다 보내면 안 좋은가요?**
> Severity 분리가 중요합니다. 본 프로젝트 패턴: (1) `#alerts-critical` — P1 사고, 즉시 대응 필요. 핸드폰 알림 ON. (2) `#alerts-warning` — 영업시간 내 대응. 핸드폰 알림 OFF. (3) `#alerts-general` — info성, archive 용도. 같은 채널에 다 보내면 critical이 warning에 묻혀서 늦게 발견. 또 warning이 너무 많으면 critical 알람도 무시하게 되는 alert fatigue 위험.

**Q6. Alertmanager 자체가 죽으면 어떻게 되나요?**
> Alert이 발생해도 Slack으로 안 보내져서 사람이 모릅니다. 이게 monitoring의 가장 위험한 single point of failure. 방어: (1) Alertmanager HA — kube-prometheus-stack의 alertmanager.replicas: 3 (본 프로젝트는 자원 제약상 1), (2) Alertmanager dead man's switch — "10분마다 firing되는 alert을 외부 모니터링이 받음, 안 받으면 Alertmanager 자체가 문제"는 패턴, (3) Prometheus 자체에서 Alertmanager up 메트릭 alert. 본 프로젝트는 (3) 적용.

**Q7. OCI Notification 안 쓴 이유는?**
> OCI Notification은 HTTPS endpoint 호출에 OCI 서명 인증이 필요해서 Alertmanager webhook이 직접 호출 불가. 어댑터(OCI Function 또는 oci-cli sidecar) 필요. 복잡도 vs 가치 trade-off에서 본 프로젝트는 Slack 단일 채널로 단순화. OCI Notification은 인프라 레벨 알람(노드 장애 등)에 OCI 자체가 발송하는 방식만 사용. 면접에서 "production 환경에서 Slack 의존 분산 필요하면 PagerDuty 추가 검토"라 답변.

**Q8. runbook_url 같은 annotation이 왜 중요해요?**
> 새벽 3시에 alert 받은 on-call 엔지니어가 첫 5분 안에 대응 시작해야 합니다. alert 메시지에 "에러 났음" 만 있고 대응 방법이 없으면 매번 wiki 찾기 시간 낭비. runbook_url annotation으로 "이 alert 발생 시 (1) 이걸 확인, (2) 이렇게 mitigate, (3) 안 되면 X에게 escalate" 같은 step-by-step 가이드 링크. 본 프로젝트는 모든 alert에 runbook_url 표준화. 운영 성숙도 시그널.

**Q9. PrometheusRule을 namespace별로 분리 vs 중앙 관리?**
> 본 프로젝트는 namespace별 분리. 사유: (1) 각 service 팀이 자기 alert 직접 작성, (2) RBAC 분리 가능 (앱 팀이 monitoring NS 권한 없어도 자기 NS rule 추가), (3) GitOps에서 service 매니페스트와 함께 관리. 단점은 cross-cutting alert(전체 클러스터 노드 health 등)이 분산 — 이건 monitoring NS에 cluster-wide PrometheusRule 별도. Kyverno generate 정책으로 새 namespace 만들면 기본 PrometheusRule 자동 생성도 가능.

**Q10. Alert 너무 많이 와요. 어떻게 줄여요?**
> "Alert fatigue" 흔한 문제. 해결: (1) Severity 엄격하게 — warning 남발 금지, 진짜 대응 필요한 것만, (2) `for` 시간 길게 — 짧은 spike는 무시, 지속 5분-10분 이상만, (3) Burn rate 기반 SLO alert — 단순 임계값 대신 추세 기반, (4) Inhibition 적극 활용 — 상위 alert이 하위 alert 자동 억제, (5) 정기 review — 매월 firing 안 한 alert / 매번 무시되는 alert 정리. 본 프로젝트는 처음부터 보수적으로 alert 정의하고 누적 안 되게 관리.
