# study

개인 학습 노트. 이 레포에 `.md` 만 push 하면 `study.ggang.cloud` 에 자동 반영된다.

- 좌측 사이드바에서 문서를 고른다 (`_sidebar.md` 로 목차 관리).
- 새 노트는 `.md` 파일을 추가하고 `_sidebar.md` 에 링크만 걸면 끝. 빌드 없음.
- push → cluster 의 git-sync 가 폴링해서 수초 내 갱신.

## OCI Kubernetes 면접 준비

`oci-always-free-k8s`의 실제 인프라·플랫폼 설정을 기준으로 정리한 자료다.

- [기술 스택과 분석 범위](notes/oci-interview/00-overview.md)
- [인프라·플랫폼·CI/CD 파이프라인](notes/oci-interview/01-pipelines.md)
- [필수 사전 지식](notes/oci-interview/02-prerequisites.md)
- [데이터 흐름 그래프](notes/oci-interview/03-data-flows.md)
- [면접 질문과 설명 연습](notes/oci-interview/04-interview.md)

Mermaid 그래프는 GitHub와 study 사이트에서 볼 수 있다. 사이트는 `assets/mermaid.js`로 Mermaid 코드 블록을 렌더링한다.
