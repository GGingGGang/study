# 그래프 심화 — SCC와 이분 매칭 (SCC & Bipartite Matching)

> 알고리즘 · 그래프 · 학습내용: 강한 연결 요소(SCC) 개념, 타잔 알고리즘(DFS low-link + 스택) 반복 구현, 코사라주 알고리즘, SCC 압축 후 DAG 위상정렬, 2-SAT(함의 그래프와 SCC 판별), 이분 그래프 판별(BFS 2색칠), 이분 매칭(헝가리안·쾨닉 정리), 최대 유량과 최대유량-최소컷 정리, 단절점·단절선

---

## 1. 강한 연결 요소 (SCC) ★★★

**방향 그래프**에서 **서로 오갈 수 있는 정점들의 최대 집합**이 SCC(Strongly Connected Component)다. `u → v` 경로와 `v → u` 경로가 **둘 다** 있어야 같은 SCC다.

| 개념 | 내용 |
|------|------|
| SCC | 서로 도달 가능한 정점들의 극대 집합 |
| 무방향 연결 요소와의 차이 | 방향을 지켜야 하므로 훨씬 잘게 쪼개진다 |
| 정점 하나짜리 SCC | 흔하다. 사이클에 안 속한 정점은 전부 혼자 |
| **압축 그래프** | 각 SCC를 정점 하나로 축약한 것 — **반드시 DAG** |
| 복잡도 | 타잔·코사라주 모두 `O(V + E)` |

**압축하면 DAG가 된다는 게 핵심 성질이다.** 압축 그래프에 사이클이 있다면 그 사이클 위의 SCC들은 서로 오갈 수 있으니 애초에 하나의 SCC여야 한다 — 모순이다. 그래서 **SCC를 구하는 순간 어떤 방향 그래프든 DAG로 바꿔 위상 정렬·DAG DP를 쓸 수 있게 된다.**

---

## 2. 타잔 알고리즘 ★★★

DFS 한 번에 SCC를 전부 찾는다. 두 배열이 핵심이다.

- `idx[v]`: `v`를 **발견한 순번**(고정)
- `low[v]`: `v`와 그 자손이 **역간선을 한 번까지 써서 닿을 수 있는 최소 `idx`**

**`low[v] == idx[v]`이면 `v`가 SCC의 뿌리**다. `v` 아래로 내려간 어떤 자손도 `v`보다 위로 못 올라갔다는 뜻이므로, 스택에서 `v`가 나올 때까지 꺼낸 것이 하나의 SCC다.

```python
def tarjan_scc(n, graph):
    idx = [0] * (n + 1)              # 발견 순번 (0이면 미방문)
    low = [0] * (n + 1)              # 자신+자손이 닿을 수 있는 최소 발견 순번
    on_stack = [False] * (n + 1)
    stk, sccs = [], []
    counter = 1
    for s in range(1, n + 1):
        if idx[s]:
            continue
        call = [(s, 0)]              # (정점, 다음에 볼 이웃 인덱스) — 재귀를 손으로 편 것
        while call:
            v, i = call.pop()
            if i == 0:               # 이 정점에 처음 들어옴
                idx[v] = low[v] = counter
                counter += 1
                stk.append(v)
                on_stack[v] = True
            else:                    # 자식에서 돌아옴 → 자식의 low를 흡수
                low[v] = min(low[v], low[graph[v][i - 1]])
            descended = False
            while i < len(graph[v]):
                w = graph[v][i]
                i += 1
                if idx[w] == 0:                    # 트리 간선 → 내려간다
                    call.append((v, i))            # 돌아올 자리를 저장
                    call.append((w, 0))
                    descended = True
                    break
                if on_stack[w]:                    # 역/교차 간선이 스택 위에 있으면
                    low[v] = min(low[v], idx[w])   # ★ low가 아니라 idx로 갱신
            if descended:
                continue
            if low[v] == idx[v]:                   # v가 SCC의 뿌리
                comp = []
                while True:
                    w = stk.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == v:
                        break
                sccs.append(sorted(comp))
    return sccs

n = 7
graph = [[] for _ in range(n + 1)]
for a, b in [(1,2),(2,3),(3,1),(3,4),(4,5),(5,6),(6,4),(5,7)]:
    graph[a].append(b)
tarjan_scc(n, graph)
# [[7], [4, 5, 6], [1, 2, 3]]
```

