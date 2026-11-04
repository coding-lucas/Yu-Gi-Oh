# Guia de deploy

## Componentes
| Componente | Onde | Comando |
| --- | --- | --- |
| Web (Next.js) | **Vercel** (root `apps/web`) ou container `infra/docker/web.Dockerfile` | `next build` / `next start` |
| API | container (`infra/docker/api.Dockerfile`) em ECS/Fly/Render/K8s | `node dist/main.js` (aplica migrations no boot; `MIGRATE_ON_START=false` para desligar) |
| Worker(s) | mesma imagem | `node dist/worker.js` (requer `REDIS_URL`) |
| PostgreSQL 16 | gerenciado (RDS/Cloud SQL/Neon) com PITR | — |
| Redis 7 | gerenciado (ElastiCache/Upstash) | — |

## Vercel (web)
1. Importar o repositório, *Root Directory* = `apps/web`, *Install Command* = `pnpm install --frozen-lockfile`
   (na raiz), *Build Command* = `pnpm --filter @athosbet/shared build && pnpm --filter @athosbet/web build`.
2. Variáveis: `API_URL=https://api.seu-dominio` (destino do rewrite `/api/*`), `NEXT_PUBLIC_WS_URL=https://api.seu-dominio`.
3. Na API: `TRUST_GEO_HEADER=true` **somente** se as requisições chegarem via Vercel/Cloudflare
   (`x-vercel-ip-country` / `cf-ipcountry`); caso contrário integrar um provedor de geolocalização.

## API / workers
```bash
docker build -f infra/docker/api.Dockerfile -t athosbet-api .
docker run -e NODE_ENV=production -e DATABASE_URL=… -e REDIS_URL=… \
  -e JWT_SECRET=$(openssl rand -hex 48) -e DATA_ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e CORS_ORIGIN=https://seu-dominio -e COOKIE_SECURE=true -e WORKER_INLINE=false \
  -e SPORTS_PROVIDER=api-football -e API_FOOTBALL_KEY=… -p 4000:4000 athosbet-api
docker run … athosbet-api node dist/worker.js
```
* Múltiplas réplicas da API: OK (sem estado). Para Socket.IO com várias réplicas habilite *sticky sessions* e o
  adaptador Redis (pendente).
* Health check: `GET /api/health`; métricas: `GET /api/metrics` com `METRICS_TOKEN`.
* `REAL_MONEY_ENABLED` deve permanecer `false` (ver COMPLIANCE.md).

## Banco
* Migrations SQL versionadas em `apps/api/migrations` (checksum; uma migration aplicada nunca pode ser editada — crie
  uma nova). Executar manualmente: `node dist/db/migrate.js`.
* Backups com PITR; o razão é append-only, portanto restaurações devem ser seguidas de `GET /api/admin/ledger/reconcile`.
* **Nunca** execute `dist/db/seed.js` em produção (ele recusa `NODE_ENV=production`).

## Primeira execução com dados reais
1. Configurar `SPORTS_PROVIDER=api-football` e `API_FOOTBALL_KEY`.
2. `POST /api/admin/jobs/history` → `POST /api/admin/jobs/sync` → `POST /api/admin/jobs/coverage`.
3. Revisar `coverage_status` por competição no painel; desabilitar apostas (`bettingEnabled=false`) onde a cobertura não
   for adequada.
4. `POST /api/admin/models/backtest` e revisar Brier/log loss/calibração antes de abrir mercados.

## CI
`.github/workflows/ci.yml`: install → build dos pacotes → typecheck → testes (PostgreSQL/Redis como services) →
build do web → build das imagens Docker.
