# Arquitetura

## Visão geral

```
            ┌──────────── Vercel / Node ────────────┐
 Browser ──▶│ Next.js (apps/web)  /api/* rewrite ───┼──▶ NestJS API (apps/api) ──▶ PostgreSQL
  PWA       │ next-intl · TanStack Query · zustand  │        │  REST + Socket.IO        (ledger, bets, odds…)
            └───────────────────────────────────────┘        │
                       ▲  WebSocket (/api/ws)                ├──▶ Redis / BullMQ ◀── worker(s) (dist/worker.js)
                       └─────────────────────────────────────┘
                                                             ├──▶ API-Football v3 (fixtures, results, injuries)
                                                             └──▶ The Odds API (comparação de preços)
```

* **Monorepo pnpm**: `packages/shared` (regras puras), `packages/odds-engine` (estatística pura), `apps/api`, `apps/web`.
  As regras de liquidação e de bilhete são as **mesmas** no servidor e no cliente.
* **Mesma origem**: o web faz *rewrite* de `/api/*` para a API; os cookies httpOnly ficam first-party.

## Módulos da API (`apps/api/src`)

| Módulo | Responsabilidade |
| --- | --- |
| `auth` | cadastro (18+, território), login, rotação de refresh token com detecção de reuso, recuperação de senha, MFA TOTP |
| `ledger` | razão de partidas dobradas; idempotência; reversões; conciliação |
| `wallet`, `payments` | carteira sandbox, gateway sandbox (PIX/cartão/boleto/transferência/BTC simulados), webhooks assinados e deduplicados, saques com revisão |
| `compliance` | jurisdições, limites de jogo responsável (com período de resfriamento), autoexclusão, heurísticas AML |
| `sports` | catálogo de competições, provedores (API-Football, demo), sincronização idempotente com deduplicação, fusos horários |
| `odds` | ajuste do modelo, precificação, versionamento de odds, comparação externa, fechamento no início do jogo |
| `bets` | aceitação atômica da aposta, controle de exposição |
| `settlement` | liquidação e reliquidação idempotentes por versão de resultado |
| `risk`, `admin` | KPIs, exposição, configuração, auditoria, ferramentas sandbox |
| `realtime` | Socket.IO: salas por partida (odds) e por usuário (carteira/apostas) |
| `jobs` | BullMQ (job schedulers + jobs de liquidação deduplicados por versão); fallback em processo sem Redis |

## Modelo de dados (resumo)

Fonte da verdade: `apps/api/migrations/0001_init.sql`. Principais entidades:

* `users`, `refresh_tokens`, `password_resets`
* `jurisdictions`, `rg_limits`, `self_exclusions`, `suspicious_activities`
* `ledger_accounts`, `ledger_transactions`, `ledger_entries` (append-only)
* `payments`, `payment_events`
* `competitions`, `teams`, `team_aliases`, `matches`, `match_external_ids`, `match_result_history`, `match_statistics`, `team_availability`, `favorites`
* `model_runs`, `probability_snapshots`, `external_odds`, `markets`, `odds` (versionadas)
* `bets`, `bet_selections`, `settlements`
* `settings`, `audit_logs` (append-only), `provider_sync_runs`

Temporadas são representadas por `matches.season` + `competitions.current_season`/`season_mode` (CALENDAR ou SPLIT).

### Integridade financeira

* Dinheiro é sempre `BIGINT` em centavos; odds são `INTEGER` em milésimos. Nenhum float toca dinheiro.
* Toda movimentação é uma `ledger_transaction` com ≥ 2 lançamentos cuja soma é **zero** — verificado na aplicação e
  por *constraint trigger* `DEFERRABLE INITIALLY DEFERRED` (no COMMIT). Uma transação não pode misturar moedas/modos.
* `ledger_entries`, `ledger_transactions` e `audit_logs` são **imutáveis** (triggers bloqueiam UPDATE/DELETE/TRUNCATE).
  Correções são transações reversas (`reverses_id`).
* `idempotency_key` único por transação: depósitos (`payment:{id}:complete`), apostas (`bet:{id}:place`),
  liquidações (`bet:{id}:settle:v{n}`), reversões (`bet:{id}:reverse:v{n}`).
* Contas são travadas (`SELECT … FOR UPDATE`) em ordem determinística; débitos do jogador exigem saldo ≥ 0.
* Conciliação (`GET /api/admin/ledger/reconcile`, job horário): saldo em cache = soma dos lançamentos; último
  `balance_after` = saldo; soma global por moeda/modo = 0.