> ★★★ **핵심**: **역간선 처리에서 `low[v] = min(low[v], idx[w])`이지 `low[w]`가 아니다.** `low[w]`로 쓰면 이미 완성된 다른 SCC의 정보가 새어 들어와 서로 다른 SCC가 붙어버린다. `on_stack[w]` 검사도 필수인데, **스택에 없는 `w`는 이미 다른 SCC로 확정된 정점**이라 참조하면 안 되기 때문이다.

> ★★★ **핵심**: **타잔은 SCC를 역위상 순서로 뱉는다.** 먼저 완성되는 SCC일수록 압축 DAG에서 **싱크(나가는 간선이 없는 쪽)**에 가깝다. 위 결과에서 `[7]`이 첫 번째이고 실제로 7은 싱크다. 이 성질이 2-SAT 해 구성에 그대로 쓰인다.

**재귀 대신 반복으로 짠 이유**: SCC 문제는 정점이 보통 10만 개 이상이고 DFS 깊이가 그만큼 깊어진다. `sys.setrecursionlimit`을 올려도 실제 C 스택이 버티지 못해 파이썬이 세그폴트로 죽는다. 위 형태는 `call` 리스트가 힙 메모리라 깊이 제한이 없다.

---

## 3. 코사라주 알고리즘 ★★

타잔보다 원리가 직관적이지만 DFS를 두 번 돌린다.

1. 원본 그래프에서 DFS를 돌려 **완료 순서(후위)**를 기록한다.
2. **모든 간선을 뒤집은 역그래프**를 만든다.
3. 1의 **역순**으로 정점을 꺼내며 역그래프에서 DFS를 돈다. **한 번의 DFS로 방문되는 정점 집합이 하나의 SCC**다.

**원리**: 후위 순서 역순으로 보면 압축 DAG 기준 소스(source) SCC부터 나온다. 역그래프에서 소스 SCC는 싱크가 되므로, 거기서 출발한 DFS는 자기 SCC 밖으로 나갈 수 없다.

| | 타잔 | 코사라주 |
|---|---|---|
| DFS 횟수 | 1회 | 2회 |
| 추가 메모리 | `idx`, `low`, 스택 | **역그래프 전체** |
| 실제 속도 | 더 빠름 | 상수가 큼 |
| 이해 난이도 | low-link가 헷갈림 | 직관적 |
| SCC 출력 순서 | **역위상 순서** | **위상 순서** |

**실전에선 타잔이 기본**이다. 역그래프를 안 만들어도 되고 한 번만 훑는다. 코사라주는 원리 설명과 정답 검증용 레퍼런스로 유용하다.

---

## 4. SCC 압축 후 DAG로 만들기 ★★★

```python
from collections import deque

def condense(n, graph, sccs):
    comp = [0] * (n + 1)                  # comp[v] = v가 속한 SCC 번호
    for i, group in enumerate(sccs):
        for v in group:
            comp[v] = i
    m = len(sccs)
    dag = [set() for _ in range(m)]       # set으로 중복 간선 제거
    indeg = [0] * m
    for v in range(1, n + 1):
        for w in graph[v]:
            if comp[v] != comp[w]:        # SCC 내부 간선은 버린다
                dag[comp[v]].add(comp[w])
    for u in range(m):
        for w in dag[u]:
            indeg[w] += 1
    q = deque(u for u in range(m) if indeg[u] == 0)
    order = []
    while q:                              # 압축 그래프는 DAG이므로 위상정렬 가능
        u = q.popleft()
        order.append(u)
        for w in dag[u]:
            indeg[w] -= 1
            if indeg[w] == 0:
                q.append(w)
    return comp, dag, order

comp, dag, order = condense(n, graph, tarjan_scc(n, graph))
# comp[1:] == [2, 2, 2, 1, 1, 1, 0]
# [sccs[i] for i in order] == [[1,2,3], [4,5,6], [7]]
```

> ★★★ **핵심**: **SCC 압축은 "사이클이 있는 방향 그래프 문제"를 "DAG 문제"로 바꾸는 표준 변환이다.** 플래티넘 구간에서 이 패턴이 계속 나온다.
> - **모든 정점에 도달하려면 최소 몇 곳에서 출발해야 하나** → 압축 DAG에서 진입차수 0인 SCC 개수
> - **간선을 더해 전체를 하나의 SCC로 만들려면 몇 개 필요한가** → `max(진입차수 0 개수, 진출차수 0 개수)`
> - **사이클을 포함한 최장 경로** → 압축 후 DAG DP (SCC 내부는 무한/전부 포함으로 처리)
> - **지배 관계·도달 가능성** → 압축 후 위상 순서로 비트셋 전파

