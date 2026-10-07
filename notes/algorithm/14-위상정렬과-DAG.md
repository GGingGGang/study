# 위상 정렬과 DAG (Topological Sort & DAG)

> 알고리즘 · 그래프 · 학습내용: DAG 개념과 위상 정렬 정의, 진입차수 기반 Kahn 알고리즘, DFS 후위 순서 역순 위상정렬, 정렬 길이로 사이클 판별, 결과가 여러 개일 때 사전순 최소(heapq), DAG 위의 DP(최장 경로·경로 개수), 선수과목·작업 순서 패턴, 임계경로

---

## 1. DAG와 위상 정렬 ★★

**DAG (Directed Acyclic Graph)**는 **방향이 있고 사이클이 없는** 그래프다. **위상 정렬(topological sort)**은 모든 간선 `a → b`에 대해 **`a`가 `b`보다 앞에 오도록** 정점을 일렬로 세우는 것이다.

| 성질 | 내용 |
|------|------|
| 존재 조건 | **DAG일 때만** 위상 정렬이 존재한다 |
| 유일성 | 유일하지 않다. 여러 개일 수 있고 하나도 없을 수도 있다 |
| 사이클과의 관계 | 사이클이 있으면 "누가 먼저"를 정할 수 없어 정렬 불가 |
| 복잡도 | `O(V + E)` |

**현실 대응**: 선수과목 이수 순서, 빌드 의존성, 작업 스케줄링, 게임 아이템 제작 트리, 스프레드시트 셀 재계산 순서. 전부 "A가 끝나야 B를 할 수 있다"는 구조라 그대로 DAG가 된다.

**트리도 DAG의 특수한 경우**다(루트에서 자식 방향으로 방향을 주면). 그래서 트리 DP와 DAG DP는 사고 방식이 같다.

---

## 2. Kahn 알고리즘 — 진입차수 + BFS ★★★

```python
from collections import deque

n = 6
edges = [(1,2),(1,3),(2,4),(3,4),(4,5),(3,6),(6,5)]
graph = [[] for _ in range(n + 1)]
indeg = [0] * (n + 1)                      # 진입차수 = 나를 가리키는 간선 수
for a, b in edges:
    graph[a].append(b)
    indeg[b] += 1

def topo_kahn(n, graph, indeg):
    indeg = indeg[:]                       # ★ 원본 보존 (여러 번 호출할 때 필수)
    q = deque(v for v in range(1, n + 1) if indeg[v] == 0)   # 선행 없는 것부터
    order = []
    while q:
        v = q.popleft()
        order.append(v)
        for nxt in graph[v]:
            indeg[nxt] -= 1                # 선행 작업 하나가 끝났다
            if indeg[nxt] == 0:            # 선행이 전부 끝난 순간 큐에 넣는다
                q.append(nxt)
    return order

topo_kahn(n, graph, indeg)                 # [1, 2, 3, 4, 6, 5]
```

> ★★★ **핵심**: **"진입차수 0 = 지금 당장 할 수 있는 일"**이다. 하나 처리할 때마다 그 정점이 가리키던 것들의 진입차수를 1씩 깎고, **0이 되는 순간이 곧 "선행 조건을 전부 만족한 순간"**이라 큐에 넣는다. 이 한 문장이 Kahn 알고리즘 전부다.

> **함정**: `indeg`를 복사하지 않고 쓰면 **함수가 진입차수 배열을 0으로 다 깎아버린다.** 같은 그래프로 위상 정렬을 두 번 부르면 두 번째는 빈 리스트가 나온다. `indeg[:]`로 복사하는 습관을 들인다.

`indeg[nxt] -= 1`을 하고 나서 **`if indeg[nxt] == 0`으로 정확히 0일 때만** 넣어야 한다. `<= 0`으로 쓰면 이론상 같지만, 로직 버그로 음수가 될 때 중복 삽입을 잡아주지 못한다.

---

## 3. 사이클 존재 판별 ★★★

```python
def topo_or_cycle(n, graph, indeg):
    order = topo_kahn(n, graph, indeg)
    if len(order) < n:                     # 못 담은 정점이 있으면 사이클
        return None
    return order

cg = [[], [2], [3], [1]]                   # 1→2→3→1 사이클
cin = [0, 1, 1, 1]
topo_or_cycle(3, cg, cin)                  # None
topo_or_cycle(n, graph, indeg) is not None # True
```

