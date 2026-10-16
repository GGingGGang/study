# 13 — Bash 스크립트: 반복 작업에 실패 처리를 더하기

> 학습 목표: 인수·조건·반복·함수를 사용하고 인용·종료 상태·임시 파일 정리를 설계한다.

## 1. 첫 스크립트와 실행 방식

파일 첫 줄의 shebang은 직접 실행할 인터프리터를 지정한다. Bash 기능을 쓰는 스크립트를 `sh script.sh`로 실행하면 다른 셸에서 실패할 수 있다. Ubuntu의 `/bin/sh`는 보통 Bash가 아닌 dash다.

```bash
mkdir -p "$HOME/linux-lab/scripts"
cd "$HOME/linux-lab/scripts"
cat > hello.sh <<'EOF'
#!/bin/bash
name=${1:-learner}
printf 'hello, %s\n' "$name"
EOF
bash -n hello.sh
bash hello.sh 'Linux learner'
chmod u+x hello.sh
./hello.sh
```

`bash -n`은 실행하지 않고 구문을 검사한다. 논리 오류까지 검증하지는 않는다. here-document의 `<<'EOF'`는 본문을 작성하는 현재 셸이 `$name`을 미리 확장하지 않도록 한다.

## 2. 변수와 인수

할당은 `name=value`이며 등호 앞뒤에 공백을 넣지 않는다. 읽을 때는 대개 `"$name"`으로 인용한다. `"$@"`는 각 인수를 각각 보존하며 `"$*"`는 하나의 문자열로 합치므로 용도가 다르다.

| 표현 | 뜻 |
|---|---|
| `$0`, `$1`, `$2` | 실행 이름, 첫째·둘째 인수 |
| `$#` | 인수 개수 |
| `"$@"` | 인수 경계를 보존한 전체 목록 |
| `${x:-default}` | unset 또는 빈 문자열일 때 기본값 |
| `${x:?설명}` | unset 또는 빈 문자열이면 오류 |
| `$(command)` | 명령 stdout, 끝의 줄바꿈은 제거됨 |

입력 데이터를 `eval`에 넘겨 명령으로 재해석하지 않는다. 명령과 인수를 동적으로 구성할 때는 Bash 배열을 쓴다.

```bash
files=('one file.txt' 'two.txt')
printf '<%s>\n' "${files[@]}"
```

## 3. 조건·반복·함수

```bash
describe_file() {
  local path=$1
  if [[ -f "$path" ]]; then
    printf 'file: %s\n' "$path"
  elif [[ -d "$path" ]]; then
    printf 'directory: %s\n' "$path"
  else
    printf 'not found: %s\n' "$path" >&2
    return 1
  fi
}
for path in /etc/hosts /etc /definitely-not-here; do
  describe_file "$path" || printf 'inspection failed\n' >&2
done
```

`[[ ... ]]`은 Bash 조건 구문이다. `-f`, `-d`는 일반 파일·디렉터리 검사이고 숫자 비교에는 `-gt`, `-eq` 또는 산술 구문을 쓴다. 함수의 `return`은 함수 종료 상태, `exit`는 셸 종료다. 텍스트 줄을 그대로 읽을 때는 `while IFS= read -r line`으로 공백과 백슬래시 처리를 명시한다.

## 4. set -e를 마법처럼 쓰지 않기

`set -u`는 정의되지 않은 변수 사용을 오류로, `set -o pipefail`은 파이프의 실패를 상태에 반영한다. `set -e`는 일부 실패에서 종료하지만 if 조건·AND/OR 목록·함수 호출 맥락 등 예외가 있다. `set -euo pipefail`만 붙인다고 오류 처리가 완성되지 않는다.

기대 가능한 실패는 `if command; then ... else ... fi`로 구분한다. 예를 들어 grep의 “일치 없음”은 업무상 정상일 수도 있다. 모든 출력은 실패 메시지와 결과 데이터를 분리해서 stdout/stderr에 보낸다.

## 5. 배포용 예제: 디렉터리 점검 보고서

저장소를 내려받았다면 [report.sh](./labs/report.sh ':ignore')를 `bash notes/linux/labs/report.sh "$HOME/linux-lab"`로 실행한다. 소스는 다음과 같다.

```bash
#!/bin/bash
set -u
set -o pipefail

if (( $# != 1 )); then
  printf 'usage: %s DIRECTORY\n' "$0" >&2
  exit 2
fi
if [[ ! -d "$1" ]]; then
  printf 'not a directory: %s\n' "$1" >&2
  exit 1
fi
target=$(realpath -e -- "$1") || exit 1
printf 'time=%s\npath=%s\n' "$(date --iso-8601=seconds)" "$target"
df -h -- "$target" || exit 1
du -sh -- "$target" || exit 1
if ! find "$target" -type f -printf '.\n' | wc -l; then
  printf 'file count failed\n' >&2
  exit 1
fi
```

`realpath`로 기존 디렉터리의 실제 경로를 확인하고 `--`로 옵션 해석을 끊는다. GNU find의 `-printf`는 파일 이름 대신 파일마다 일정한 한 줄을 출력하므로 이름에 줄바꿈이 있어도 개수를 셀 수 있다. pipefail이 없다면 find가 실패해도 wc 성공만 보고 전체를 성공 처리할 수 있다. 보고 중 파일이 바뀌면 각 숫자는 동일 순간의 스냅샷이 아니므로 운영 집계에 사용할 때는 이 한계를 고려한다.

## 연습문제와 해설

1. `for x in $(ls)`가 위험한 이유는? → 공백·줄바꿈으로 이름이 분리되고 glob이 다시 확장될 수 있다. 파일 순회는 glob 배열이나 find 전달 방식을 쓴다.
2. 잘못된 경로를 report.sh에 전달하면? → stderr에 설명을 남기고 0이 아닌 상태로 종료해야 한다.
3. 스크립트 디버깅에 `bash -x`를 쓰면 주의할 점은? → 확장된 변수와 인수가 로그에 노출될 수 있으므로 비밀 값이 있는 부분에는 사용하지 않는다.

참고: [Bash 매뉴얼](https://www.gnu.org/software/bash/manual/bash.html), [ShellCheck](https://www.shellcheck.net/)

[목차](./00-학습안내.md) · 다음: [14 — 스케줄링과 백업](./14-스케줄링과-백업.md)
