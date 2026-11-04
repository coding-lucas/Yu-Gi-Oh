# API

Base: `/api`. Documentação interativa OpenAPI/Swagger em **`/api/docs`**.
Autenticação: cookie `ab_at` (web) ou `Authorization: Bearer <accessToken>` (clientes). Mutações com cookie exigem
`x-athos-csrf: 1`. Erros: `{ "code": "ODDS_CHANGED", "details": … }`. Valores monetários são strings em centavos.

## Públicos
| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/health` | saúde (latência do banco) |
| GET | `/metrics` | Prometheus (Bearer `METRICS_TOKEN` se definido) |
| GET | `/meta` | provedor de dados, flag sintética, regras de mercado |
| GET | `/competitions` | competições ativas |
| GET | `/matches?filter=today\|tomorrow\|week\|live\|date&date=YYYY-MM-DD&tz=IANA&competition=slug&team=uuid&favorites=1` | partidas agrupadas por competição (Brasil primeiro) com 1X2 |
| GET | `/matches/featured` | destaques |
| GET | `/matches/:id` | partida, todos os mercados, λ do modelo, forma |
| GET | `/markets/:id/history` | histórico de versões de odds |
| POST | `/auth/register` · `/auth/login` · `/auth/refresh` · `/auth/logout` | sessão |
| POST | `/auth/password/forgot` · `/auth/password/reset` | recuperação |
| POST | `/payments/webhooks/:provider` | webhooks (`paysafe`: HMAC base64 no cabeçalho `signature`; `sandbox`: `x-sandbox-signature`) |

## Jogador (autenticado)
| Método | Rota | Descrição |
| --- | --- | --- |
| GET | `/auth/me` | perfil (+ `sessionMfa`) |
| POST | `/auth/mfa/setup` · `/auth/mfa/enable` | MFA |
| GET | `/wallet` · `/wallet/statement` | saldo e extrato (razão) |
| GET | `/payments/methods` · `/payments` | métodos disponíveis no território, histórico |
| POST | `/payments/deposits` | `{ amount, method, idempotencyKey, paymentToken?, returnUrl? }` → `payment` + `nextAction` (REDIRECT / TOKENIZE_CARD / DISPLAY_INSTRUCTIONS) |
| POST | `/payments/:id/confirm` | `{ paymentToken }` — token Paysafe.js para depósito com cartão |
| POST | `/payments/withdrawals` | `{ amount, method, idempotencyKey, payoutDetails?, paymentToken? }` |
| POST | `/payments/:id/simulate` | sandbox: confirma pagamento assíncrono |
| POST | `/bets` | `{ legs:[{oddsId, odds}], stake, idempotencyKey, oddsPolicy }` → 201 / 409 `ODDS_CHANGED` / 422 |
| GET | `/bets?status=OPEN\|SETTLED` · `/bets/:id` | apostas |
| GET/POST | `/favorites` · `/favorites/:kind/:id` | favoritos (TEAM/COMPETITION) |
| PATCH | `/account/profile` | idioma, fuso, nome |
| GET/PATCH | `/account/limits` | limites de jogo responsável |
| GET/POST | `/account/exclusion` | pausa / autoexclusão |
| GET | `/account/jurisdiction` | status territorial |

## Administração (`SUPPORT`/`RISK`/`ADMIN` + sessão MFA)
`GET /admin/dashboard`, `/admin/exposure`, `/admin/users`, `PATCH /admin/users/:id`, `/admin/matches`, `/admin/matches/:id`,
`POST /admin/markets/:id/suspend`, `POST /admin/matches/:id/suspend`, `PATCH /admin/matches/:id`,
`POST /admin/sandbox/matches/:id/result`, `/admin/bets`, `/admin/bets/:id` (com liquidações e lançamentos),
`/admin/payments`, `POST /admin/payments/:id/approve|reject`, `/admin/ledger/reconcile`, `/admin/ledger/transactions`,
`/admin/settings`, `PATCH /admin/settings/pricing|risk`, `/admin/competitions`, `PATCH /admin/competitions/:id`,
`/admin/jurisdictions`, `PATCH /admin/jurisdictions/:country`, `/admin/suspicious`, `PATCH /admin/suspicious/:id`,
`/admin/audit`, `/admin/sync-runs`, `/admin/models`, `POST /admin/models/backtest`,
`POST /admin/jobs/sync|history|coverage|price|external-odds|close|settle`,
`GET /admin/payments/providers`, `GET /admin/payments/eligibility`, `PATCH /admin/payments/eligibility/:id`,
`POST /admin/payments/:id/refund`, `POST /admin/payments/reconcile/:provider`, `GET /admin/payments/reconciliation-runs`,
`POST /admin/payments/sync`, `GET /admin/teams`, `PATCH /admin/teams/:id` (escudo licenciado / cores).

## WebSocket (`/api/ws`, Socket.IO)
Cliente → `watch(matchId)`, `unwatch(matchId)`. Servidor → `odds {matchId, markets}`, `board {matchId}`,
`match {matchId, status}`, `wallet {}`, `bet {betId, status}`.