> ★★★ **핵심**: **위상 정렬 결과의 길이가 `N`보다 작으면 사이클이 있다.** 사이클 안의 정점들은 서로가 서로의 선행이라 진입차수가 영원히 0이 되지 못하고, 큐에 한 번도 들어가지 못한 채 남는다. **방향 그래프 사이클 판별의 가장 간단한 방법**이 바로 이것이다.

무방향 그래프의 사이클 판별은 유니온 파인드나 DFS로 하지만(위상 정렬 자체가 정의되지 않는다), **방향 그래프면 위상 정렬 길이 비교가 제일 짧다.** "불가능하면 -1을 출력하라" 같은 문제 문장이 나오면 이 검사를 잊지 않는다.

---

## 4. DFS 기반 위상 정렬 (후위 역순) ★★

```python
def topo_dfs(n, graph):
    state = [0] * (n + 1)                  # 0 미방문 / 1 방문 중 / 2 완료
    order = []
    for s in range(1, n + 1):
        if state[s]:
            continue
        stack = [(s, 0)]                   # (정점, 다음에 볼 이웃 인덱스)
        state[s] = 1
        while stack:
            v, i = stack.pop()
            if i < len(graph[v]):
                stack.append((v, i + 1))   # 다음 이웃부터 볼 수 있게 되돌려 넣는다
                nxt = graph[v][i]
                if state[nxt] == 1:        # 방문 "중"인 정점으로 되돌아감
                    return None            # → 역방향 간선 = 사이클
                if state[nxt] == 0:
                    state[nxt] = 1
                    stack.append((nxt, 0))
            else:
                state[v] = 2               # 자식을 전부 끝냄
                order.append(v)            # 후위 순서로 담는다
    return order[::-1]                     # ★ 후위 순서를 뒤집으면 위상 순서

topo_dfs(n, graph)                         # [1, 3, 6, 2, 4, 5]
topo_dfs(3, cg)                            # None (사이클)
```

**왜 후위 역순인가**: DFS에서 정점 `v`가 "완료"되는 시점은 `v`에서 갈 수 있는 모든 정점이 이미 완료된 뒤다. 즉 **`v`는 자기 후손들보다 늦게 완료된다.** 완료 순서를 뒤집으면 `v`가 후손보다 앞에 오게 되고, 그게 정확히 위상 순서다.

**세 가지 상태(0/1/2)가 사이클 판별의 핵심**이다. 상태 `1`(방문 중, 아직 스택에 있음)인 정점으로 향하는 간선은 자기 조상으로 돌아가는 간선이므로 사이클이다. 상태 `2`(완료)로 향하는 간선은 그냥 이미 처리된 곳이라 문제없다. **`visited` 불리언 하나만 쓰면 이 둘을 구분하지 못해 사이클을 잘못 판정한다.**

| | Kahn (BFS) | DFS 후위 역순 |
|---|---|---|
| 구현 난이도 | 쉬움 | 반복 구현은 까다로움 |
| 사이클 판별 | 길이 < N | 상태 1로 향하는 간선 발견 |
| 사전순 제어 | **쉬움** (힙으로 교체) | 어려움 |
| 재귀 깊이 | 없음 (안전) | 재귀로 짜면 위험 |
| SCC와의 관계 | — | **코사라주·타잔의 기반** |

**실전 위상 정렬은 Kahn이 기본**이다. DFS 방식은 SCC 알고리즘의 토대가 되므로 원리를 이해해두는 쪽이 중요하다.

---

## 5. 결과가 여러 개 — 사전순 최소 ★★

위상 정렬 결과는 대개 여러 개다. 위 예시만 해도 `[1,2,3,4,6,5]`와 `[1,3,6,2,4,5]` 둘 다 유효하다. 문제가 **"가능한 답이 여러 개면 사전순으로 가장 앞선 것"**을 요구하면 큐를 힙으로 바꾼다.

