# LCA와 트리 쿼리 (Lowest Common Ancestor & Tree Queries)

> 알고리즘 · 심화 · 학습내용: LCA 정의와 깊이를 맞춰 같이 올라가는 O(N) 방법, 희소 배열(sparse table) 이진 상승법으로 O(log N) 만들기(`parent[k][v]` 전처리), depth를 이용한 두 정점 사이 거리, 오일러 투어 + 세그먼트 트리 방식 개념, 트리를 배열로 펴는 오일러 투어 테크닉(서브트리 = 연속 구간)과 펜윅/세그먼트 트리 결합, Sparse Table로 구간 최솟값을 O(1)에 답하기, DFS 전처리의 재귀 깊이 문제와 반복 DFS

---

## 1. LCA란 무엇인가 ★★★

**뿌리 있는 트리에서 두 정점 u, v의 공통 조상 중 가장 깊은(트리에서 가장 아래에 있는) 정점**이 LCA(Lowest Common Ancestor, 최소 공통 조상)다.

```
        1
      /   \
     2     3          LCA(7, 8) = 5
    / \     \         LCA(4, 7) = 2
   4   5     6        LCA(4, 6) = 1
      / \             LCA(2, 7) = 2  <- u가 v의 조상인 경우
     7   8
```

**u가 v의 조상이면 `LCA(u, v) = u`** 다. 이 경우를 빼먹는 게 1순위 버그다. LCA가 중요한 이유는 **트리의 거의 모든 경로 질의가 LCA로 환원되기 때문**이다. 두 정점 사이 경로는 반드시 `u → LCA → v` 형태라, 거리·경로상 최대 간선·경로 합이 전부 LCA에서 나온다.

---

## 2. 전처리 — depth와 parent 구하기 (반복 DFS) ★★★

무엇을 하든 먼저 **각 정점의 깊이(`depth`)와 부모(`par`)** 가 필요하다. 파이썬에서는 **재귀 DFS가 위험**하므로(7번 참고) 처음부터 **스택 기반 반복 DFS**로 짜는 습관을 들인다.

```python
def preprocess(n, graph, root=1):
    """1..n 번 정점 트리에서 depth와 부모를 구한다 (반복 DFS)"""
    depth = [0] * (n + 1)
    par = [0] * (n + 1)          # 루트의 부모는 0 (없음을 뜻하는 더미)
    visited = [False] * (n + 1)
    order = []                   # 방문 순서 (부모가 항상 자식보다 먼저 나온다)

    stack = [root]
    visited[root] = True
    while stack:
        v = stack.pop()
        order.append(v)
        for nxt in graph[v]:
            if not visited[nxt]:
                visited[nxt] = True
                par[nxt] = v
                depth[nxt] = depth[v] + 1
                stack.append(nxt)
    return depth, par, order


# 위 그림의 트리 (인접 리스트, 양방향)
edges = [(1, 2), (1, 3), (2, 4), (2, 5), (3, 6), (5, 7), (5, 8)]
n = 8
graph = [[] for _ in range(n + 1)]
for u, v in edges:
    graph[u].append(v)
    graph[v].append(u)

depth, par, order = preprocess(n, graph, 1)
print(depth[1:])     # [0, 1, 1, 2, 2, 2, 3, 3]
print(par[1:])       # [0, 1, 1, 2, 2, 3, 5, 5]
```

> **함정**: 트리는 보통 **양방향 간선**으로 주어진다. `visited` 없이 순회하면 부모로 되돌아가 무한 루프에 빠진다. `par[v]`를 비교해 거르는 방법도 있지만, **`visited` 배열이 가장 안전**하다.

---

## 3. 단순 O(N) 방법 — 깊이 맞추고 같이 올라가기 ★★

가장 직관적인 방법이다. **깊은 쪽을 먼저 끌어올려 깊이를 맞춘 뒤, 둘이 만날 때까지 한 칸씩 같이 올라간다.**

```python
def lca_naive(u, v, depth, par):
    while depth[u] > depth[v]:     # (1) 깊이 맞추기
        u = par[u]
    while depth[v] > depth[u]:
        v = par[v]
    while u != v:                  # (2) 같이 한 칸씩
        u = par[u]
        v = par[v]
    return u


print(lca_naive(7, 8, depth, par))   # 5
print(lca_naive(4, 6, depth, par))   # 1
print(lca_naive(2, 7, depth, par))   # 2  (조상인 경우)
```

**질의당 O(트리 높이)** 라, 한쪽으로 늘어진 사슬 트리에서는 O(N)이다. 정점 10만·질의 10만이면 100억 연산으로 터진다.

---

## 4. 희소 배열 이진 상승법 — O(log N) LCA ★★★

