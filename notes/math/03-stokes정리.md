# Stokes 정리 (Stokes' Theorem)

> 제10주 — 곡면 위의 **회전(curl)의 면적분**을 그 곡면의 **경계 곡선을 따라가는 선적분(순환, circulation)** 과 연결한다. 평면에서의 그린 정리를 3차원 공간으로 일반화한 것이다.

---

## 1. 곡면과 경계 곡선의 방향

유향 곡면 $S$ 의 경계 곡선을 $C = \partial S$ 라 하자. Stokes 정리가 성립하려면 둘의 방향이 **오른손 법칙**으로 맞물려야 한다.

> 오른손의 엄지를 곡면의 단위법선 $\mathbf{n}$ 방향으로 향하게 하면, 나머지 네 손가락이 감기는 방향이 경계 곡선 $C$ 의 **양의 방향**이다.

즉, 곡면을 $\mathbf{n}$ 쪽에서 내려다볼 때 경계는 **반시계 방향**으로 돈다.

---

## 2. Stokes 정리

**정리.** $S$ 가 조각마다 매끄러운 유향 곡면이고 그 경계가 조각마다 매끄러운 단순 닫힌 곡선 $C$ 이며, $\mathbf{F}$ 가 $S$ 를 포함하는 영역에서 연속인 1계 편도함수를 가지면

$$
\boxed{\;\iint_S (\nabla \times \mathbf{F}) \cdot \mathbf{n}\, dS = \oint_C \mathbf{F}\cdot d\mathbf{r}\;}
$$

좌변은 곡면 위 **회전의 플럭스**, 우변은 경계를 따라가는 $\mathbf{F}$ 의 **순환(circulation)** 이다. 성분으로 쓰면

$$
\iint_S \left[
\left(\frac{\partial F_3}{\partial y} - \frac{\partial F_2}{\partial z}\right) n_1
+\left(\frac{\partial F_1}{\partial z} - \frac{\partial F_3}{\partial x}\right) n_2
+\left(\frac{\partial F_2}{\partial x} - \frac{\partial F_1}{\partial y}\right) n_3
\right] dS
= \oint_C \big(F_1\, dx + F_2\, dy + F_3\, dz\big).
$$

**중요한 성질:** 우변은 경계 $C$ 에만 의존하므로, **경계가 같은 어떤 곡면을 잡아도** 좌변의 값은 같다. 계산이 편한 곡면(예: 평평한 원판)을 골라 쓰면 된다.

---

## 3. 그린 정리와의 관계