```python
import heapq

def topo_lexi(n, graph, indeg):
    indeg = indeg[:]
    pq = [v for v in range(1, n + 1) if indeg[v] == 0]
    heapq.heapify(pq)                      # ★ deque 대신 최소 힙
    order = []
    while pq:
        v = heapq.heappop(pq)              # 지금 가능한 것 중 가장 작은 번호
        order.append(v)
        for nxt in graph[v]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                heapq.heappush(pq, nxt)
    return order if len(order) == n else None

topo_lexi(n, graph, indeg)                 # [1, 2, 3, 4, 6, 5]
```

**바뀐 건 `deque` → `heapq` 뿐**이고 복잡도는 `O(V log V + E)`가 된다. "매 순간 선택 가능한 것 중 가장 작은 걸 고른다"는 그리디가 사전순 최소를 보장한다.

> **함정**: 사전순 **최대**를 원하면 값에 음수를 씌워 넣는다(`heapq`는 최소 힙만 있다). `heapq.heappush(pq, -v)` 후 꺼낼 때 `-heapq.heappop(pq)`.

---

## 6. DAG 위의 DP ★★★

> ★★★ **핵심**: **위상 순서대로 순회하면, 어떤 정점을 처리하는 시점에 그 정점으로 들어오는 모든 선행 정점이 이미 확정되어 있다.** 이게 DAG DP의 전부다. 사이클이 없으니 "무엇부터 계산할지"를 위상 정렬이 정해주고, 그 순서대로 한 번만 훑으면 `O(V + E)`에 끝난다. 일반 그래프에서는 최장 경로가 NP-난해지만 **DAG에서는 선형 시간**인 이유다.

### 최장 경로

```python
wgraph = [[] for _ in range(n + 1)]
wind = [0] * (n + 1)
for a, b, w in [(1,2,3),(1,3,2),(2,4,4),(3,4,1),(4,5,2),(3,6,7),(6,5,1)]:
    wgraph[a].append((b, w))
    wind[b] += 1

def longest_path(n, wgraph, wind, start):
    plain = [[b for b, _ in wgraph[v]] for v in range(n + 1)]
    order = topo_kahn(n, plain, wind)
    NEG = float('-inf')
    dp = [NEG] * (n + 1)
    dp[start] = 0
    for v in order:                        # 위상 순서대로 딱 한 번씩
        if dp[v] == NEG:                   # start에서 도달 불가한 정점은 건너뛴다
            continue
        for nxt, w in wgraph[v]:
            dp[nxt] = max(dp[nxt], dp[v] + w)   # 나가는 간선으로 밀어준다
    return dp

longest_path(n, wgraph, wind, 1)[1:]       # [0, 3, 2, 7, 10, 9]
```

### 경로 개수 세기

```python
def count_paths(n, graph, indeg, start, goal):
    order = topo_kahn(n, graph, indeg)
    cnt = [0] * (n + 1)
    cnt[start] = 1                         # 시작점에 도달하는 방법은 1가지
    for v in order:
        if cnt[v] == 0:
            continue
        for nxt in graph[v]:
            cnt[nxt] += cnt[v]             # max 대신 덧셈이면 개수가 된다
    return cnt[goal]

count_paths(n, graph, indeg, 1, 5)         # 3  (1-2-4-5, 1-3-4-5, 1-3-6-5)
```

**최장 경로와 경로 개수는 골격이 완전히 같고 `max` 자리가 `+`로 바뀔 뿐이다.** 최단 경로면 `min`, 개수를 큰 수로 세야 하면 파이썬 정수는 무제한이라 그대로 두거나 문제가 요구하는 모듈러를 씌운다.

**밀어주기(push) vs 끌어오기(pull)**: 위 코드는 `v`에서 나가는 간선으로 값을 미는 방식이다. 역방향 그래프를 만들어 "들어오는 간선에서 끌어오는" 방식으로 써도 같다. 나가는 간선만 있는 인접 리스트를 그대로 쓸 수 있어 미는 쪽이 보통 간편하다.

---

## 7. 선수과목·작업 순서 패턴 ★★

| 문제 문장 | 모델링 |
|-----------|--------|
| "A를 들어야 B를 들을 수 있다" | 간선 `A → B` |
| "모든 과목을 들을 수 있는가" | 위상 정렬 길이 == N (사이클 없음) |
| "각 과목을 들을 수 있는 가장 이른 학기" | DAG DP: `dp[b] = max(dp[a] + 1)` |
| "최소 몇 학기가 필요한가" | 위 `dp`의 최댓값 |
| "가능한 순서 중 사전순 최소" | Kahn + heapq |
| "순서가 유일하게 정해지는가" | 매 단계 큐 크기가 항상 1인지 확인 |