핵심 발상: **"한 칸씩 올라가지 말고 2^k칸씩 점프하자."**

`par[k][v]` = **정점 v에서 2^k번 위로 올라간 조상**. 이 표는 아래 점화식으로 채운다.

```
par[0][v]  = v의 부모
par[k][v]  = par[k-1][ par[k-1][v] ]     # 2^(k-1)칸 두 번 = 2^k칸
```

```python
class LCA:
    def __init__(self, n, graph, root=1):
        self.n = n
        self.LOG = max(1, n.bit_length())        # 2^LOG > n 이 되도록
        self.depth, par0, _ = preprocess(n, graph, root)

        # par[k][v] = v의 2^k번째 조상 (없으면 0)
        self.par = [[0] * (n + 1) for _ in range(self.LOG)]
        self.par[0] = par0[:]
        for k in range(1, self.LOG):
            pk, pk1 = self.par[k], self.par[k - 1]
            for v in range(1, n + 1):
                pk[v] = pk1[pk1[v]]              # 두 번 점프 = 한 번의 큰 점프

    def query(self, u, v):
        if self.depth[u] < self.depth[v]:        # u를 더 깊은 쪽으로
            u, v = v, u

        # (1) 깊이 차이를 이진수로 쪼개 한 번에 끌어올린다
        diff = self.depth[u] - self.depth[v]
        k = 0
        while diff:
            if diff & 1:
                u = self.par[k][u]
            diff >>= 1
            k += 1

        if u == v:                               # v가 u의 조상이었던 경우
            return u

        # (2) "부모가 달라지는" 최대 점프를 큰 것부터 시도한다
        for k in range(self.LOG - 1, -1, -1):
            if self.par[k][u] != self.par[k][v]:
                u = self.par[k][u]
                v = self.par[k][v]
        return self.par[0][u]                    # 한 칸 더 올라가면 LCA

    def dist(self, u, v):
        """두 정점 사이 거리 = 간선 개수"""
        return self.depth[u] + self.depth[v] - 2 * self.depth[self.query(u, v)]


L = LCA(n, graph, 1)
print(L.query(7, 8), L.query(4, 6), L.query(2, 7))   # 5 1 2
print(L.dist(7, 8), L.dist(4, 6), L.dist(4, 8))      # 2 4 3
```

**두 번째 루프가 왜 `!=` 조건인지**가 이해의 관문이다. `par[k][u] == par[k][v]`면 **LCA를 지나쳐버린 것**이므로 점프하지 않고, 다를 때만 올라간다. 그렇게 큰 점프부터 훑고 나면 u와 v는 **LCA 바로 아래 자식**에 서 있게 되고, 한 칸만 더 올라가면 답이다.

> ★★★ **핵심**: 트리에서 두 정점 사이 거리는 **`depth[u] + depth[v] - 2 * depth[LCA(u,v)]`** 다. 루트에서 각각 내려온 길이를 더한 뒤, 공통으로 두 번 센 부분(루트~LCA)을 두 번 빼면 된다. 가중치 트리라면 `depth`를 "루트로부터의 거리 합"으로 바꾸면 그대로 성립한다.

---

## 5. 오일러 투어 테크닉 — 서브트리를 연속 구간으로 ★★★

**트리를 배열로 펴는 기술**이다. DFS로 들어갈 때 `tin[v]`(진입 시각), 나올 때 `tout[v]`(마지막 자손의 시각)를 기록하면 **정점 v의 서브트리가 배열 구간 `[tin[v], tout[v]]`** 가 된다. 트리 질의가 **평범한 구간 질의로 바뀌므로 세그먼트 트리·펜윅을 그대로 얹을 수 있다.**

```python
def euler_tour(n, graph, root=1):
    tin = [0] * (n + 1)
    tout = [0] * (n + 1)
    timer = 0
    visited = [False] * (n + 1)

    stack = [(root, False)]      # (정점, 자식 처리 끝났는지)
    visited[root] = True
    while stack:
        v, done = stack.pop()
        if done:                 # 되돌아 나오는 시점
            tout[v] = timer - 1
            continue
        tin[v] = timer
        timer += 1
        stack.append((v, True))  # 나중에 다시 꺼내 tout을 찍는다
        for nxt in graph[v]:
            if not visited[nxt]:
                visited[nxt] = True
                stack.append((nxt, False))
    return tin, tout


tin, tout = euler_tour(n, graph, 1)
print(tin[1], tout[1])     # 0 7  (루트 = 배열 전체 구간)
print(tin[2], tout[2])     # 3 7  서브트리 {2,4,5,7,8} 이 연속 구간
print(tin[4], tout[4])     # 7 7  리프는 tin == tout
```

