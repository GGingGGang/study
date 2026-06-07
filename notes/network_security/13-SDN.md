# Ch13. SDN (Software-Defined Networking) 정리

## 0. 사전 개념: Data Plane vs Control Plane (p.5–6)
- **Data plane**: **각 라우터의 로컬 기능**. input 포트로 들어온 datagram을 어느 output 포트로 **forwarding**할지 결정(나노초 단위, 하드웨어).
- **Control plane**: **네트워크 전체 로직**. 출발지→목적지 end-to-end **경로(routing)** 를 결정(밀리초 단위, 소프트웨어).
- 두 가지 control plane 방식:
  - **전통 방식**: routing 알고리즘이 **각 라우터 안에** 분산 구현(per-router control plane, p.7).
  - **SDN**: control plane을 **(원격) 서버 = controller** 로 분리·집중(logically centralized, p.8).

---

## 1. SDN이 왜 개발되었는가?

전통 네트워크의 한계 때문(p.18, 21–23):
- **관리가 어렵고 오류가 잦다**: 라우터마다 분산 프로토콜(LS/DV)이 돌아 설정이 복잡하고 misconfiguration이 생기기 쉽다.
- **유연성 부족 — Traffic Engineering 예시**:
  - "u→z는 uvwz로, x→z는 xwyz로 보내고 싶다" → **link weight를 조정해 라우팅이 우연히 그렇게 계산되게** 해야 함(간접적·어려움).
  - "u→z 트래픽을 두 경로로 **load balancing**" → 목적지 기반 + LS/DV로는 **불가능**(새 알고리즘 필요).
  - "라우터 w에서 **빨강/파랑 트래픽을 다르게** 라우팅" → 목적지 기반 forwarding으로는 **불가능**.
- **닫힌(proprietary) 구조 → 혁신이 느림**: 벤더가 하드웨어+control plane+기능을 수직 통합.

→ 그래서 **control plane을 데이터 평면에서 분리해 중앙에서 "프로그래밍"** 하자는 패러다임이 SDN. 중앙에서 표(table)를 계산해 배포하면 관리가 쉽고 유연하며, **개방형(open) 구현**으로 빠른 혁신이 가능.

---

## 2. 기존 네트워크 vs SDN 환경 — 차이점

| 구분 | 전통 네트워크 | SDN |
|------|---------------|-----|
| Control plane 위치 | **각 라우터 안에 분산** | **중앙 controller로 분리·집중** |
| Control/Data 관계 | 한 박스에 **수직 통합** | **분리(separation)** |
| 경로 결정 | 분산 알고리즘(LS/DV) 협상 | controller가 계산 후 flow table 배포 |
| Forwarding | **목적지 IP 기반** | **일반화된 flow 기반(match+action)** |
| 프로그래밍 | 어려움(라우터별) | 쉬움(중앙 집중 프로그래밍) |
| 구조/혁신 | 닫힘, proprietary, 느림 | 열림(open interface), 빠름 |

전통 라우터: input ports(line termination, lookup/forwarding, queueing) → switching fabric → output ports, routing processor. forwarding은 **longest prefix matching**(TCAM으로 1 clock에 매칭). SDN은 이 forwarding을 **controller가 채우는 flow table**로 일반화.

---

## 3. 19쪽 · 20쪽 — SDN의 핵심 논거(분리·개방의 유추)

### p.19 — Analogy: Mainframe → PC Evolution
- **왼쪽(메인프레임)**: Specialized Applications / Specialized OS / Specialized Hardware가 **수직 통합**. 닫힘·proprietary, 혁신 느림, 작은 산업.
- **오른쪽(PC)**: **Open Interface**로 계층 분리 → 위에 다양한 App, 가운데 OS(Windows/Linux/Mac 선택), 아래 commodity Microprocessor. **수평적·개방형 → 빠른 혁신, 거대 산업.**
- 메시지: 수직 통합을 **개방형 인터페이스로 수평 분해**하면 산업 전체가 폭발적으로 혁신한다(N. McKeown).

### p.20 — Traditional Network → SDN (위 유추를 네트워크에 적용)
- **왼쪽(전통 라우터)**: Specialized Features / Specialized **Control Plane** / Specialized Hardware = 수직 통합(Cisco式 closed box).
- **오른쪽(SDN)**: **Open Interface**로 분해 → 위에 다양한 App, 가운데 **Control Plane(선택 가능, open interface)**, 아래 commodity **Merchant Switching Chips**. → 수평·개방 → 빠른 혁신.
- 즉 **PC가 메인프레임을 깬 것처럼, SDN이 닫힌 라우터를 깬다.** Open interface의 실체가 곧 **OpenFlow**.

---

## 4. SDN의 각 레이어 — 무엇을 하나, 핵심은? (p.24–28)

아래에서 위로 (SDN의 4요소):

1. **Data-plane switches (맨 아래)** — p.25
   - **빠르고 단순한 commodity switch**. 하드웨어로 **일반화된 forwarding(match+action)** 만 수행.
   - flow table은 **controller가 계산·설치**. switch 자신은 "지능"이 없다.
   - controller와 통신/제어 프로토콜 = **OpenFlow**.

2. **SDN Controller (network OS, 가운데)** — p.26·28
   - **네트워크 전체 상태(state) 유지·관리**(토폴로지, 링크상태, 호스트/스위치 정보, 통계, flow table).
   - 위(앱)와는 **northbound API**, 아래(스위치)와는 **southbound API(OpenFlow/SNMP/OVSDB)** 로 연결.
   - 성능·확장·내결함성을 위해 **분산 시스템**으로 구현 가능.
   - 내부 3층(p.28): communication layer(장치와 통신) / network-wide state management(상태 저장) / interface layer(앱에 추상화 제공).

