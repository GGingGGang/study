# Jenkins (Jenkins)

> 쿠버네티스 · CI·CD/Jenkins · 학습내용: Jenkins가 무엇/왜(CI 자동화 서버), 선언형 파이프라인·Jenkinsfile, 에이전트/노드(K8s 에이전트), 자격증명(credentials), 플러그인·트리거(webhook/SCM polling), 단계(빌드·테스트·이미지 빌드), 이미지 빌드 후 GHCR push 흐름, 최소 Jenkinsfile 예시

---

## 1. Jenkins가 뭐고 왜 쓰나

**Jenkins**는 **오픈소스 CI(지속적 통합) 자동화 서버**다. 코드를 푸시하면 **빌드 → 테스트 → 패키징(이미지 빌드)** 같은 작업을 **자동으로** 실행해, 사람이 매번 손으로 돌리던 일을 파이프라인으로 표준화한다.

- **CI의 핵심**: 변경을 자주 통합하고, **매 변경마다 자동 빌드·테스트**로 깨짐을 빨리 잡는다.
- **확장성**: 방대한 **플러그인 생태계**로 Git, 컨테이너 레지스트리, 알림 등 거의 모든 도구와 연동.
- **GitOps와의 관계**: Jenkins는 보통 **CI(이미지 빌드·push)까지** 책임지고, 클러스터 배포는 GitOps CD에 맡긴다(책임 분리). Jenkins가 새 이미지를 GHCR에 올리고 배포 설정(config repo)의 태그를 갱신하면, CD가 그걸 받아서 배포한다.

## 2. 파이프라인(Declarative)과 Jenkinsfile

Jenkins의 작업 흐름은 **파이프라인(Pipeline)** 으로 정의하고, 그 정의를 코드로 적은 파일이 **`Jenkinsfile`** 이다(소스 repo에 함께 보관 = **Pipeline as Code**).

- **Declarative Pipeline**: 정해진 구조(`pipeline { agent / stages / steps }`)로 작성하는 **권장 방식**. 읽기 쉽고 검증이 쉽다.
- **Scripted Pipeline**: Groovy로 자유롭게 짜는 방식(더 유연하나 복잡).

기본 골격:

```groovy
pipeline {
  agent any
  stages {
    stage('Build') { steps { /* ... */ } }
    stage('Test')  { steps { /* ... */ } }
  }
}
```

## 3. 에이전트 / 노드

- **컨트롤러(controller)**: 파이프라인을 조율·스케줄링하는 본체.
- **에이전트(agent)/노드(node)**: 실제 작업이 **실행되는 워커**. `agent` 지시어로 어디서 돌릴지 지정.
- **쿠버네티스 에이전트**: K8s 플러그인을 쓰면 빌드마다 **동적 파드(pod)** 를 띄워 실행하고 끝나면 정리한다. 빌드마다 깨끗한 환경 + 자원 효율(필요할 때만 파드 생성).

```groovy
agent {
  kubernetes {
    yaml '''
    apiVersion: v1
    kind: Pod
    spec:
      containers:
        - name: build
          image: <build-tools-image>
          command: ["sleep"]
          args: ["infinity"]
    '''
  }
}
```

## 4. 자격증명(Credentials)

비밀번호·토큰·SSH 키 등은 Jenkinsfile에 평문으로 적지 말고 **Credentials 저장소**에 등록해 **ID로 참조**한다.

```groovy
environment {
  // 'ghcr-token' = Jenkins에 등록한 credential ID
  GHCR_TOKEN = credentials('ghcr-token')
}
```

- 로그에 자동 마스킹되고, 코드에 비밀이 노출되지 않는다.
- ★ 면접 포인트: "CI에서 토큰을 어떻게 다루나?" → **"코드에 평문 금지. Jenkins Credentials에 등록해 ID로 참조하고 로그 마스킹을 활용한다."**

## 5. 플러그인 · 트리거

- **플러그인**: Git, 컨테이너 빌드, 알림, K8s 연동 등 기능 확장의 핵심.
- **트리거(언제 파이프라인을 도나)**:

| 트리거 | 방식 | 특징 |
|--------|------|------|
| **Webhook** | SCM(예: GitHub)이 push 시 Jenkins에 **즉시 알림** | 빠르고 효율적 — **권장** |
| **SCM polling** | Jenkins가 주기적으로 repo를 **확인** | 변경 감지에 지연·부하 — webhook이 어려울 때 |

