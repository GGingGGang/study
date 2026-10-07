# 트리와 유니온 파인드 (Tree & Union-Find)

> 알고리즘 · 그래프 · 학습내용: 트리의 성질(N-1개 간선·사이클 없음·경로 유일), 부모 배열로 루트 트리 만들기, 전위·중위·후위 순회, 두 번 BFS로 트리의 지름, DFS로 서브트리 크기, 유니온 파인드(union by size + 경로 압축), 사이클 판별, 크루스칼 MST와 프림 MST, MST의 성질

---

## 1. 트리의 성질 ★★★

**트리는 사이클 없는 연결 그래프**다. 아래 조건들은 서로 동치라서, 문제에서 하나가 주어지면 나머지를 공짜로 얻는다.

| 성질 | 활용 |
|------|------|
| 정점 `N`개 · 간선 정확히 `N-1`개 | 간선 수만 세어도 트리 후보 판정 |
| 사이클이 없다 | 방문 배열 없이 **부모만 피하면** 재방문이 없다 |
| 임의의 두 정점 사이 **경로가 유일** | "최단 경로 = 유일한 경로". 최단경로 알고리즘 불필요 |
| 연결되어 있다 | 연결 요소가 정확히 1개 |
| 아무 간선이나 하나 끊으면 두 조각 | 모든 간선이 단절선 |
| 아무 간선이나 하나 더하면 사이클 1개 생김 | 사이클 판별 문제의 단골 |

> ★★★ **핵심**: **`N`개 정점, `N-1`개 간선, 연결됨 → 셋 중 둘만 확인해도 트리다.** 그리고 트리라는 걸 알면 **가중치가 있어도 다익스트라가 필요 없다.** 경로가 유일하니 그냥 DFS/BFS 한 번이면 거리가 나온다.

---

## 2. 루트 트리 만들기 (부모 배열) ★★★

입력은 보통 방향 없는 간선 목록이다. 여기에 루트를 정해 **부모/자식 관계를 부여**하는 게 첫 단계다.

```python
from collections import deque

n = 7
tree = [[] for _ in range(n + 1)]
for a, b in [(1,2),(1,3),(2,4),(2,5),(3,6),(3,7)]:
    tree[a].append(b)
    tree[b].append(a)                 # 무방향으로 받는다

def rooting(root):
    parent = [0] * (n + 1)
    order = []                        # 방문 순서 = 위상 순서(부모가 항상 먼저)
    parent[root] = root               # 루트의 부모는 자기 자신
    q = deque([root])
    while q:
        v = q.popleft()
        order.append(v)
        for nxt in tree[v]:
            if nxt != parent[v]:      # ★ 부모만 피하면 트리는 재방문이 없다
                parent[nxt] = v
                q.append(nxt)
    return parent, order

parent, order = rooting(1)
# parent[1:] == [1, 1, 1, 2, 2, 3, 3]
# order      == [1, 2, 3, 4, 5, 6, 7]
```

> ★★★ **핵심**: **BFS로 루팅하면 `order`가 공짜로 딸려온다.** `order` 순서대로 처리하면 "부모 → 자식" 방향 DP, **`reversed(order)`로 처리하면 "자식 → 부모" 방향 DP**가 된다. 이 두 줄이 재귀 DFS를 완전히 대체하므로 정점이 10만 개여도 스택이 터지지 않는다. 트리 DP의 표준 골격이다.

`parent[root] = root`로 두면 `nxt != parent[v]` 검사가 루트에서도 자연스럽게 동작한다. `parent[root] = 0`으로 둬도 1-indexed라면 마찬가지다.

---

## 3. 서브트리 크기 ★★

```python
size = [1] * (n + 1)                  # 자기 자신 1개로 시작
for v in reversed(order):             # 리프 → 루트 방향으로 누적
    if v != 1:                        # 루트가 아니면 부모에게 더해준다
        size[parent[v]] += size[v]
# size[1:] == [7, 3, 3, 1, 1, 1, 1]
```

재귀로 쓰면 흔히 이렇게 짜지만, 깊이가 깊으면 위험하다.

```python
import sys
sys.setrecursionlimit(10 ** 6)

def subtree(v, par):
    s = 1
    for nxt in tree[v]:
        if nxt != par:
            s += subtree(nxt, v)      # 반환값을 누적하는 게 핵심
    size[v] = s
    return s
```

