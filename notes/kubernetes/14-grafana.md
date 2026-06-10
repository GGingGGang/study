# Grafana (Grafana)

> 쿠버네티스 · 인프라/옵저버빌리티 · 학습내용: 시각화·대시보드 도구의 역할, 데이터소스(시계열/로그/트레이스) 연결, 패널·쿼리·템플릿 변수, 알럿팅, 코드로 관리하는 프로비저닝, 폴더·권한

---

## 1. Grafana가 뭐고 왜 쓰나

**Grafana**는 여러 데이터소스의 데이터를 **질의해 대시보드로 시각화**하는 오픈소스 도구다. 자체적으로 데이터를 저장하지 않고, **외부 저장소(Prometheus·Loki·Tempo·DB 등)에 질의해 그래프·표·게이지로 보여 준다.**

옵저버빌리티에서 역할 분담을 보면:

- 메트릭 저장·질의는 **Prometheus**, 로그는 **Loki**, 트레이스는 **Tempo**가 한다.
- Grafana는 이들을 **한 화면에 모아 보고, 사람이 이해할 수 있게 시각화**하고, **알림**까지 거는 "관제 콘솔" 역할이다.

흩어진 지표를 도구마다 CLI로 따로 보는 대신, Grafana로 **하나의 대시보드에서 메트릭·로그·트레이스를 교차로** 본다(예: 그래프에서 스파이크를 클릭 → 그 시간대 로그로 점프).

## 2. 데이터소스 (Data Source)

Grafana가 데이터를 가져오는 연결 대상이다. 데이터소스마다 **쿼리 언어가 다르다**.

| 데이터소스 | 종류 | 쿼리 언어 |
|------------|------|-----------|
| **Prometheus** | 메트릭(시계열) | PromQL |
| **Loki** | 로그 | LogQL |
| **Tempo** | 분산 트레이스 | TraceQL |
| RDB(MySQL/Postgres 등) | 관계형 | SQL |

★ 데이터소스끼리 **연계**도 된다. 예를 들어 Loki 로그의 `trace_id`에서 Tempo 트레이스로 점프하거나, 메트릭 그래프의 한 지점에서 같은 라벨의 로그로 이동한다(데이터 링크/derived fields). 이게 "한 화면에서 메트릭→로그→트레이스로 파고드는" 옵저버빌리티의 핵심 흐름이다.

## 3. 대시보드 · 패널 · 쿼리

구조는 **대시보드 ⊃ 패널 ⊃ 쿼리**다.

- **패널(Panel)**: 시각화의 기본 단위. 하나의 그래프·표·게이지·통계 등. 패널마다 데이터소스와 쿼리를 가진다.
- **쿼리(Query)**: 패널이 데이터소스에 던지는 질의(PromQL/LogQL 등). 하나의 패널에 여러 쿼리를 겹쳐 그릴 수 있다.
- **대시보드(Dashboard)**: 패널들을 모아 놓은 한 페이지. JSON 모델로 표현된다(그래서 코드로 관리 가능).

## 4. 템플릿 변수 (Template Variable)

대시보드를 **재사용 가능하게** 만드는 핵심 기능이다. 값을 하드코딩하는 대신 **변수**를 두고, 화면 위 드롭다운으로 바꾼다. ★★★

```promql
# 변수 $namespace, $app 을 쿼리에 끼워 넣는다
sum(rate(http_requests_total{namespace="$namespace", app="$app"}[5m]))
```

- 변수 값은 **데이터소스에 질의해 자동으로 채운다**(예: `label_values(http_requests_total, namespace)` → 현재 존재하는 네임스페이스 목록).
- 덕분에 네임스페이스/앱마다 대시보드를 따로 만들 필요 없이 **하나의 대시보드를 드롭다운으로 전환**해 본다.
- 다중 선택(multi-value)·전체(All)도 지원.

★ 면접에서 "대시보드를 어떻게 재사용 가능하게 만드나?" → **템플릿 변수로 데이터소스에서 동적으로 목록을 채워 필터링**한다고 답하면 좋다.

## 5. 알럿팅 (Alerting)

Grafana는 자체 **통합 알럿팅**으로 데이터소스 쿼리 결과가 조건을 넘으면 알림을 보낸다.

- **알럿 룰**: "이 쿼리 결과가 임계치를 N분 이상 넘으면 발화" 형태로 정의.
- **컨택트 포인트(Contact point)**: Slack·Email·PagerDuty 등 알림 대상.
- **노티피케이션 정책**: 라벨로 알림을 라우팅·그룹화.

> 참고: 메트릭 알럿은 Prometheus의 Alertmanager로도 처리한다. Grafana 알럿팅은 **여러 데이터소스(로그·DB 포함)에 걸쳐** 룰을 만들 수 있다는 점이 다르다.

## 6. 프로비저닝 (코드로 관리)

대시보드·데이터소스·알럿을 **UI에서 손으로 만들면 재현도 버전관리도 안 된다.** 프로비저닝은 이를 **YAML/JSON 파일로 선언해 Grafana 시작 시 자동 적용**하는 방식이다(GitOps 친화적). ★★★

데이터소스 프로비저닝 예:

```yaml
# /etc/grafana/provisioning/datasources/datasources.yaml
apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus-server.monitoring.svc:9090
    isDefault: true
  - name: Loki
    type: loki
    access: proxy
    url: http://loki.monitoring.svc:3100
```

- 대시보드도 JSON 파일 + provider 설정으로 디스크에서 자동 로드.
- 쿠버네티스에선 보통 **ConfigMap**으로 마운트하거나, **Grafana Operator**의 `GrafanaDashboard`/`GrafanaDatasource` CRD로 선언한다. kube-prometheus-stack은 ConfigMap에 `grafana_dashboard` 라벨이 붙은 대시보드를 사이드카가 자동 로드해 준다.

★ "Grafana를 어떻게 코드로 관리하나?" → **프로비저닝(데이터소스·대시보드를 파일/CRD로 선언)** → Git에 두고 GitOps로 배포.

## 7. 폴더 · 권한

- **폴더(Folder)**: 대시보드를 그룹으로 묶는 단위. 폴더 단위로 권한을 준다.
- **권한(RBAC)**: 사용자·팀·역할(Viewer/Editor/Admin)별로 폴더·대시보드 접근을 제어. 조직(Organization)/팀(Team) 단위 관리.

### 한 줄 요약
Grafana는 데이터를 저장하지 않고 **Prometheus(메트릭)·Loki(로그)·Tempo(트레이스) 등 데이터소스에 질의해 대시보드로 시각화**하고 알림을 거는 관제 콘솔이다. **템플릿 변수**로 대시보드를 재사용 가능하게 만들고, **프로비저닝(파일/CRD)**으로 데이터소스·대시보드를 코드로 관리하는 것이 실무·면접의 핵심이다.

### 참고 (공식 문서)
- 데이터소스: https://grafana.com/docs/grafana/latest/datasources/
- 대시보드·패널: https://grafana.com/docs/grafana/latest/dashboards/
- 템플릿 변수: https://grafana.com/docs/grafana/latest/dashboards/variables/
- 알럿팅: https://grafana.com/docs/grafana/latest/alerting/
- 프로비저닝: https://grafana.com/docs/grafana/latest/administration/provisioning/
