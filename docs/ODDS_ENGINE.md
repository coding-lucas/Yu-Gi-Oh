# Motor de odds (`packages/odds-engine`)

Biblioteca pura (sem I/O), determinística e testada. **Nenhuma IA generativa** participa das probabilidades.

## 1. Modelo de gols
log λ_mandante = μ + γ·[não neutro] + ataque_m − defesa_v ; log λ_visitante = μ + ataque_v − defesa_m

* Ajuste por máxima verossimilhança Poisson ponderada (`fitRatings`) com **Newton por blocos (Gauss–Seidel)**,
  identificação Σataque = Σdefesa = 0, **decaimento temporal** w = e^(−ξ·dias) (ξ=0,0019 ≈ meia-vida de 1 ano) e
  **ridge** (encolhimento para a média — protege amostras pequenas). A qualidade do adversário entra naturalmente:
  marcar contra defesa forte vale mais.
* **Dixon–Coles**: τ(x,y) corrige 0-0, 1-0, 0-1, 1-1; ρ estimado por verossimilhança de perfil (busca de seção áurea),
  limitado ao intervalo válido. Matriz de placares 0–10, renormalizada.

## 2. Ajustes de contexto (`adjustedLambdas`) — todos limitados
* Forma recente (últimos 6 jogos, gols vs. esperado, encolhimento n/(n+12), fator ∈ [0,88; 1,12]).
* Confronto direto (≥ 3 jogos, encolhimento n/(n+15), fator ∈ [0,92; 1,08]).
* Desfalques/escalações: perda de ataque/defesa ∈ [0,1] ⇒ até −25% / +25% de λ.

## 3. Mercados (`deriveMarkets`)
Todos derivados da **mesma** matriz: 1X2, dupla chance, empate anula, ambas marcam, total 0,5–5,5, placar exato
(0–4 × 0–4 + "outro" por resultado). Coerência garantida por construção (testada).

## 4. Preço (`priceMatch`)
* Margem por tipo de mercado (padrão 5–6%, placar exato 18%), método **power** (carrega mais margem em azarões) ou
  proporcional. Dupla chance precificada contra o complemento.
* Escada de preços com **arredondamento para baixo** (o preço publicado nunca excede o calculado); odd mínima 1,01,
  máximas configuráveis.
* **Mercado externo** (The Odds API): de-vig (power), desvio máximo vs. modelo; acima do limiar (12 p.p.) ⇒ suspensão
  `MODEL_MARKET_DIVERGENCE`; abaixo ⇒ blend (peso 35%) aplicado **recalibrando λ** (1X2 e O/U 2,5), mantendo todos
  os mercados coerentes.
* Suspensões automáticas: `INSUFFICIENT_DATA` (time fora do modelo ou < 8 jogos), `INCONSISTENT_DATA` (λ fora de
  [0,15; 4,5], vetor inválido), `LOW_CONFIDENCE` (placar exato com < 20 jogos por time; seleção > 97%).

## 5. Validação
`walkForwardBacktest`: reajuste periódico usando apenas jogos anteriores (sem vazamento), Brier multiclasse, log loss,
RPS, diagrama de calibração/ECE (1X2 e O/U 2,5) e linha de base de frequências históricas.

Testes: recuperação de parâmetros em liga simulada (correlação > 0,85), modelo bate a linha de base, ECE < 0,05,
propriedades de margem e escada, suspensões e calibração de λ.