곡면 $S$ 가 $xy$-평면 위의 영역이고 $\mathbf{n} = \mathbf{k}$, $\mathbf{F} = (F_1, F_2, 0)$ 인 특수한 경우, Stokes 정리는 **그린 정리(Green's theorem)** 로 환원된다.

$$
\oint_C \big(F_1\, dx + F_2\, dy\big)
= \iint_S \left(\frac{\partial F_2}{\partial x} - \frac{\partial F_1}{\partial y}\right) dx\, dy.
$$

즉 그린 정리는 Stokes 정리의 **평면 버전**이다. 세 정리의 관계를 정리하면:

| 정리 | 좌변(낮은 차원) | 우변(높은 차원) |
|------|------|------|
| 그린 정리 | 평면 곡선 위 선적분 | 평면 영역 위 이중적분 |
| Stokes 정리 | 공간 곡선 위 선적분 | 곡면 위 면적분 |
| 발산정리 | 닫힌 곡면 위 면적분 | 입체 위 부피적분 |

이들은 모두 **"경계에서의 적분 = 내부에서의 미분의 적분"** 이라는 미적분의 기본정리의 일반화(일반화된 Stokes 정리)이다.

---

## 4. 물리적 의미

순환을 곡면 넓이로 나눈 극한을 취하면 회전의 정의가 나온다.

$$
(\nabla\times\mathbf{F})\cdot\mathbf{n} \;=\; \lim_{A\to 0}\frac{1}{A}\oint_C \mathbf{F}\cdot d\mathbf{r}.
$$

즉 **회전의 법선 성분**은 그 점 주위를 도는 **단위 넓이당 순환**이다. $\mathbf{F}$ 가 유체의 속도장이라면 순환은 경계를 따라 도는 흐름의 총량이고, 회전은 국소적인 소용돌이의 세기를 나타낸다. 전자기학의 **앙페르 법칙**, **패러데이 법칙**이 Stokes 정리의 대표적 응용이다.

$$
\oint_C \mathbf{E}\cdot d\mathbf{r} = -\frac{d}{dt}\iint_S \mathbf{B}\cdot d\mathbf{S}
\quad\Longleftrightarrow\quad
\nabla\times\mathbf{E} = -\frac{\partial \mathbf{B}}{\partial t}.
$$

---

## 5. 보존장과 경로 독립

Stokes 정리로부터 **보존장(conservative field)** 의 핵심 성질이 나온다. 영역이 단순 연결(simply connected)일 때 다음은 모두 **동치**이다.

$$
\nabla \times \mathbf{F} = \mathbf{0}
\;\;\Longleftrightarrow\;\;
\oint_C \mathbf{F}\cdot d\mathbf{r} = 0 \;(\text{모든 닫힌 } C)
\;\;\Longleftrightarrow\;\;
\mathbf{F} = \nabla f \;\;\text{(퍼텐셜 존재)}
$$

이때 선적분은 **경로에 무관**하며 끝점만으로 결정된다.

$$
\int_A^B \mathbf{F}\cdot d\mathbf{r} = f(B) - f(A).
$$

> 비회전($\nabla\times\mathbf{F}=\mathbf{0}$)이어도 영역에 구멍이 있으면(단순 연결이 아니면) 보존장이 아닐 수 있다. 대표적 반례가 $\mathbf{F} = \left(\dfrac{-y}{x^2+y^2},\, \dfrac{x}{x^2+y^2},\, 0\right)$ 이다.

---

## 6. 예제

### 예제 1 — 순환을 면적분으로

$\mathbf{F} = (-y,\, x,\, 0)$, $C$ 는 $xy$-평면 위 반지름 $a$ 인 원(반시계). 회전은 $\nabla\times\mathbf{F} = (0,0,2)$, 곡면을 원판 $S$ 로, $\mathbf{n}=\mathbf{k}$ 로 잡으면

$$
\oint_C \mathbf{F}\cdot d\mathbf{r}
= \iint_S (\nabla\times\mathbf{F})\cdot\mathbf{k}\, dS
= \iint_S 2\, dS = 2\cdot \pi a^2 = 2\pi a^2.
$$

직접 계산($x = a\cos t,\, y = a\sin t$)으로도 확인된다.

$$
\oint_C (-y\, dx + x\, dy) = \int_0^{2\pi}\!\big(a^2\sin^2 t + a^2\cos^2 t\big)\, dt = 2\pi a^2. \checkmark
$$

### 예제 2 — 곡면을 자유롭게 바꾸기

$\mathbf{F} = (z,\, x,\, y)$, $C$ 는 평면 $z = 0$ 위 반지름 $1$ 인 원. 회전은

$$
\nabla\times\mathbf{F} = (1, 1, 1).
$$

경계가 $xy$-평면 위에 있으므로 곡면을 평평한 원판($\mathbf{n} = \mathbf{k}$)으로 잡으면 $(\nabla\times\mathbf{F})\cdot\mathbf{k} = 1$ 이고

$$
\oint_C \mathbf{F}\cdot d\mathbf{r} = \iint_S 1\, dS = \pi (1)^2 = \pi.
$$

위로 볼록한 반구를 잡든 원판을 잡든 결과는 같다 — 경계가 같기 때문이다.

### 예제 3 — 비회전장 판정

$\mathbf{F} = (2xy,\; x^2 + z^2,\; 2yz)$ 의 회전을 구하면

$$
\nabla\times\mathbf{F} = (2z - 2z,\; 0 - 0,\; 2x - 2x) = (0,0,0).
$$

따라서 보존장이며 퍼텐셜 $f$ 는 $f_x = 2xy \Rightarrow f = x^2 y + g(y,z)$, 이어서 $f_y = x^2 + g_y = x^2 + z^2 \Rightarrow g_y = z^2 \Rightarrow g = y z^2 + h(z)$, 마지막으로 $f_z = 2yz + h'(z) = 2yz \Rightarrow h' = 0$. 결국

$$
f(x,y,z) = x^2 y + y z^2 + C.
$$

따라서 임의의 닫힌 경로에서 $\oint_C \mathbf{F}\cdot d\mathbf{r} = 0$.

---

## 핵심 요약

| 항목 | 내용 |
|------|------|
| Stokes 정리 | $\displaystyle\iint_S (\nabla\times\mathbf{F})\cdot\mathbf{n}\, dS = \oint_C \mathbf{F}\cdot d\mathbf{r}$ |
| 방향 규약 | 오른손 법칙 ($\mathbf{n}$ ↔ $C$의 진행 방향) |
| 그린 정리 | Stokes의 평면 특수경우 |
| 곡면 자유도 | 경계가 같으면 어떤 곡면을 잡아도 값 동일 |
| 보존장 동치조건 | $\nabla\times\mathbf{F}=\mathbf{0} \Leftrightarrow \oint=0 \Leftrightarrow \mathbf{F}=\nabla f$ (단순연결) |
