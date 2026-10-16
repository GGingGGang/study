# 06 — 사용자와 SSH: 누가 어떤 권한으로 접속하는가

> 학습 목표: UID·그룹·sudo를 이해하고 SSH 키 인증과 원격 접속 오류를 구분한다.

## 1. 사용자 이름보다 UID가 기준이다

커널은 사용자 이름 대신 숫자 UID와 GID를 사용한다. UID 0은 root다. 일반 계정과 서비스 계정은 용도·로그인 셸·권한 설계가 다르지만 둘 다 UID를 가진다. 서비스별 계정을 쓰면 한 서비스의 침해가 다른 서비스 파일 접근으로 이어질 범위를 줄일 수 있다.

```bash
id
getent passwd "$(id -un)"
getent group "$(id -gn)"
groups
```

`getent`는 시스템의 이름 조회 설정에 따라 로컬 파일뿐 아니라 디렉터리 서비스도 조회할 수 있다. `/etc/passwd`의 필드는 이름, 암호 자리표시자, UID, GID, 설명, 홈, 셸 순이다. 암호 해시는 보통 읽기를 제한한 `/etc/shadow`에 있다. `/etc/passwd`를 읽을 수 있다고 암호가 공개되는 것은 아니다.

**기본 그룹**과 **보조 그룹**이 있다. 그룹 목록을 바꿔도 이미 실행 중인 프로세스의 그룹이 자동 갱신되지는 않으므로 재로그인 후 `id`로 확인한다.

## 2. sudo는 지정한 명령에 권한을 부여한다

```bash
sudo -l
```

허용 목록을 확인하는 명령이다. sudo가 허용되어야 하며 암호를 요청할 수 있다. `sudo`가 붙은 자식 명령은 권한이 달라져도 현재 셸 전체가 root가 되는 것은 아니다. `sudo cd`가 작업 위치 변경에 쓰이지 않는 이유도 셸 구조와 연결된다.

sudoers는 문법 오류로 관리 접속을 막을 수 있으므로 직접 덮어쓰기보다 `visudo`를 사용한다. 광범위한 `NOPASSWD: ALL`은 자동화의 기본값으로 삼지 않는다. 허용할 실행 파일과 인수, 그 파일을 누가 수정할 수 있는지까지 함께 확인한다.

### VM 관리자 실습: 임시 계정

`linuxstudent`라는 계정이 없는 **개인 실습 VM**에서만 수행한다.

```bash
getent passwd linuxstudent
sudo useradd -m -s /bin/bash linuxstudent
sudo -u linuxstudent id
sudo -u linuxstudent sh -c 'printf "%s\n" "$HOME"'
```

첫 조회에서 계정이 이미 보이면 생성 단계를 진행하지 않는다. Ubuntu의 `adduser`는 대화형 고수준 도구이고 `useradd`는 옵션을 명시하는 저수준 도구다. 여기서는 암호를 설정하지 않았으므로 암호 로그인을 실습한 것이 아니다.

계정에 실행 중인 프로세스가 없고 학습용 홈만 있다는 것을 확인한 뒤 되돌린다.

```bash
sudo userdel -r linuxstudent
```

## 3. SSH 키 인증의 구성

SSH는 서버의 신원 확인과 암호화된 통신 위에서 사용자 인증을 수행한다. 키 쌍의 **공개 키**는 서버에 등록하고 **개인 키**는 클라이언트에 둔다. 개인 키는 서버에 업로드하지 않는다. 암호문(passphrase)은 개인 키 파일 사용을 보호하며 서버 계정 암호와 다르다.

아래는 개념 예시다. `계정`, `서버주소`, 공개 키 등록 위치는 실제 실습 VM 값으로 바꾼다. 기존 파일이 있으면 새 이름을 선택한다.

```bash
ssh-keygen -t ed25519 -f "$HOME/.ssh/linux_lab_ed25519"
ssh-copy-id -i "$HOME/.ssh/linux_lab_ed25519.pub" 계정@서버주소
ssh -i "$HOME/.ssh/linux_lab_ed25519" 계정@서버주소
```

`ssh-copy-id`에는 초기 로그인 방법이 필요하다. 콘솔이나 기존 접속 방식으로 공개 키를 등록할 수도 있다. 서버의 `~/.ssh`는 보통 700, `authorized_keys`는 600으로 두고 소유자도 로그인 사용자와 맞춘다. sshd는 설정과 경로의 소유권·권한에 따라 인증을 거부할 수 있다.

최초 접속 때 표시되는 **서버 호스트 키 지문**은 VM 콘솔 등 별도 경로로 확인한다. 호스트 키가 바뀌었다면 재설치인지 잘못된 서버인지 먼저 확인한다. 검증을 끄거나 `known_hosts` 항목을 무조건 삭제하지 않는다.

## 4. 증상으로 접속 단계를 나누기

| 증상 | 우선 확인 |
|---|---|
| 이름을 찾을 수 없음 | 서버 이름·DNS |
| Connection timed out | 경로·방화벽·서버 상태 |
| Connection refused | 포트·리스닝·방화벽 reject |
| Host key verification failed | 서버 신원과 known_hosts |
| Permission denied (publickey) | 계정 이름·선택된 키·서버 authorized_keys·권한 |

`ssh -v`로 인증 흐름을 볼 수 있다. 출력에는 호스트·계정·키 경로가 포함될 수 있다. 서버에서는 `journalctl -u ssh` 또는 배포판에 따라 `sshd` unit을 확인한다. Ubuntu 기본 서비스 이름은 보통 `ssh`, RHEL 계열은 `sshd`다. socket 활성화 여부도 실제 unit에서 확인한다.

설정 변경은 `sudo sshd -t`로 문법을 검증한 다음 적용한다. 원격 인증을 바꿀 때는 기존 세션을 열어 두고 **새 세션 로그인 성공**을 확인한 뒤 닫는다. 암호 인증을 끄는 작업은 키 인증과 콘솔 복구 경로를 먼저 확보해야 한다.

## 연습문제와 해설

1. 그룹에 추가했는데 기존 터미널에서 접근이 안 되는 이유는? → 기존 프로세스의 보조 그룹이 그대로일 수 있다. 재로그인 후 `id`로 확인한다.
2. 공개 키 파일을 서버에 올리면 누구나 내 계정에 접속하는가? → 해당 공개 키와 짝인 개인 키로 인증할 수 있어야 한다. 개인 키를 보호해야 한다.
3. SSH 암호 인증을 끄면 root 권한도 없어지는가? → 인증 방식과 권한은 별개다. sudo 정책과 root 접속 정책을 각각 관리한다.

참고: [OpenSSH 매뉴얼](https://www.openssh.com/manual.html), [Ubuntu OpenSSH](https://documentation.ubuntu.com/server/how-to/security/openssh-server/)

[목차](./00-학습안내.md) · 다음: [07 — 프로세스와 시그널](./07-프로세스와-시그널.md)