**중복 간선 제거(`set`)를 잊으면** 진입차수가 부풀어 위상 정렬이 망가진다. 원본에 `a→b`가 여러 개거나 서로 다른 정점 쌍이 같은 SCC 쌍을 잇는 경우가 흔하다.

---

## 5. 2-SAT ★★

`(x₁ ∨ ¬x₂) ∧ (¬x₁ ∨ x₃) ∧ ...` 처럼 **절마다 리터럴이 정확히 2개**인 논리식의 충족 가능성 판정이다. 일반 SAT은 NP-완전이지만 **2-SAT은 SCC로 `O(V+E)`에 풀린다.**

**핵심 변환**: `(a ∨ b)`는 `(¬a → b) ∧ (¬b → a)`와 동치다. 각 리터럴을 정점으로 두고 이 함의를 간선으로 그린 게 **함의 그래프(implication graph)**다. 정점은 변수당 2개(참 노드, 거짓 노드)라 총 `2n`개다.

> ★★ **핵심**: **`x`와 `¬x`가 같은 SCC에 있으면 충족 불가능하다.** 같은 SCC라는 건 `x → ¬x`와 `¬x → x`가 둘 다 성립한다는 뜻이고, `x`가 참이어도 거짓이어야 하고 거짓이어도 참이어야 하는 모순이기 때문이다. 그런 변수가 하나도 없으면 반드시 해가 존재한다.

**해 구성**: 타잔이 역위상 순서로 SCC를 뱉으므로, **SCC 번호가 작을수록 싱크에 가깝다.** 함의는 "앞이 참이면 뒤도 참"이므로 **싱크 쪽을 참으로** 두면 모순이 없다. 따라서 `comp[x] < comp[¬x]`이면 `x = 참`이다.

```python
def two_sat(nvar, clauses):
    N = 2 * nvar
    g = [[] for _ in range(N + 1)]
    def neg(v):                        # 참 노드 ↔ 거짓 노드
        return ((v - 1) ^ 1) + 1
    def node(lit):                     # +i는 x_i, -i는 ¬x_i
        return 2 * abs(lit) - 1 if lit > 0 else 2 * abs(lit)
    for a, b in clauses:               # (a ∨ b) ≡ (¬a → b) ∧ (¬b → a)
        na, nb = node(a), node(b)
        g[neg(na)].append(nb)
        g[neg(nb)].append(na)
    comps = tarjan_scc(N, g)
    cid = [0] * (N + 1)
    for i, group in enumerate(comps):  # 타잔 출력 = 역위상 순서
        for v in group:
            cid[v] = i
    value = [False] * (nvar + 1)
    for i in range(1, nvar + 1):
        t, f = 2 * i - 1, 2 * i
        if cid[t] == cid[f]:           # x와 ¬x가 같은 SCC → 모순
            return None
        value[i] = cid[t] < cid[f]     # 더 먼저 끝난(싱크에 가까운) 쪽이 참
    return value[1:]

two_sat(2, [(1, 2), (-1, 2), (-1, -2)])   # [False, True]
two_sat(1, [(1, 1), (-1, -1)])            # None (x이면서 ¬x — 모순)
```

간선을 **양방향 함의 두 개 다** 넣어야 한다는 걸 잊기 쉽다. `(¬a → b)`만 넣으면 그래프가 대칭이 아니게 되어 판정이 틀린다.

---

## 6. 이분 그래프 판별 ★★

**이분 그래프**는 정점을 두 그룹으로 나눠 **모든 간선이 그룹을 가로지르게** 만들 수 있는 그래프다. BFS로 두 색을 번갈아 칠하면 된다.

```python
from collections import deque

def is_bipartite(n, graph):
    color = [0] * (n + 1)              # 0 미방문 / 1, -1 두 색
    for s in range(1, n + 1):          # 비연결일 수 있으니 모든 정점에서 시도
        if color[s]:
            continue
        color[s] = 1
        q = deque([s])
        while q:
            v = q.popleft()
            for w in graph[v]:
                if color[w] == 0:
                    color[w] = -color[v]     # 이웃은 반대 색
                    q.append(w)
                elif color[w] == color[v]:   # 같은 색 이웃 = 홀수 길이 사이클
                    return False, None
    return True, color

g4 = [[], [2, 4], [1, 3], [2, 4], [1, 3]]    # 4-사이클 (짝수)
g5 = [[], [2, 3], [1, 3], [1, 2]]            # 삼각형 (홀수)
is_bipartite(4, g4)[0], is_bipartite(3, g5)[0]   # (True, False)
```