**"순서가 유일한가"** 판정이 은근히 자주 나온다. Kahn을 돌리면서 **큐에 원소가 2개 이상인 순간이 한 번이라도 있으면** 그 시점에서 선택지가 갈리므로 순서가 유일하지 않다. 큐가 도중에 비면 사이클이다.

```python
def topo_unique(n, graph, indeg):
    indeg = indeg[:]
    q = deque(v for v in range(1, n + 1) if indeg[v] == 0)
    order, unique = [], True
    while q:
        if len(q) > 1:
            unique = False      # 동시에 고를 수 있는 게 둘 이상 = 순서가 여러 개
        v = q.popleft()
        order.append(v)
        for nxt in graph[v]:
            indeg[nxt] -= 1
            if indeg[nxt] == 0:
                q.append(nxt)
    if len(order) < n:
        return None, False      # 사이클
    return order, unique

topo_unique(n, graph, indeg)    # ([1, 2, 3, 4, 6, 5], False) — 순서가 여러 개
```

---

## 8. 임계경로 (Critical Path) ★★

각 작업에 **소요 시간**이 붙고 선행 관계가 DAG일 때, **전체를 끝내는 데 걸리는 최소 시간**은 가장 긴 경로(임계경로)의 길이다. 병렬로 할 수 있는 작업은 동시에 하므로, 결국 **가장 오래 걸리는 사슬**이 전체 시간을 결정한다.

```python
dur = [0, 3, 2, 4, 1, 5, 2]                # dur[v] = 작업 v의 소요 시간 (1-indexed)

def critical_path(n, graph, indeg, dur):
    order = topo_kahn(n, graph, indeg)
    finish = [0] * (n + 1)                 # finish[v] = v가 끝나는 가장 이른 시각
    for v in order:
        finish[v] += dur[v]                # 선행이 다 끝난 시각 + 내 소요 시간
        for nxt in graph[v]:
            finish[nxt] = max(finish[nxt], finish[v])   # 후행의 시작 가능 시각
    return max(finish[1:]), finish

critical_path(n, graph, indeg, dur)
# (14, [3, 5, 7, 8, 14, 9])
```

**`finish[nxt]`는 처리 전에는 "시작 가능 시각"**(선행 중 가장 늦게 끝나는 시각)이고, 자기 차례가 오면 `+= dur[v]`로 "종료 시각"이 된다. 위상 순서 덕분에 `v`를 처리하는 시점에 모든 선행이 이미 반영되어 있다.

임계경로 위의 작업은 **여유 시간(slack)이 0**이라 하나라도 늦어지면 전체가 늦어진다. 반대로 임계경로 밖 작업은 늦어도 되는 여유가 있다. "어느 작업을 단축해야 전체가 빨라지나"를 묻는 문제는 곧 임계경로를 찾으라는 뜻이다.

---

### 한 줄 요약
위상 정렬은 **"진입차수 0인 것부터 꺼내고, 꺼낼 때마다 후행의 진입차수를 깎는다"**는 Kahn 알고리즘 한 줄로 요약되고, **결과 길이가 `N`보다 작으면 사이클**이라는 게 방향 그래프 사이클 판별의 표준이다. 사전순 최소가 필요하면 **`deque`를 `heapq`로 바꾸기만** 하면 되고, 무엇보다 **위상 순서대로 훑으면 선행이 항상 확정되어 있다는 성질** 덕에 **일반 그래프에서 NP-난해인 최장 경로가 DAG에서는 `O(V+E)`**로 풀린다.

### 참고 (공식 문서)
- collections.deque — https://docs.python.org/3/library/collections.html#collections.deque
- heapq — 힙 큐 알고리즘 — https://docs.python.org/3/library/heapq.html
- graphlib.TopologicalSorter (표준 라이브러리 위상 정렬) — https://docs.python.org/3/library/graphlib.html
- 리스트 슬라이싱과 복사 — https://docs.python.org/3/tutorial/introduction.html#lists
- 파이썬 자료구조별 시간 복잡도 — https://wiki.python.org/moin/TimeComplexity
