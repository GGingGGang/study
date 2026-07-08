# 10. ConfigMap과 Secret

> 도메인: 워크로드와 스케줄링 (15%)
> 시험 포인트: 생성(명령형) + Pod에 주입(env / envFrom / volume) 3가지 방법을 모두 손에 익힐 것. 매년 나오는 기본 문제.

---

## 1. ConfigMap

설정을 이미지에서 분리해 저장하는 key-value 객체 (평문).

### 생성
```bash
kubectl create configmap app-config \
  --from-literal=LOG_LEVEL=debug \
  --from-literal=DB_HOST=db.example.com

kubectl create configmap nginx-conf --from-file=nginx.conf          # 파일명이 key
kubectl create configmap nginx-conf --from-file=custom.conf=nginx.conf   # key 지정
kubectl create configmap all-conf --from-file=./config-dir/         # 디렉터리 통째
kubectl create configmap env-conf --from-env-file=app.env           # KEY=VALUE 파일
```

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: app-config
data:
  LOG_LEVEL: debug
  nginx.conf: |
    server {
      listen 80;
    }
```

## 2. Secret

민감 정보 저장. **base64 인코딩일 뿐 암호화가 아님** (etcd 암호화는 별도 설정).

### 생성
```bash
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password='S3cret!'

kubectl create secret generic tls-files --from-file=tls.crt --from-file=tls.key

# 특수 타입
kubectl create secret tls web-tls --cert=tls.crt --key=tls.key            # type: kubernetes.io/tls
kubectl create secret docker-registry regcred \
  --docker-server=registry.io --docker-username=u --docker-password=p    # 프라이빗 레지스트리
```

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
type: Opaque
data:                      # base64 인코딩 값
  password: UzNjcmV0IQ==
stringData:                # 평문으로 쓰면 자동 인코딩 (편함)
  username: admin
```

### 값 읽기 (디코딩)
```bash
kubectl get secret db-secret -o jsonpath='{.data.password}' | base64 -d
echo -n 'S3cret!' | base64          # 인코딩 (-n 필수: 개행 방지)
```

### 프라이빗 레지스트리 사용
```yaml
spec:
  imagePullSecrets:
  - name: regcred
```

## 3. Pod에 주입하는 3가지 방법

### 3-1. 개별 환경변수 (valueFrom)
```yaml
spec:
  containers:
  - name: app
    image: nginx
    env:
    - name: LOG_LEVEL
      valueFrom:
        configMapKeyRef:
          name: app-config
          key: LOG_LEVEL
    - name: DB_PASSWORD
      valueFrom:
        secretKeyRef:
          name: db-secret
          key: password
```

### 3-2. 통째로 환경변수 (envFrom)
```yaml
    envFrom:
    - configMapRef:
        name: app-config
    - secretRef:
        name: db-secret
      prefix: DB_          # 선택: key 앞에 접두사
```

### 3-3. 볼륨 마운트 (key가 파일이 됨)
```yaml
spec:
  containers:
  - name: app
    volumeMounts:
    - name: config-vol
      mountPath: /etc/config
      readOnly: true
  volumes:
  - name: config-vol
    configMap:
      name: app-config
      items:                    # 선택: 특정 key만
      - key: nginx.conf
        path: nginx.conf
  # Secret이면:
  # - name: secret-vol
  #   secret:
  #     secretName: db-secret
  #     defaultMode: 0400
```

### 업데이트 전파 차이 (개념 문제로 등장)
| 주입 방식 | ConfigMap/Secret 변경 시 |
|---|---|
| env / envFrom | **반영 안 됨** — Pod 재시작 필요 (`kubectl rollout restart`) |
| 볼륨 마운트 | kubelet이 주기적으로 **자동 갱신** (약간의 지연, subPath 마운트는 예외적으로 갱신 안 됨) |

## 4. immutable

```yaml
# ConfigMap/Secret 공통
immutable: true
```
- 실수 방지 + 대규모 클러스터에서 kube-apiserver 부하 감소 (watch 불필요)
- 수정하려면 삭제 후 재생성

## 5. 검증

```bash
kubectl exec mypod -- env | grep LOG_LEVEL
kubectl exec mypod -- cat /etc/config/nginx.conf
kubectl describe pod mypod          # CreateContainerConfigError = 참조한 CM/Secret 없음
```

> **트러블슈팅 연결**: Pod가 `CreateContainerConfigError`면 십중팔구 존재하지 않는 ConfigMap/Secret/key 참조다. `kubectl describe pod`의 Events에 정확한 이름이 나온다.

## 6. 체크리스트

- [ ] `--from-literal`, `--from-file` 생성을 안 보고 친다
- [ ] env(valueFrom) / envFrom / volume 3가지 주입을 모두 쓸 수 있다
- [ ] secret 값 디코딩 (`jsonpath + base64 -d`)을 안다
- [ ] env는 재시작 필요, 볼륨은 자동 갱신 차이를 안다
- [ ] `kubectl create secret tls / docker-registry`를 안다
- [ ] CreateContainerConfigError의 의미를 안다