> **함정**: 트리 재귀는 **일자로 늘어선 트리(사슬)에서 깊이가 `N`까지 간다.** `N = 100,000`이면 `sys.setrecursionlimit`을 올려도 실제 C 스택이 감당 못 해 세그폴트가 난다. **`reversed(order)` 반복 방식이 언제나 안전하다.**

---

## 4. 트리 순회 (전위·중위·후위) ★

**이진 트리**에서만 셋이 모두 정의된다. 일반 트리는 전위(내려가며)·후위(올라오며) 둘뿐이다.

```python
left  = {1: 2, 2: 4, 3: 6}
right = {1: 3, 2: 5, 3: 7}
pre, ino, post = [], [], []

def walk(v):
    if v is None:
        return
    pre.append(v)                     # 전위: 나 → 왼쪽 → 오른쪽
    walk(left.get(v))
    ino.append(v)                     # 중위: 왼쪽 → 나 → 오른쪽
    walk(right.get(v))
    post.append(v)                    # 후위: 왼쪽 → 오른쪽 → 나

walk(1)
# 전위 [1, 2, 4, 5, 3, 6, 7]
# 중위 [4, 2, 5, 1, 6, 3, 7]
# 후위 [4, 5, 2, 6, 7, 3, 1]
```

| 순회 | 순서 | 언제 쓰나 |
|------|------|-----------|
| 전위 (preorder) | 나 → 왼 → 오 | 트리 복사, 위에서 아래로 값 전파 |
| 중위 (inorder) | 왼 → 나 → 오 | **이진 탐색 트리면 정렬된 순서**가 나옴 |
| 후위 (postorder) | 왼 → 오 → 나 | **자식 결과를 모아 부모를 계산** (트리 DP, 서브트리 크기) |

**후위 순서가 실전에서 가장 중요하다.** "자식이 전부 끝난 뒤에 나를 계산한다"는 게 트리 DP의 정의 그 자체이고, 앞의 `reversed(order)`가 정확히 이 순서를 반복문으로 흉내 낸 것이다.

---

## 5. 트리의 지름 — 두 번 BFS ★★★

**지름(diameter)**은 트리에서 가장 먼 두 정점 사이의 거리다.

```python
from collections import deque

n2 = 6
wt = [[] for _ in range(n2 + 1)]
for a, b, w in [(1,2,3),(1,3,4),(2,4,2),(3,5,6),(3,6,1)]:
    wt[a].append((b, w))
    wt[b].append((a, w))

def farthest(start):
    dist = [-1] * (n2 + 1)
    dist[start] = 0
    q = deque([start])
    while q:
        v = q.popleft()
        for nxt, w in wt[v]:
            if dist[nxt] == -1:
                dist[nxt] = dist[v] + w   # 트리는 경로가 유일 → 이게 곧 최단거리
                q.append(nxt)
    best = max(range(1, n2 + 1), key=lambda i: dist[i])
    return best, dist[best]

u, _ = farthest(1)                    # ① 아무 정점에서 가장 먼 정점 u
v, diameter = farthest(u)             # ② u에서 가장 먼 정점까지가 지름
# u == 5, v == 4, diameter == 15   (4-2-1-3-5 = 2+3+4+6)
```

> ★★★ **핵심**: **아무 정점에서 가장 먼 정점은 반드시 지름의 한쪽 끝점이다.** 이게 증명되기 때문에 BFS 두 번, `O(N)`으로 끝난다. 모든 쌍을 재보는 `O(N²)`이나 다익스트라는 전혀 필요 없다.

**직관적 증명**: 임의의 점 `x`에서 가장 먼 점을 `u`라 하자. 만약 `u`가 지름의 끝점이 아니라면, 지름의 양 끝 `a, b`에 대해 `x`에서 `u`로 가는 경로와 지름 경로를 이어붙여 `a`나 `b`에서 `u`까지의 거리가 지름보다 길어지는 모순이 생긴다.

**가중치가 음수면 이 방법이 깨진다.** 그때는 트리 DP(각 정점에서 자식 방향 최장 두 개를 합치기)로 풀어야 한다.

---

## 6. 유니온 파인드 (서로소 집합) ★★★