> **함정**: **바깥 `for` 루프를 빼먹으면 안 된다.** 그래프가 여러 덩어리면 한 정점에서 시작한 BFS는 그 덩어리만 칠하고, 다른 덩어리의 홀수 사이클을 놓친다.

**이분 그래프 ⟺ 홀수 길이 사이클이 없다.** 홀수 사이클을 두 색으로 칠하려 하면 반드시 한 바퀴 돌아와 같은 색끼리 만나게 된다. 이 동치가 판별의 근거다. 색칠은 `1/-1` 대신 `0/1`로 두고 `color[w] = color[v] ^ 1`을 써도 되지만, 그러면 미방문 표시를 `-1`로 따로 잡아야 한다.

---

## 7. 이분 매칭 (헝가리안) ★★

**매칭**은 서로 정점을 공유하지 않는 간선 집합이고, **최대 매칭**은 그 크기가 최대인 것이다. 이분 그래프에서는 증가 경로(augmenting path)를 반복해 찾는 쿤 알고리즘(헝가리안 방법)으로 `O(V·E)`에 구한다.

```python
def bipartite_matching(nl, nr, adj):
    matched = [0] * (nr + 1)           # 오른쪽 정점 → 짝지어진 왼쪽 정점 (0이면 빔)

    def dfs(u, visited):
        for v in adj[u]:
            if visited[v]:             # 이번 시도에서 이미 본 오른쪽 정점
                continue
            visited[v] = True
            # v가 비었거나, v의 현재 짝이 다른 자리로 비켜줄 수 있으면 뺏는다
            if matched[v] == 0 or dfs(matched[v], visited):
                matched[v] = u
                return True
        return False

    cnt = 0
    for u in range(1, nl + 1):
        if dfs(u, [False] * (nr + 1)):     # ★ 왼쪽 정점마다 visited를 새로 만든다
            cnt += 1
    return cnt, matched

adj = [[], [1, 2], [1], [2, 3], [3]]
bipartite_matching(4, 3, adj)[0]       # 3
bipartite_matching(3, 1, [[], [1], [1], [1]])[0]   # 1
```

> **함정**: `visited`는 **왼쪽 정점 하나를 시도할 때마다 새로 만든다.** 전체에서 공유하면 한 번 실패한 오른쪽 정점을 다시 시도하지 못해 매칭 크기가 실제보다 작게 나온다. 반대로 한 번의 `dfs` 안에서는 반드시 공유해야 무한 재귀를 막는다.

**핵심 아이디어**는 "**비켜달라고 부탁하기**"다. 원하는 자리 `v`가 이미 `matched[v]`에게 점유되어 있으면, 그 사람에게 다른 자리로 옮길 수 있는지 재귀로 물어본다. 옮길 수 있으면 자리를 넘겨받고, 결과적으로 매칭 크기가 1 늘어난다. 이 연쇄가 곧 증가 경로다.

### 쾨닉 정리 (König's theorem) ★★

> ★★ **핵심**: **이분 그래프에서 최대 매칭 크기 = 최소 정점 덮개 크기**다. 그리고 **최대 독립 집합 크기 = `V` − 최대 매칭**이다.

이 정리 덕에 겉보기에 매칭과 무관해 보이는 문제가 이분 매칭으로 환원된다.

| 문제 유형 | 환원 |
|-----------|------|
| 모든 간선을 덮는 **최소 정점 수** | 최대 매칭 |
| 서로 인접하지 않는 **최대 정점 수** (독립 집합) | `V` − 최대 매칭 |
| 격자에서 겹치지 않게 도미노 최대 배치 | 체스판 색칠 후 이분 매칭 |
| 작업/사람 배정, 시간표 짜기 | 그대로 이분 매칭 |

**격자 문제의 이분 그래프화**가 특히 자주 나온다. `(i+j) % 2`로 칸을 두 색으로 나누면 인접한 칸은 항상 색이 다르므로 자동으로 이분 그래프가 된다.

---

## 8. 최대 유량 개념 ★

이분 매칭은 사실 **최대 유량(max flow)의 특수한 경우**다. 소스에서 왼쪽 정점마다 용량 1, 오른쪽에서 싱크로 용량 1을 주면 최대 유량이 곧 최대 매칭이다.

