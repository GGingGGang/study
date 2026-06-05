# 시작하기

이 페이지는 예시 노트다. 지우고 내 노트로 채우면 된다.

## 노트 추가하는 법

1. `.md` 파일을 만든다. 예: `notes/kafka.md`
2. `_sidebar.md` 에 링크를 추가한다.

   ```markdown
   - [Kafka 정리](notes/kafka.md)
   ```

3. commit + push.
4. `study.ggang.cloud` 에 수초 내 반영된다 (git-sync 폴링 주기 = 30s).

## 코드 블럭도 된다

```bash
kubectl get pods -n app
```