### 펜윅 트리와 결합 — "서브트리 전체 합" 질의

```python
class BIT:
    def __init__(self, n):
        self.n = n
        self.tree = [0] * (n + 1)

    def update(self, i, d):        # 0-based 위치 i에 d를 더한다
        i += 1
        while i <= self.n:
            self.tree[i] += d
            i += i & -i

    def _q(self, i):
        s = 0
        while i > 0:
            s += self.tree[i]
            i -= i & -i
        return s

    def range_sum(self, l, r):     # 0-based 폐구간 [l, r]
        return self._q(r + 1) - self._q(l)


val = [0, 10, 20, 30, 40, 50, 60, 70, 80]     # val[v] = 정점 v의 값 (1-based)
bit = BIT(n)
for v in range(1, n + 1):
    bit.update(tin[v], val[v])                # 정점을 오일러 위치에 꽂는다

# 정점 2의 서브트리 {2,4,5,7,8} 합 = 20+40+50+70+80
print(bit.range_sum(tin[2], tout[2]))         # 260
bit.update(tin[7], 1000)                      # 정점 7의 값 갱신 -> O(log n)
print(bit.range_sum(tin[2], tout[2]))         # 1260
```

> ★★★ **핵심**: **"서브트리에 전부 더하기 / 서브트리 합 구하기"는 오일러 투어로 구간 문제가 된다.** 반대로 **"루트~정점 경로"** 질의는 `tin`에 +v, `tout+1`에 -v를 꽂는 **차분(difference) 트릭**으로 처리한다. 트리 질의를 보면 먼저 "이게 서브트리 질의인가, 경로 질의인가"를 나눠 생각하자.

### 오일러 투어 + 세그먼트 트리 LCA (개념)

LCA 자체도 오일러 투어로 풀 수 있다. **DFS 하며 방문할 때마다(되돌아올 때도) 정점을 기록**하면 길이 `2N-1`의 배열이 나온다. 여기서 `u`가 처음 나온 위치와 `v`가 처음 나온 위치 사이 구간에서 **깊이가 가장 작은 정점이 곧 LCA**다. 즉 **LCA 문제가 구간 최솟값(RMQ) 문제로 환원**된다. 다만 파이썬에서는 배열이 2배로 커지고 상수도 커서, **실전에서는 4번의 이진 상승법이 더 안전**하다.

---

## 6. Sparse Table — 구간 최솟값을 O(1)에 ★★

**값이 절대 바뀌지 않는 배열**의 구간 최솟값·최댓값이라면 세그먼트 트리보다 **Sparse Table**이 낫다. 전처리 O(N log N), **질의 O(1)**. 원리는 `min(a, a) = a`, 즉 **겹쳐도 되는(idempotent) 연산**이라 구간을 **겹치게 두 조각**으로 덮어도 답이 맞다는 점이다.

```python
class SparseTableMin:
    def __init__(self, arr):
        n = len(arr)
        self.LOG = [0] * (n + 1)                    # LOG[x] = floor(log2 x)
        for i in range(2, n + 1):
            self.LOG[i] = self.LOG[i // 2] + 1
        K = self.LOG[n] + 1

        # table[k][i] = arr[i : i + 2^k] 의 최솟값
        self.table = [arr[:]] + [[0] * n for _ in range(K - 1)]
        for k in range(1, K):
            span, half = 1 << k, 1 << (k - 1)
            prev, cur = self.table[k - 1], self.table[k]
            for i in range(n - span + 1):
                cur[i] = min(prev[i], prev[i + half])

    def query(self, l, r):                          # 0-based 폐구간 [l, r]
        k = self.LOG[r - l + 1]
        # 앞에서 2^k칸, 뒤에서 2^k칸 — 겹쳐도 min이라 상관없다
        return min(self.table[k][l], self.table[k][r - (1 << k) + 1])


st = SparseTableMin([3, 1, 4, 1, 5, 9, 2, 6])
print(st.query(2, 5), st.query(0, 7), st.query(5, 7))   # 1 1 2
```

| 자료구조 | 전처리 | 질의 | 갱신 | 가능한 연산 |
|---|---|---|---|---|
| Sparse Table | O(N log N) | **O(1)** | **불가** | min/max/gcd 등 겹쳐도 되는 연산 |
| 세그먼트 트리 | O(N) | O(log N) | O(log N) | 임의의 결합 연산 |
| 펜윅 트리 | O(N log N) | O(log N) | O(log N) | 합처럼 역원이 있는 연산 |

> **함정**: Sparse Table은 **갱신이 안 된다.** 그리고 **합(`sum`)에는 쓸 수 없다** — 구간이 겹치면 겹친 부분이 두 번 더해지기 때문이다. 겹쳐도 답이 안 변하는 min/max/gcd에만 쓴다.