3. **Network-control applications (맨 위)** — p.27
   - control의 **"두뇌"**: routing, access control, load balancing 등 **실제 정책**을 controller가 주는 API로 구현.
   - **Unbundled**: controller·벤더와 분리되어 **3rd party**가 제공 가능.

> **레이어 중 핵심 = SDN Controller(중앙 집중 control plane)**. 네트워크의 "brain"으로서 전체 상태를 갖고 northbound(앱)·southbound(스위치)를 매개한다. SDN을 가능케 하는 두 축은 **① control/data plane 분리 + ② 논리적으로 중앙집중된 controller**.

---

## 5. OpenFlow의 핵심 (p.29–35)

### OpenFlow = controller↔switch 표준 프로토콜 + flow table 추상화
- controller와 switch 사이에서 **TCP로 메시지 교환**(옵션 암호화). 3종류 메시지:
  - **Controller→Switch**: `features`, `configure`, **`modify-state`(flow entry 추가/삭제/수정)**, `packet-out`.
  - **Switch→Controller(asynchronous)**: **`packet-in`**(매칭 안 된 패킷을 controller로), `flow-removed`, `port-status`.
  - **Symmetric**: hello/echo 등.

### 핵심 추상화 = "Flow Table의 match + action" (p.32–35)
각 switch는 **flow table**(controller가 계산·배포)을 갖고, 들어온 패킷을 **match → action**으로 처리.

**Flow entry 구조 (p.35)** = `Rule(match) | Action | Stats(counters)`
- **Match 필드(여러 계층을 한꺼번에)**: `Switch Port | VLAN ID | MAC src | MAC dst | Eth type | IP Src | IP Dst | IP Prot | TCP sport | TCP dport` (Link+Network+Transport 헤더 필드). `*`(wildcard) 허용.
- **Action(예)**: ① 특정 port(들)로 forward ② controller로 encapsulate&forward ③ drop ④ normal pipeline으로 ⑤ **필드 수정(modify-fields)**.
- **Priority**(겹치는 패턴 구분), **Counters**(#packets, #bytes).

> OpenFlow의 핵심: **"flow(헤더 필드 조합)를 match하면 정해진 action을 한다"** 는 **일반화된 forwarding**. 목적지 IP만 보던 전통 forwarding을 **L2~L4 임의 필드 매칭 + 임의 action**으로 일반화하고, 그 table을 **controller가 채운다.**

---

## 6. match+action으로 구현 가능한 것들 (p.36–39)

하나의 match+action 추상화로 **여러 종류의 장비를 통합**할 수 있다(p.38):

| 장치 | match | action |
|------|-------|--------|
| **Router** | longest destination IP prefix | 해당 link로 forward |
| **Switch(L2)** | destination MAC | forward 또는 flood |
| **Firewall** | IP 주소 + TCP/UDP 포트 | permit / deny(drop) |
| **NAT** | IP 주소 + port | 주소·포트 rewrite(modify-fields) |

구체 예:
- **목적지 기반 forwarding**: `IP Dst=51.6.0.8 → port6`.
- **L2 forwarding**: `MAC src=22:A7:23:11:E1:02 → port3`.
- **방화벽**: `TCP dport=22 → drop`(SSH 차단), `IP Src=128.119.1.1 → drop`(특정 호스트 차단).
- **load balancing / 정책 라우팅**: `IP Src=10.3.*.*, IP Dst=10.2.*.* → forward(3)` (p.39) — 출발지까지 보고 경로를 정함(전통 방식으론 불가했던 것).

→ 즉 **router, switch, firewall, NAT, load balancer, 정책 기반 라우팅**을 전부 같은 flow table 규칙으로 표현·구현 가능.

### Control/Data plane 상호작용 예 (p.40–41)
링크 장애 발생 → switch가 **OpenFlow `port-status`** 로 controller에 통지 → controller가 링크상태 갱신 → 등록돼 있던 **Dijkstra(link-state) 앱 호출** → 새 경로 계산 → controller가 **OpenFlow로 새 flow table을 스위치에 설치**. (컨트롤러 예: OpenDaylight/ODL, ONOS — ONOS의 **Intent framework**는 "어떻게"가 아닌 "무엇을" 명세.)

---

## 7. SDN: Selected Challenges (p.44)

- **Control plane = 네트워크의 두뇌 → 집중화의 위험**
  - **보안**: controller가 **탈취되면 네트워크 전체가 위험**(단일 고가치 표적).
  - **견고성(robustness)**: **단일 controller가 모든 이벤트를 감당할 수 있나?** 장애 시 영향 큼 → 분산/이중화 필요.
- **임무별 요구 충족**: real-time, ultra-reliable, ultra-secure 같은 특수 요구를 만족하는 프로토콜 설계.
- **인터넷 규모 확장(Internet-scaling)**: SDN을 **WAN 규모**로 적용 가능한가?

> 정리: SDN의 장점(중앙집중·프로그래머블)이 그대로 약점이 된다 — **controller의 보안·단일 장애점·확장성**이 핵심 과제.

---

### 한 줄 요약
SDN은 라우터에 묶여 있던 **control plane을 중앙 controller로 분리·집중**해 네트워크를 **소프트웨어로 프로그래밍**하는 패러다임이다(메인프레임→PC 유추). 핵심 매개는 **OpenFlow의 match+action flow table**이며, 이것으로 router·switch·firewall·NAT 등을 통합 구현한다. 대신 **controller의 보안·견고성·확장성**이 주요 과제다.