```python
class DSU:
    def __init__(self, n):
        self.p = list(range(n + 1))       # 각자 자기 자신이 대표
        self.sz = [1] * (n + 1)           # 집합 크기

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]] # ★ 경로 압축: 부모를 조부모로 당긴다
            x = self.p[x]
        return x                          # 반복문이라 재귀 깊이 걱정이 없다

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False                  # 이미 같은 집합 → 합칠 게 없다
        if self.sz[ra] < self.sz[rb]:     # ★ union by size: 큰 쪽에 작은 쪽을 붙인다
            ra, rb = rb, ra
        self.p[rb] = ra
        self.sz[ra] += self.sz[rb]
        return True

d = DSU(6)
d.union(1, 2); d.union(2, 3)
d.union(1, 3)                             # False — 이미 같은 집합
d.find(3) == d.find(1)                    # True
len({d.find(i) for i in range(1, 7)})     # 4 — 그룹 수 {1,2,3},{4},{5},{6}
```

### 두 최적화가 왜 필요한가 ★★★

| 최적화 | 하는 일 | 없으면 |
|--------|---------|--------|
| **경로 압축** (path compression) | `find` 하는 김에 부모를 루트 쪽으로 당김 | 트리가 길어져 `find`가 `O(N)` |
| **union by size/rank** | 작은 트리를 큰 트리 밑에 붙임 | 한쪽으로만 길게 자라 사슬이 됨 |

> ★★★ **핵심**: **둘을 같이 쓰면 연산당 사실상 `O(1)`**(정확히는 역 아커만 함수 `α(N)`, `N`이 우주의 원자 수여도 5 미만)이다. 하나만 쓰면 `O(log N)`, 둘 다 없으면 `O(N)`이라 시간 초과가 난다. **둘 다 넣는 게 기본값**이라고 외운다.

> **함정**: 재귀 `find`는 `self.p[x] = self.find(self.p[x])`로 짜면 완전 압축이라 더 짧지만, **압축 전 첫 호출에서 깊이가 `N`까지 갈 수 있어 세그폴트 위험**이 있다. 위처럼 `while` + 반쪽 압축(`p[x] = p[p[x]]`)이면 재귀가 아예 없으면서 성능은 같은 수준이다.

**`union`이 `False`를 반환한다 = 이미 연결되어 있었다**는 정보가 핵심이다. 이게 그대로 사이클 판별과 크루스칼로 이어진다.

---

## 7. 사이클 판별 ★★

```python
def has_cycle(n, edges):
    dsu = DSU(n)
    for a, b in edges:
        if not dsu.union(a, b):       # 이미 같은 집합인데 또 이으면 사이클
            return True
    return False

has_cycle(4, [(1,2),(2,3),(3,4)])     # False (트리)
has_cycle(4, [(1,2),(2,3),(3,1)])     # True
```

**무방향 그래프**의 사이클 판별은 유니온 파인드가 가장 깔끔하다. **방향 그래프**는 이 방법이 통하지 않고, DFS의 방문 중/완료 상태 구분이나 위상 정렬(정렬 결과 길이 < N)을 써야 한다.

---

## 8. 크루스칼 MST ★★★

**MST(최소 신장 트리)**는 모든 정점을 잇는 간선 부분집합 중 가중치 합이 최소인 것이다. 당연히 간선은 `N-1`개다.

```python
def kruskal(n, edges):
    edges.sort(key=lambda x: x[2])        # ① 가중치 오름차순 정렬
    dsu = DSU(n)
    total, used = 0, []
    for a, b, w in edges:
        if dsu.union(a, b):               # ② 사이클을 만들지 않는 간선만 채택
            total += w
            used.append((a, b, w))
            if len(used) == n - 1:        # ③ N-1개 모으면 끝
                break
    return (total, used) if len(used) == n - 1 else (None, [])

E = [(1,2,1),(1,3,4),(2,3,2),(2,4,5),(3,4,3),(4,5,7),(3,5,6)]
kruskal(5, list(E))
# (12, [(1, 2, 1), (2, 3, 2), (3, 4, 3), (3, 5, 6)])
```

> ★★★ **핵심**: 크루스칼은 **"정렬 + 유니온 파인드"** 딱 두 줄짜리 아이디어다. 시간 복잡도는 정렬이 지배해 **`O(E log E)`**. 간선을 싼 것부터 보면서 **사이클만 안 만들면 무조건 채택**하는 그리디가 최적을 보장한다(컷 성질).

> **함정**: 그래프가 연결되어 있지 않으면 간선을 `N-1`개 못 모은다. **채택한 간선 수가 `N-1`인지 반드시 확인**해야 하고, 그렇지 않으면 MST가 존재하지 않는다(최소 신장 **포레스트**만 가능).

