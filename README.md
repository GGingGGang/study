# study

개인 학습 노트. 이 레포에 `.md` 만 push 하면 `study.ggang.cloud` 에 자동 반영된다.

- 좌측 사이드바에서 문서를 고른다 (`_sidebar.md` 로 목차 관리).
- 새 노트는 `.md` 파일을 추가하고 `_sidebar.md` 에 링크만 걸면 끝. 빌드 없음.
- push → cluster 의 git-sync 가 폴링해서 수초 내 갱신.

## 시험 요약

[네 과목 학습 안내](notes/exam/README.md)에서 국제협상론, 컴퓨터비전, 클라우드보안, 과학기술과 인간의 대화의 핵심·상세 요약을 볼 수 있다. 사이드바의 **시험 요약**에 과목별 목차가 있다.

## 사이드바 폴더

폴더 제목을 누르면 하위 목차를 접고 펼칠 수 있다. 처음에는 접힌 상태이며 현재 문서가 속한 폴더는 자동으로 열린다. 열어 둔 폴더는 이 브라우저에 저장된다.

목차는 `_sidebar.md`의 들여쓰기로 관리한다. 링크가 없는 항목 아래에 목록을 두면 접을 수 있는 폴더가 된다. 새 문서는 해당 폴더 아래에 링크를 추가한다.

```markdown
* 상위 폴더
  * 하위 폴더
    * [문서 제목](notes/folder/document.md)
```

동작은 `assets/sidebar.js`, 모양은 `assets/sidebar.css`에서 관리한다. Markdown 문서의 실제 경로는 바꿀 필요가 없다.

## OCI Kubernetes 면접 준비

`oci-always-free-k8s`의 실제 인프라·플랫폼 설정을 기준으로 정리한 자료다.

- [기술 스택과 분석 범위](notes/oci-interview/00-overview.md)
- [인프라·플랫폼·CI/CD 파이프라인](notes/oci-interview/01-pipelines.md)
- [필수 사전 지식](notes/oci-interview/02-prerequisites.md)
- [데이터 흐름 그래프](notes/oci-interview/03-data-flows.md)
- [면접 질문과 설명 연습](notes/oci-interview/04-interview.md)

Mermaid 그래프는 GitHub와 study 사이트에서 볼 수 있다. 사이트는 `assets/mermaid.js`로 Mermaid 코드 블록을 렌더링한다.
