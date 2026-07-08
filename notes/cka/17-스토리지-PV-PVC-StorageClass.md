# 17. 스토리지 — PV, PVC, StorageClass

> 도메인: 스토리지 (10%)
> 시험 포인트: PV/PVC 생성과 바인딩, StorageClass와 동적 프로비저닝, 접근 모드와 반환 정책. 바인딩이 안 되는 이유 찾기가 단골.

---

## 1. 볼륨 기초 (Pod 수준)

### emptyDir — Pod 수명과 함께하는 임시 공간
```yaml
spec:
  containers:
  - name: app
    volumeMounts:
    - name: cache
      mountPath: /cache
  volumes:
  - name: cache
    emptyDir: {}
    # emptyDir: { sizeLimit: 500Mi, medium: Memory }  # RAM 디스크 옵션
```
- 같은 Pod의 **컨테이너 간 공유**에 사용 (사이드카 패턴). Pod 삭제 시 소멸.

### hostPath — 노드의 경로 마운트 (주의해서 사용)
```yaml
  volumes:
  - name: logs
    hostPath:
      path: /var/log
      type: Directory        # Directory | DirectoryOrCreate | File | ...
```
- 노드가 바뀌면 데이터가 다르다. 실습/시스템 에이전트 용도.

## 2. PV와 PVC — 스토리지의 분리 모델

- **PV (PersistentVolume)**: 관리자가 만드는 **클러스터 리소스** (실제 스토리지 조각)
- **PVC (PersistentVolumeClaim)**: 사용자가 내는 **요청서** (용량/모드) — 네임스페이스 스코프
- 바인딩: PVC 조건을 만족하는 PV와 1:1 결합

### PV
```yaml
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-data
spec:
  capacity:
    storage: 5Gi
  accessModes:
  - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain    # Retain | Delete
  storageClassName: manual                 # PVC와 일치해야 바인딩
  hostPath:                                # 실습용. 실전은 nfs/csi 등
    path: /mnt/data
```

### PVC
```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: pvc-data
  namespace: dev
spec:
  accessModes:
  - ReadWriteOnce
  resources:
    requests:
      storage: 3Gi              # PV 용량 이하면 바인딩 가능 (3Gi 요청 → 5Gi PV OK)
  storageClassName: manual
```

### Pod에서 사용
```yaml
spec:
  containers:
  - name: app
    volumeMounts:
    - name: data
      mountPath: /data
  volumes:
  - name: data
    persistentVolumeClaim:
      claimName: pvc-data
```

## 3. 접근 모드 (accessModes)

| 모드 | 약어 | 의미 |
|---|---|---|
| ReadWriteOnce | **RWO** | **한 노드**에서 읽기/쓰기 (같은 노드의 여러 Pod는 가능) |
| ReadOnlyMany | **ROX** | 여러 노드에서 읽기 전용 |
| ReadWriteMany | **RWX** | 여러 노드에서 읽기/쓰기 (NFS 등 일부만 지원) |
| ReadWriteOncePod | **RWOP** | **단 하나의 Pod**만 (v1.29+ GA) |

- 바인딩 시 PVC의 모드를 PV가 지원해야 함. **블록 스토리지(EBS류)는 RWX 불가**가 일반적.

## 4. 반환 정책 (persistentVolumeReclaimPolicy)

PVC 삭제 시 PV 처리:
| 정책 | 동작 |
|---|---|
| **Retain** | PV와 데이터 보존. 상태가 `Released`가 되며 **재사용하려면 수동 정리 필요** (claimRef 제거) |
| **Delete** | PV와 실제 스토리지 삭제 (동적 프로비저닝 기본값) |

- (Recycle은 폐기됨)
- `Released` PV는 자동으로 다른 PVC에 안 붙는다 — `kubectl edit pv`로 `spec.claimRef` 삭제하면 다시 `Available`

## 5. StorageClass와 동적 프로비저닝

PVC가 생기면 **PV를 자동 생성**해주는 템플릿.

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"   # 기본 클래스 지정
provisioner: ebs.csi.aws.com          # CSI 드라이버 (없으면 프로비저닝 불가)
                                       # 로컬/수동: kubernetes.io/no-provisioner
parameters:
  type: gp3
reclaimPolicy: Delete                  # 생성될 PV의 반환 정책
volumeBindingMode: WaitForFirstConsumer  # Immediate(기본) | WaitForFirstConsumer
allowVolumeExpansion: true             # PVC 확장 허용
```

- **WaitForFirstConsumer**: Pod가 실제로 스케줄될 때까지 바인딩/프로비저닝 지연 → PVC가 `Pending`이어도 **Pod를 만들기 전까진 정상**! (빈출 함정)
- 기본 StorageClass가 있으면 `storageClassName` 생략한 PVC에 자동 적용
- PVC에서 `storageClassName: ""`(빈 문자열)은 "동적 프로비저닝 쓰지 않겠다"는 의미

```bash
kubectl get sc
kubectl get pv,pvc -A
kubectl describe pvc pvc-data       # 바인딩 실패 사유는 Events에
```

## 6. 볼륨 확장

```bash
# StorageClass에 allowVolumeExpansion: true 일 때
kubectl edit pvc pvc-data           # spec.resources.requests.storage 증가 (축소 불가)
```

## 7. 바인딩 안 될 때 진단 (빈출)

PVC가 `Pending`일 때 확인 순서:
1. `kubectl describe pvc` — Events 메시지 읽기
2. **storageClassName 일치?** (PV ↔ PVC, 오타 포함)
3. **accessModes를 PV가 지원?**
4. **PV 용량 ≥ PVC 요청?**
5. PV 상태가 `Available`? (`Released`면 claimRef 정리)
6. StorageClass가 `WaitForFirstConsumer`? → **Pod를 만들면 해결**
7. 동적 프로비저닝이면 provisioner(CSI 드라이버)가 실제로 설치돼 있나

Pod가 `Pending` + "unbound immediate PersistentVolumeClaims" → 위 PVC 문제부터 해결.

## 8. PV 상태 요약

`Available`(대기) → `Bound`(사용 중) → `Released`(PVC 삭제됨, Retain) / `Failed`

## 9. 체크리스트

- [ ] PV(클러스터)/PVC(네임스페이스) 관계와 바인딩 조건 3가지(SC명, 모드, 용량)를 안다
- [ ] RWO/ROX/RWX/RWOP를 구분한다 (RWO는 "노드" 기준!)
- [ ] Retain vs Delete, Released 상태 처리법을 안다
- [ ] WaitForFirstConsumer의 "Pod 생기기 전 Pending은 정상"을 안다
- [ ] 기본 StorageClass 어노테이션을 안다
- [ ] PVC Pending 진단 순서가 몸에 배었다