---

## 7. 재귀 깊이 문제와 반복 DFS ★★★

파이썬 기본 재귀 한계는 **1000**이다. 정점 10만짜리 사슬 트리를 재귀 DFS로 훑으면 즉시 `RecursionError`(채점 결과로는 **런타임 에러**)가 뜬다.

```python
import sys
sys.setrecursionlimit(10 ** 6)      # 흔히 쓰는 응급 처치
```

하지만 이것만으로는 부족하다. **파이썬 스택 프레임은 무겁고, 인터프리터 실제 C 스택이 먼저 터지면 `RecursionError`가 아니라 세그폴트로 죽는다.** 그래서 **깊이가 10만을 넘길 수 있으면 처음부터 반복 DFS로 짜는 게 정답**이다.

| 상황 | 대응 |
|---|---|
| 깊이 ≤ 수천 | 재귀 + `setrecursionlimit` 로 충분 |
| 깊이 10만 이상 가능 | **반복 DFS 필수** (2번·5번 코드 형태) |
| 재귀 로직이 복잡해 못 펴겠다 | `threading.stack_size()` 로 큰 스택 스레드에서 실행 |

```python
import sys, threading

def solve():
    sys.setrecursionlimit(10 ** 6)
    # ... 깊은 재귀를 쓰는 코드 ...
    print("done")

threading.stack_size(64 * 1024 * 1024)     # 64MB 스택
t = threading.Thread(target=solve)
t.start()
t.join()
```

아래는 **정점 10만짜리 완전 사슬 트리**에서 반복 DFS 전처리 + 이진 상승 LCA가 정상 동작하는지 확인하는 코드다.

```python
n = 100000
graph = [[] for _ in range(n + 1)]
for v in range(2, n + 1):                  # 1-2-3-...-100000 사슬
    graph[v].append(v - 1)
    graph[v - 1].append(v)

depth, par, order = preprocess(n, graph, 1)   # 재귀였다면 여기서 터진다
L = LCA(n, graph, 1)
print(depth[n])                # 99999
print(L.query(n, n // 2))      # 50000 (사슬이므로 얕은 쪽이 LCA)
print(L.dist(1, n))            # 99999
```

> **함정**: `sys.setrecursionlimit(10**9)` 같이 터무니없이 크게 잡는 건 도움이 안 된다. 파이썬은 제한만 풀 뿐 **실제 스택 메모리를 늘려주지 않아서**, 한계를 넘으면 예외 대신 프로세스가 그대로 죽는다.

---

### 한 줄 요약
LCA는 트리 경로 질의의 관문이며, 깊이를 맞추고 한 칸씩 올라가는 방법은 O(트리 높이)라 사슬 트리에서 터지므로 **`par[k][v] = par[k-1][par[k-1][v]]` 희소 배열 이진 상승법**으로 전처리 O(N log N)·질의 O(log N)을 만든다. 구현의 관문은 **깊이 차를 이진수로 쪼개 끌어올린 뒤 `u == v`(조상인 경우)를 먼저 걸러내고, `par[k][u] != par[k][v]`일 때만 큰 점프부터 올라가는** 두 단계이며, 여기서 **거리 = `depth[u] + depth[v] - 2*depth[LCA]`** 가 바로 나온다. **오일러 투어 테크닉**은 `tin`/`tout`으로 **서브트리를 연속 구간으로 펴서** 트리 질의를 세그먼트 트리·펜윅의 구간 질의로 바꿔주고, **값이 안 바뀌는 구간 최소·최대는 Sparse Table로 O(1) 질의**가 가능하다(단 갱신 불가, 합에는 사용 불가). 무엇보다 파이썬에서는 **재귀 DFS가 10만 깊이에서 런타임 에러로 죽으므로, 전처리를 처음부터 스택 기반 반복 DFS로 짜는 것**이 실전에서 가장 중요하다.

### 참고 (공식 문서)
- Python `sys.setrecursionlimit` / `getrecursionlimit` — https://docs.python.org/3/library/sys.html#sys.setrecursionlimit
- Python `threading.stack_size` — https://docs.python.org/3/library/threading.html#threading.stack_size
- Python `int.bit_length` (희소 배열 LOG 계산) — https://docs.python.org/3/library/stdtypes.html#int.bit_length
- Python `collections.deque` (BFS 전처리용) — https://docs.python.org/3/library/collections.html#collections.deque
- Python `RecursionError` — https://docs.python.org/3/library/exceptions.html#RecursionError
- TimeComplexity — 파이썬 연산별 시간복잡도 — https://wiki.python.org/moin/TimeComplexity
