# 09 — 부팅과 systemd: 프로세스를 서비스로 운영하기

> 학습 목표: 부팅 흐름과 unit을 이해하고 서비스의 실행·자동 시작·로그를 관리한다.

## 1. 부팅은 어떤 순서로 진행되는가

일반적인 흐름은 펌웨어(UEFI 등) → 부트로더 → 커널과 initramfs → 실제 루트 파일시스템 → PID 1 → 서비스다. initramfs는 실제 루트를 사용하기 위해 필요한 드라이버·암호화 해제 등을 준비할 수 있다. 모든 시스템이 같은 부트로더와 initramfs 구성을 사용하는 것은 아니다.

systemd는 많은 배포판에서 PID 1로 실행되며 서비스를 비롯한 자원을 **unit**으로 관리한다. `.service`는 프로세스, `.socket`은 소켓 활성화, `.timer`는 시간 기반 실행, `.mount`는 마운트, `.target`은 여러 unit의 묶음과 동기화 지점이다.

```bash
ps -p 1 -o comm=
systemctl get-default
systemctl --failed
systemctl list-units --type=service --state=running
```

## 2. start와 enable은 다른 질문이다

| 명령 | 질문 |
|---|---|
| `start` / `stop` | 지금 실행하거나 멈출 것인가? |
| `restart` | 중지 후 다시 시작할 것인가? |
| `reload` | 프로그램이 지원하는 설정 재읽기를 요청할 것인가? |
| `enable` / `disable` | 관련 target 등에서 자동으로 연결해 시작할 것인가? |
| `daemon-reload` | systemd가 unit 파일 변경을 다시 읽게 할 것인가? |

enable만으로 지금 실행되지는 않는다. `enable --now`는 둘을 함께 요청한다. disable해도 이미 실행 중인 서비스는 멈추지 않는다. 또한 disable은 수동 실행이나 다른 의존 관계에 의한 실행을 완전히 금지하지 않는다. unit에 따라 enable할 설치 정보가 없는 static 상태도 있다.

`After=`는 순서를 나타낸다. 다른 unit을 반드시 시작시킨다는 뜻이 아니다. `Wants=`와 `Requires=`는 의존 관계이며 실패 처리 방식이 다르다. 네트워크가 준비되었다고 표시되어도 외부 API가 응답한다는 보장은 없다.

## 3. VM 관리자 실습: 최소 서비스 만들기

PID 1이 systemd인 개인 VM에서 수행한다. 기존 `linux-lab-clock.service`가 없음을 먼저 확인한다. 이 서비스는 5초마다 journal에 시간을 남긴다.

```bash
systemctl cat linux-lab-clock.service
sudo tee /etc/systemd/system/linux-lab-clock.service >/dev/null <<'EOF'
[Unit]
Description=Linux textbook clock lab

[Service]
Type=simple
ExecStart=/bin/bash -c 'while true; do /usr/bin/date --iso-8601=seconds; /usr/bin/sleep 5; done'
DynamicUser=yes
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF
sudo systemd-analyze verify /etc/systemd/system/linux-lab-clock.service
sudo systemctl daemon-reload
sudo systemctl start linux-lab-clock.service
systemctl status linux-lab-clock.service --no-pager
sudo journalctl -u linux-lab-clock.service -n 10 --no-pager
```

`DynamicUser=yes`는 실행 중 동적 사용자로 권한을 낮춘다. 표준 출력은 기본 설정에서 journal로 수집된다. `active (running)`과 시간이 기록되는지 확인한다. 이번에는 enable하지 않았으므로 부팅 자동 시작 등록은 하지 않았다. 반복 실행 간격의 `sleep`은 프로그램 동작의 일부다.

처음 `systemctl cat`이 “unit이 없다”고 실패하는 것은 생성 전 확인의 예상 결과다. 이미 unit이 있다면 덮어쓰지 말고 다른 이름을 선택한다.

정리할 때는 다음 순서로 이번 실습 unit만 제거한다.

```bash
sudo systemctl stop linux-lab-clock.service
sudo rm -- /etc/systemd/system/linux-lab-clock.service
sudo systemctl daemon-reload
```

## 4. 실패를 어디에서 확인하는가

```bash
systemctl status linux-lab-clock.service --no-pager
sudo journalctl -u linux-lab-clock.service -b --no-pager
```

실습 unit이 있는 동안 사용한다. status는 요약이고 journal은 세부 증거다. 실행 파일 경로, 실행 사용자, 작업 디렉터리, 환경변수, 파일 접근 권한을 차례로 확인한다. 터미널의 alias와 `.bashrc`가 서비스에 자동 적용되지는 않는다. `ExecStart=`도 기본적으로 셸 문법이 아니므로 파이프·`>` 등을 쓰려면 명시적 셸 또는 별도 스크립트가 필요하다.

unit은 배포판 파일을 직접 편집하기보다 `systemctl edit 서비스명`의 drop-in으로 재정의할 수 있다. `systemctl cat 서비스명`으로 원본과 추가 설정을 함께 확인한다. `daemon-reload` 후에도 실행 중 프로세스의 설정을 반영하려면 해당 프로그램에 맞는 restart/reload가 필요하다.

## 연습문제와 해설

1. enable인데 inactive일 수 있는가? → 가능하다. 자동 시작 등록과 현재 실행 상태는 다른 축이다.
2. unit을 고친 뒤 daemon-reload만 했는데 프로그램이 그대로인 이유는? → systemd가 정의를 다시 읽었을 뿐 기존 프로세스를 재시작하지 않았기 때문이다.
3. 서비스가 재시작을 반복하면 Restart=always를 더하면 되는가? → 원인을 숨길 수 있다. 먼저 종료 코드·로그·재시작 제한을 확인한다.

참고: [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html), [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html)

[목차](./00-학습안내.md) · 다음: [10 — 디스크와 파일시스템](./10-디스크와-파일시스템.md)