## 6. 파이프라인 단계 (빌드 → 테스트 → 이미지 빌드 → GHCR push)

CI 흐름은 보통 다음 단계로 구성된다.

1. **Checkout**: 소스 가져오기.
2. **Build**: 컴파일/패키징.
3. **Test**: 단위·통합 테스트(실패 시 파이프라인 중단).
4. **Image Build**: 컨테이너 **이미지 빌드**(불변 태그 권장 — 빌드 번호·커밋 SHA 등).
5. **Push to GHCR**: 이미지를 **GHCR(GitHub Container Registry)** 에 업로드.
6. (이후) 배포 설정(config repo)의 이미지 태그 갱신 → GitOps CD가 배포.

### 이미지 빌드 · GHCR push 흐름

```
GHCR 로그인 (Credentials의 토큰 사용)
  → 이미지 빌드: ghcr.io/<org>/my-service:<불변태그>
    → GHCR로 push
      → (배포는 GitOps CD가 config repo 변경을 받아 수행)
```

핵심: Jenkins는 **이미지를 만들어 GHCR에 올리는 데까지** 집중한다. **클러스터에 직접 배포하지 않으니 클러스터 자격증명이 필요 없다** → 보안상 깔끔하고 GitOps와 책임이 분리된다.

★ 면접 포인트: "Jenkins로 어디까지 하고 배포는 누가?" → **"Jenkins(CI)는 빌드·테스트·이미지 GHCR push까지. 클러스터 배포는 GitOps CD가 담당. 둘의 접점은 Git config repo."**

## 7. 최소 Jenkinsfile 예시

```groovy
pipeline {
  agent any

  environment {
    IMAGE = "ghcr.io/<org>/my-service"
    TAG   = "${env.GIT_COMMIT}"            // 커밋 SHA = 불변 태그
    GHCR  = credentials('ghcr-token')      // username/password 형태 credential
  }

  stages {
    stage('Checkout') {
      steps { checkout scm }
    }
    stage('Build & Test') {
      steps {
        sh 'make build'
        sh 'make test'
      }
    }
    stage('Image Build & Push') {
      steps {
        sh 'echo "$GHCR_PSW" | docker login ghcr.io -u "$GHCR_USR" --password-stdin'
        sh 'docker build -t $IMAGE:$TAG .'
        sh 'docker push $IMAGE:$TAG'
      }
    }
  }

  post {
    success { echo "pushed ${IMAGE}:${TAG}" }
    failure { echo 'pipeline failed' }
  }
}
```

> 참고: `credentials('ghcr-token')`을 environment에 쓰면 `GHCR_USR`/`GHCR_PSW` 변수가 자동 생성된다(username/password 타입). 배포(클러스터 적용)는 이 파이프라인에 넣지 않고 GitOps CD에 맡긴다.

## 8. 흔한 함정

- **비밀 평문 노출**: Jenkinsfile/로그에 토큰을 직접 쓰지 말 것 → Credentials 사용.
- **가변 태그(latest)**: 이미지 태그를 `latest`로 하면 무엇이 떴는지 추적 불가 → **커밋 SHA·빌드 번호 등 불변 태그**.
- **테스트 미차단**: 테스트 실패를 무시하면 CI 의미 상실 → 실패 시 파이프라인 중단.
- **컨트롤러에서 빌드 실행**: 무거운 빌드를 컨트롤러에서 돌리면 불안정 → **에이전트(노드)에서 실행**, K8s 에이전트로 격리.

---

### 한 줄 요약

Jenkins는 **오픈소스 CI 자동화 서버**로, **Jenkinsfile(선언형 파이프라인)** 에 빌드·테스트·이미지 빌드를 코드로 정의하고 **에이전트(K8s 동적 파드)** 에서 실행한다. 비밀은 **Credentials로 참조**, 트리거는 **webhook 권장**. CI는 **이미지를 불변 태그로 빌드해 GHCR에 push하는 데까지** 책임지고, 클러스터 배포는 GitOps CD에 넘겨 책임을 분리한다.

---

### 참고 (공식 문서)

- Jenkins 공식 문서: <https://www.jenkins.io/doc/>
- Pipeline 개요: <https://www.jenkins.io/doc/book/pipeline/>
- Jenkinsfile 작성법: <https://www.jenkins.io/doc/book/pipeline/jenkinsfile/>
- Credentials 사용: <https://www.jenkins.io/doc/book/using/using-credentials/>
- Kubernetes 플러그인: <https://plugins.jenkins.io/kubernetes/>
