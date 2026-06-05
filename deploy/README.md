# study 배포 (git-sync + nginx)

`.md` 만 담긴 이 레포를 `study.ggang.cloud` 로 노출한다. 이미지 빌드 없음 — nginx 가 git-sync 사이드카가 폴링한 워킹트리를 서빙하고, docsify(`index.html`)가 브라우저에서 md 를 렌더한다. 배포 매니페스트는 ArgoCD 가 sync 한다.

참조:
- https://github.com/kubernetes/git-sync (`registry.k8s.io/git-sync/git-sync`)
- https://hub.docker.com/r/nginxinc/nginx-unprivileged
- https://docsify.js.org/
- https://argo-cd.readthedocs.io/en/stable/

## 1. 전제 조건

- `app` 네임스페이스 존재 (PSA `restricted`) — `oci-terraform/kubernetes/infra/namespaces/namespaces.yaml`
- `public-gateway` (istio-system, `*.ggang.cloud` listener) + wildcard TLS Ready
- external-dns 동작 — HTTPRoute hostname → Cloudflare DNS 자동 sync
- ArgoCD 설치됨 (`cicd` NS)
- 레포 `github.com/ggingggang/study` 가 **public** (private 면 5장 참고)

## 2. 설치

ArgoCD Application 1회 등록 (이후는 git push 만으로 운영):

```bash
kubectl apply -f argocd/application.yaml
```

ArgoCD 가 `deploy/` 의 kustomization 을 `app` NS 에 sync 한다. 수동 적용으로 먼저 확인하려면:

```bash
kubectl apply -k deploy/
```

## 3. 검증

```bash
kubectl get pods -n app -l app.kubernetes.io/name=study
kubectl logs -n app deploy/study -c git-sync --tail=20

kubectl -n app get httproute study \
  -o jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}' ; echo
# 기대: True

dig +short study.ggang.cloud
curl -sI https://study.ggang.cloud | head -1
```

브라우저: `https://study.ggang.cloud` → docsify 사이트 + 좌측 사이드바.

콘텐츠 자동 갱신 확인:

```bash
# 루트 레포에서 .md 수정 후 push → 30s 내 반영
kubectl exec -n app deploy/study -c nginx -- ls -l /git/current
```

## 4. 결정

### git-sync 사이드카 (이미지 빌드 X)

md 만 바뀌는 콘텐츠 레포라 이미지 빌드/레지스트리가 과함. git-sync 가 `--period=30s` 로 폴링해 워킹트리를 `emptyDir` 에 두고, nginx 가 `/git/current` 심볼릭 링크를 서빙. push → 재빌드/재배포 없이 콘텐츠만 갱신.

- **두 갱신 경로 분리**: 콘텐츠(`.md`) = git-sync 폴링, 배포 매니페스트(`deploy/`) = ArgoCD sync. 매니페스트가 안 바뀌면 Pod 는 그대로, 파일만 교체.
- `--depth=1` 얕은 클론 — history 불필요.

### docsify (빌드리스 렌더)

`mkdocs build` 같은 정적 빌드 대신 `index.html` 한 장이 CDN 에서 docsify 를 받아 브라우저에서 md 렌더. 빌드 파이프라인 0 → git-sync 흐름과 정합. 목차는 `_sidebar.md`.

### nginx-unprivileged + non-root

`app` NS 는 PSA `restricted`. 기본 nginx 는 root + :80 이라 거부됨. `nginx-unprivileged`(uid 101, :8080) + git-sync(uid 65533) 둘 다 non-root.