| 용어 | 의미 |
|------|------|
| 용량 (capacity) | 간선에 흘릴 수 있는 최대량 |
| 유량 (flow) | 실제로 흐르는 양. 용량 이하 |
| **잔여 그래프** (residual) | 남은 용량 `c - f`와 **역방향 간선 `f`**로 이뤄진 그래프 |
| 증가 경로 | 잔여 그래프에서 소스→싱크 경로. 있으면 유량을 더 늘릴 수 있다 |
| 에드몬드-카프 | 증가 경로를 **BFS로(최단)** 찾는 방식. `O(V·E²)` |
| 디닉 | 레벨 그래프 + 블로킹 플로우. `O(V²·E)`, 이분 매칭엔 `O(E√V)` |

**역방향 간선이 유량 알고리즘의 핵심 발명이다.** 잘못 흘린 유량을 나중에 "취소"할 수 있게 해주므로 그리디하게 아무 경로나 잡아도 최적에 도달한다. 이분 매칭에서 "비켜달라고 부탁하기"가 바로 이 역방향 간선을 타고 가는 것이다.

> ★ **최대유량-최소컷 정리**: **최대 유량의 값 = 최소 컷의 용량.** 그래프를 소스 쪽과 싱크 쪽으로 나누는 절단선 중 가로지르는 용량 합이 최소인 것이 최대 유량과 정확히 같다. "네트워크를 끊는 최소 비용", "두 그룹으로 나누는 최소 손실" 같은 문제가 전부 여기로 환원된다.

---

## 9. 단절점과 단절선 ★

- **단절점 (articulation point / cut vertex)**: 제거하면 **연결 요소 개수가 늘어나는** 정점
- **단절선 (bridge / cut edge)**: 제거하면 연결 요소 개수가 늘어나는 간선

둘 다 **무방향 그래프**에서 정의되고, 타잔과 같은 DFS low-link 기법으로 `O(V+E)`에 구한다.

| 대상 | 판정 조건 (DFS 트리에서) |
|------|--------------------------|
| 단절선 `(v, w)` | `low[w] > idx[v]` — `w` 쪽에서 `v`를 건너뛰고 위로 올라갈 길이 **없음** |
| 단절점 `v` (루트 아님) | 어떤 자식 `w`에 대해 `low[w] >= idx[v]` |
| 단절점 `v` (DFS 루트) | **자식이 2개 이상**일 때 |

**부등호가 미묘하게 다르다.** 단절선은 `>`, 단절점은 `>=`인데, 자식이 `v`로 되돌아오는 것(등호)까지만 가능하면 `v`를 없앴을 때 그 자식이 떨어져 나가기 때문이다. **루트만 별도 규칙**인 이유는 루트에는 위로 올라갈 부모가 없어서다.

**무방향 그래프에서 low를 갱신할 때는 부모로 가는 간선 하나를 제외**해야 한다. 중복 간선이 있으면 부모 간선을 인덱스로 구분해야지 정점 번호로 구분하면 틀린다.

---

### 한 줄 요약
플래티넘 그래프의 두 축은 **SCC와 매칭**이다. **타잔은 `low[v] == idx[v]`로 SCC 뿌리를 찾고 역간선은 반드시 `idx`로 갱신**하며, 정점이 많으므로 **반복 구현이 안전**하다. **SCC로 압축하면 어떤 방향 그래프든 DAG가 되어** 위상 정렬·DAG DP를 얹을 수 있고, 그 응용이 **2-SAT(`x`와 `¬x`가 같은 SCC면 불가능)**이다. 매칭 쪽은 **"비켜달라 부탁하기" 재귀 하나에 왼쪽 정점마다 `visited`를 새로 만드는 것**이 전부이고, **쾨닉 정리(최대 매칭 = 최소 정점 덮개)**를 알면 덮개·독립 집합 문제까지 한 번에 환원된다.

### 참고 (공식 문서)
- sys.setrecursionlimit — https://docs.python.org/3/library/sys.html#sys.setrecursionlimit
- collections.deque — https://docs.python.org/3/library/collections.html#collections.deque
- set / frozenset (중복 제거용 자료형) — https://docs.python.org/3/library/stdtypes.html#set-types-set-frozenset
- graphlib.TopologicalSorter — https://docs.python.org/3/library/graphlib.html
- 비트 연산자 (XOR 등) — https://docs.python.org/3/library/stdtypes.html#bitwise-operations-on-integer-types
- 파이썬 자료구조별 시간 복잡도 — https://wiki.python.org/moin/TimeComplexity
