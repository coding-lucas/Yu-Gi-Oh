# AthosBet

Plataforma internacional de apostas esportivas com foco em **futebol**, construída como monorepo TypeScript.
Opera hoje **exclusivamente em sandbox** (saldo fictício `ATH`, sem conversão para dinheiro real).

> ⚠️ Apostas com dinheiro real estão desligadas por um *kill-switch* global (`REAL_MONEY_ENABLED=false`) e
> só podem ser ativadas após autorização jurídica e aprovação de provedores de pagamento em cada mercado.
> Ver [COMPLIANCE.md](COMPLIANCE.md).

## Visão rápida

| Camada | Tecnologia | Onde |
| --- | --- | --- |
| Web (mobile first, PWA, 11 idiomas, RTL) | Next.js 15, React 19, Tailwind, componentes estilo shadcn/ui, TanStack Query, next-intl, zustand | `apps/web` |
| API REST + WebSocket | NestJS 11, Drizzle ORM, PostgreSQL 16, Socket.IO, BullMQ/Redis | `apps/api` |
| Motor estatístico de odds | Poisson + Dixon–Coles, MLE, margens, backtesting | `packages/odds-engine` |
| Regras compartilhadas | catálogo de mercados, liquidação, validação de bilhete, conformidade, moeda | `packages/shared` |

Documentação: [ARCHITECTURE.md](ARCHITECTURE.md) · [SECURITY.md](SECURITY.md) · [COMPLIANCE.md](COMPLIANCE.md) ·
[PROGRESS.md](PROGRESS.md) · [docs/API.md](docs/API.md) · [docs/ODDS_ENGINE.md](docs/ODDS_ENGINE.md) · [docs/DEPLOY.md](docs/DEPLOY.md)

## Rodar localmente em 1 comando (porta 8000)

```bash
git clone -b claude/athosbet-sports-betting-v5ps8k https://github.com/coding-lucas/Yu-Gi-Oh athosbet
cd athosbet
./scripts/run-local.sh          # Windows: powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1
```

Requer Node 22+ e Docker. Abre o web em `http://localhost:8000/pt` (e no celular, no mesmo Wi-Fi,
`http://<IP-do-computador>:8000/pt`) e a API em `:4000`.

## Começando (desenvolvimento)

Pré-requisitos: Node 22, pnpm 10, PostgreSQL 16 e Redis 7 (ou Docker).

```bash
pnpm install
cp .env.example .env                      # ajuste DATABASE_URL / REDIS_URL
docker compose up -d postgres redis       # ou use instâncias locais
pnpm build:packages
pnpm --filter @athosbet/api build
pnpm db:migrate                           # aplica migrations/*.sql
pnpm db:seed                              # dados demo + usuários demo (~1 min)
pnpm dev:api                              # http://localhost:4000/api  (Swagger: /api/docs)
pnpm dev:web                              # http://localhost:3000
```

Usuários criados pelo seed:

| Perfil | E-mail | Senha | MFA |
| --- | --- | --- | --- |
| Jogador demo | `demo@athosbet.dev` | `DemoPlayer2026` | — |
| Administrador | `admin@athosbet.dev` | `AthosAdmin2026` | TOTP, segredo `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (adicione num app autenticador) |

Stack completa em containers: `docker compose up --build` e depois `docker compose run --rm api node dist/db/seed.js`.

### Dados esportivos

* `SPORTS_PROVIDER=demo` (padrão): provedor **sintético e determinístico** (calendário fixo, resultados simulados
  a partir de forças latentes). A interface exibe um aviso "Dados de demonstração".
* `SPORTS_PROVIDER=api-football` + `API_FOOTBALL_KEY`: integração real com API-Football v3. Nenhum campeonato é
  considerado integrado até a verificação de cobertura com dados reais (`POST /api/admin/jobs/coverage`) — ver PROGRESS.md.
* `ODDS_API_KEY` (opcional): comparação de preços via The Odds API.

## Testes

```bash
pnpm --filter @athosbet/shared test        # regras de liquidação, bilhete, conformidade, dinheiro
pnpm --filter @athosbet/odds-engine test   # Poisson/DC, ajuste, margens, backtest
pnpm --filter @athosbet/api test           # unit + integração (PostgreSQL real) + E2E do MVP
pnpm --filter @athosbet/web test           # i18n (11 idiomas), formatação
node apps/web/e2e/ui-flow.mjs              # E2E de interface (Playwright) com API+web rodando
k6 run tests/load/bet-placement.k6.js      # carga (requer k6)
```

Os testes de integração usam `TEST_DATABASE_URL` (padrão `postgres://postgres:postgres@localhost:5432/athosbet_test`)
e **recriam o schema** desse banco.

## Estrutura

```
apps/
  api/            NestJS (src/*, migrations/*.sql, test/{unit,integration,e2e})
  web/            Next.js App Router (src/app/[locale]/*, messages/*.json, public/ PWA, e2e/)
packages/
  odds-engine/    motor estatístico (sem dependências de runtime)
  shared/         regras de domínio compartilhadas entre API e web
infra/docker/     Dockerfiles
tests/load/       k6
```