- `fsGroup: 65533` — `emptyDir` 를 git-sync 그룹 소유로. nginx 는 supplemental group 으로 group-readable 파일 읽음.
- `runAsNonRoot`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities: drop ALL` — restricted 요건 충족.
- git-sync `readOnlyRootFilesystem: true` — 쓰기는 `/git` 볼륨 + `/tmp`(emptyDir) 뿐. git-sync 는 HOME(`/tmp`)에 gitconfig 를 쓰므로 `/tmp` emptyDir 필수.

### HTTPRoute — https-wildcard attach

`study.ggang.cloud` 를 `public-gateway` 의 `https-wildcard` listener 에 attach (cert SAN `*.ggang.cloud`). external-dns 가 hostname 으로 Cloudflare A 레코드 자동 생성. HTTP→HTTPS redirect 는 Gateway catch-all 처리.

## 5. 주의 사항

### 이미지는 완전수식 (CRI-O)

노드 런타임이 CRI-O 라 short name(`nginxinc/nginx-unprivileged:...`)을 거부한다(`short name mode is enforcing ... ambiguous`). 레지스트리를 명시(`docker.io/...`, `registry.k8s.io/...`)해야 한다. 모든 이미지에 적용.

### git-sync 버전 핀

`v4.4.0` 핀. 설치 전 최신 stable 확인 권장:

```bash
# https://github.com/kubernetes/git-sync/releases
```

git-sync v3 → v4 는 플래그가 바뀜(`--branch` → `--ref`, `GIT_SYNC_*` → `GITSYNC_*`). v4 기준 작성됨.

### private 레포일 때

레포가 private 이면 git-sync 가 401. 토큰 Secret 추가 후 env 주입:

```bash
kubectl create secret generic study-git \
  --from-literal=username=ggingggang \
  --from-literal=password=<github-pat-read-only> \
  -n app
```

`deployment.yaml` git-sync 컨테이너에:

```yaml
env:
  - name: GITSYNC_USERNAME
    valueFrom:
      secretKeyRef: { name: study-git, key: username }
  - name: GITSYNC_PASSWORD
    valueFrom:
      secretKeyRef: { name: study-git, key: password }
```

PAT 는 `repo:read` (contents read-only) 최소 권한. 추후 Vault Agent Injector 로 이관 권장.

### 초기 404

git-sync 첫 클론 전엔 `/git/current` 가 없어 nginx 가 404 → readinessProbe 미통과. 첫 sync(수초) 후 Ready. 정상.

### 콘텐츠 즉시 반영이 필요하면

폴링 주기를 줄이거나(`--period`), GitHub webhook → git-sync `--webhook-url` 푸시 트리거로 전환. 현재는 30s 폴링으로 충분.

### docsify 사이드바

`loadSidebar: true` 라 `_sidebar.md` 가 목차 소스. 새 노트는 파일 추가 + `_sidebar.md` 링크. 누락 시 해당 문서는 직접 URL 로만 접근됨.

## 6. IP 제한 (선택)

`study.ggang.cloud` 만 특정 IP 로 제한. Istio `AuthorizationPolicy` 로 host 스코프 DENY. 매니페스트는 `../security/` 참조 (실제 CIDR 은 `*.local.yaml` 에 두고 git 추적 안 함).

**전제 — 클라이언트 IP 보존**: 게이트웨이 svc 가 `externalTrafficPolicy: Cluster` 면 노드에서 SNAT 되어 Envoy 가 실 클라이언트 IP 를 못 본다(노드 IP 로 보임). OCI L4 LB 라 XFF 도 안 붙음. `Local` 로 전환 필수.

```bash
kubectl patch svc public-gateway-istio -n istio-system \
  -p '{"spec":{"externalTrafficPolicy":"Local"}}'
# Istio 가 되돌리면 PROXY protocol 또는 사전 생성 Service 로 대체
```

`Local` 은 **공유 게이트웨이 전체**(다른 host 포함)에 영향 + LB 헬스체크/노드 분산 거동 변경.

```bash
cp ../security/authorizationpolicy.example.yaml ../security/authorizationpolicy.local.yaml
# notRemoteIpBlocks 를 허용 CIDR 로 수정 후
kubectl apply -f ../security/authorizationpolicy.local.yaml
```

DENY + `notRemoteIpBlocks` = 허용 CIDR 외 전부 403. host 스코프라 다른 라우트 무영향. 매칭 안 되면 `remoteIpBlocks` 대신 `ipBlocks`(패킷 source) 로 시도.