Plano de contas (por moeda/modo): `USER_WALLET` (por jogador), `HOUSE_BETS_HELD` (stakes em custódia),
`HOUSE_PNL` (GGR), `PAYMENT_CLEARING` (contrapartida do PSP), `WITHDRAWALS_PENDING`.

| Evento | Lançamentos |
| --- | --- |
| Depósito | CLEARING −A · WALLET +A |
| Aposta | WALLET −S · HELD +S |
| Ganhou (P) | HELD −S · WALLET +P · PNL −(P−S) |
| Perdeu | HELD −S · PNL +S |
| Anulada | HELD −S · WALLET +S |
| Correção | reversão exata da liquidação anterior + nova liquidação `v{n+1}` |
| Saque | WALLET −A · PENDING +A → PENDING −A · CLEARING +A (ou reversão) |

## Fluxo de aposta

1. O cliente envia `legs[{oddsId, odds}]`, `stake`, `idempotencyKey`, `oddsPolicy (NONE|HIGHER|ANY)`.
2. Em uma única transação: gate de conformidade (território da requisição **e** da conta, idade, autoexclusão,
   modo), limites de jogo responsável, validação estrutural (`validateSlip`), `FOR SHARE` nos mercados
   (a republicação de odds espera), *advisory lock* por mercado (exposição serializada), comparação do preço
   exibido com o preço vigente, limites de stake/prêmio/exposição, débito no razão, criação da aposta.
3. Preço mudou e política não aceita → `409 ODDS_CHANGED` com os novos preços; o bilhete exibe "Aceitar novas odds".
4. Reenvio com a mesma chave devolve a mesma aposta (`idempotentReplay`).

## Calendário e sincronização

* Jobs: fixtures (10 min, janela −2/+8 dias), histórico (6 h), desfalques (1 h), odds externas (30 min),
  precificação (5 min), fechamento de mercados (1 min), liquidação (2 min + evento), dados obsoletos (15 min), conciliação (1 h).
* Ingestão idempotente; deduplicação por `(fonte, id externo)` → `(competição, mandante, visitante, dia ±1)` → inserção.
* Mudança de placar após encerramento ⇒ `result_version++` + histórico + evento de reliquidação.
* Adiamento: mercados suspensos; >48 h do horário original (ou remarcação >48 h) ⇒ seleções anuladas e mercados
  reabertos para a nova data.
* Falha de API: registrada em `provider_sync_runs` (status/HTTP), não interrompe outras competições, dados antigos
  preservados; partidas próximas sem atualização recente têm mercados suspensos (`DATA_STALE`).
* Horários sempre armazenados em UTC; agrupamento "hoje/amanhã/semana" calculado no fuso do usuário.

## Tempo real

Socket.IO em `/api/ws`. O cliente entra em `match:{id}` na página da partida (recebe `odds` com o quadro completo) e,
autenticado por cookie, em `user:{id}` (`wallet`, `bet`). Eventos `board`/`match` invalidam as listas.

## Escalabilidade e SLOs (alvo)

* API sem estado; múltiplas réplicas atrás de balanceador; workers BullMQ escaláveis horizontalmente.
* SLO alvo: p95 `GET /matches` < 400 ms e `POST /bets` < 600 ms com 50 VUs (`tests/load/bet-placement.k6.js`).
* Socket.IO com múltiplas réplicas requer o adaptador Redis (pendente — ver PROGRESS.md).

## Observabilidade

* `GET /api/health` (latência do banco), `GET /api/metrics` (Prometheus; proteja com `METRICS_TOKEN`).
* `provider_sync_runs` (erros das APIs), `model_runs` (métricas de backtest), `audit_logs`, `suspicious_activities`.
* Logs estruturados do Nest; erros internos nunca são devolvidos ao cliente (`AllExceptionsFilter`).

## Internacionalização

`next-intl` com prefixo de idioma (`/pt`, `/en`, `/es`, `/fr`, `/de`, `/it`, `/ar`, `/hi`, `/zh`, `/ja`, `/ko`),
detecção por `Accept-Language`/cookie, seletor manual persistido no perfil, `dir="rtl"` para árabe com classes
lógicas (`ms-*`, `pe-*`, `text-end`), `Intl` para moedas, números e datas. Adicionar idioma = incluir o código em
`packages/shared/src/locales.ts` e o arquivo `apps/web/messages/<código>.json` (o teste de i18n valida chaves e
placeholders).