**`edges.sort()`는 원본 리스트를 바꾼다.** 같은 간선 목록을 뒤에서 또 쓴다면 `list(E)`로 복사해서 넘긴다.

---

## 9. 프림 MST ★★

```python
import heapq

def prim(n, adj, start=1):
    visited = [False] * (n + 1)
    pq = [(0, start)]                     # (가중치, 정점)
    total, cnt = 0, 0
    while pq and cnt < n:
        w, v = heapq.heappop(pq)
        if visited[v]:                    # 낡은 항목 버리기 (다익스트라와 같은 패턴)
            continue
        visited[v] = True
        total += w
        cnt += 1
        for nxt, nw in adj[v]:
            if not visited[nxt]:
                heapq.heappush(pq, (nw, nxt))
    return total if cnt == n else None    # 전부 못 담았으면 비연결

adj = [[] for _ in range(6)]
for a, b, w in E:
    adj[a].append((b, w))
    adj[b].append((a, w))
prim(5, adj)                              # 12 — 크루스칼과 같은 값
```

**프림은 다익스트라와 코드 모양이 거의 같다.** 차이는 힙에 넣는 값이 **"시작점부터의 누적 거리"가 아니라 "그 간선 하나의 가중치"**라는 점뿐이다. MST는 경로가 아니라 연결 비용을 최소화하기 때문이다.

| | 크루스칼 | 프림 |
|---|---|---|
| 관점 | 간선 중심 | 정점 중심 |
| 복잡도 | `O(E log E)` | `O(E log V)` |
| 유리한 경우 | **희소 그래프** (실전 대부분) | 밀집 그래프 |
| 필요한 자료구조 | 정렬 + 유니온 파인드 | 힙 + 인접 리스트 |

**실전에선 크루스칼이 기본**이다. 구현이 짧고 간선 목록을 그대로 받아 쓸 수 있으며, "간선 하나를 반드시 포함/제외" 같은 변형에도 대응이 쉽다.

---

## 10. MST의 성질과 응용 ★★

| 성질 | 활용 |
|------|------|
| **컷 성질**: 어떤 컷을 가로지르는 최소 간선은 항상 어떤 MST에 속함 | 크루스칼·프림 정당성의 근거 |
| **사이클 성질**: 사이클에서 가장 무거운 간선은 MST에 없음 | 간선 제거 문제 |
| 가중치가 모두 다르면 **MST가 유일** | 같은 값이 있으면 여러 개 가능 |
| MST는 **두 정점 간 경로의 최대 간선을 최소화** (minimax) | "가장 위험한 구간을 최소화" 유형 |
| MST는 **최단 경로 트리가 아니다** | 두 정점 최단거리를 묻는 문제에 쓰면 틀림 |

> **함정**: **MST 위의 경로는 최단 경로가 아니다.** "모든 도시를 잇는 최소 비용"은 MST, "A에서 B까지 최소 비용"은 다익스트라다. 문제 문장을 이 기준으로 갈라 읽는다.

자주 나오는 변형은 **"간선 `N-1`개보다 적게 써도 될 때"**다. 마을을 `K`개 그룹으로 나눠도 된다면, MST를 만든 뒤 **가장 비싼 간선 `K-1`개를 빼면** 된다. 크루스칼에서 `N-1`개 대신 `N-K`개만 채택하는 것과 같다.

---

### 한 줄 요약
트리는 **`N-1`개 간선·경로 유일**이라는 성질 덕에 최단경로 알고리즘 없이 BFS만으로 풀리고, **BFS 루팅으로 얻은 `order`를 `reversed`로 돌리는 게 트리 DP의 안전한 표준 골격**이다. **지름은 BFS 두 번**으로 `O(N)`에 끝나며, **유니온 파인드는 경로 압축 + union by size를 둘 다 넣어야** 사실상 `O(1)`이 되고, 그 위에 **정렬 한 줄만 얹으면 크루스칼 MST**가 완성된다.

### 참고 (공식 문서)
- heapq — 힙 큐 알고리즘 — https://docs.python.org/3/library/heapq.html
- collections.deque — https://docs.python.org/3/library/collections.html#collections.deque
- list.sort / sorted 와 key 인자 — https://docs.python.org/3/howto/sorting.html
- sys.setrecursionlimit — https://docs.python.org/3/library/sys.html#sys.setrecursionlimit
- 클래스 정의 문법 — https://docs.python.org/3/tutorial/classes.html
- 파이썬 자료구조별 시간 복잡도 — https://wiki.python.org/moin/TimeComplexity
