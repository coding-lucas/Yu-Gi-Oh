#!/usr/bin/env bash
# AthosBet — run the full MVP locally: web on http://localhost:8000, API on :4000.
# Requirements: Node 22+, Docker (for PostgreSQL + Redis). pnpm is enabled via corepack.
set -euo pipefail
cd "$(dirname "$0")/.."
WEB_PORT="${WEB_PORT:-8000}"
API_PORT="${API_PORT:-4000}"

command -v node >/dev/null || { echo "Node.js 22+ is required: https://nodejs.org"; exit 1; }
command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/"; exit 1; }
corepack enable >/dev/null 2>&1 || npm i -g pnpm@10
LAN_IP="$( (ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') || true)"

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i.bak \
    -e "s#^DATABASE_URL=.*#DATABASE_URL=postgres://athos:athos@localhost:5432/athosbet#" \
    -e "s#^CORS_ORIGIN=.*#CORS_ORIGIN=http://localhost:${WEB_PORT}${LAN_IP:+,http://${LAN_IP}:${WEB_PORT}}#" \
    -e "s#^PUBLIC_APP_URL=.*#PUBLIC_APP_URL=http://localhost:${WEB_PORT}#" \
    -e "s#^API_URL=.*#API_URL=http://localhost:${API_PORT}#" \
    -e "s#^NEXT_PUBLIC_WS_URL=.*#NEXT_PUBLIC_WS_URL=#" \
    -e "s#^PORT=.*#PORT=${API_PORT}#" \
    -e "s#^JWT_SECRET=.*#JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")#" \
    -e "s#^DATA_ENCRYPTION_KEY=.*#DATA_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")#" \
    .env && rm -f .env.bak
  echo "→ .env created"
fi
set -a; . ./.env; set +a

echo "→ starting PostgreSQL and Redis (docker compose)"
docker compose up -d postgres redis
until docker compose exec -T postgres pg_isready -U athos -d athosbet >/dev/null 2>&1; do sleep 1; done

echo "→ installing dependencies"
pnpm install --frozen-lockfile
echo "→ building"
pnpm build:packages
pnpm --filter @athosbet/api build
echo "→ migrations"
pnpm --filter @athosbet/api db:migrate
if ! docker compose exec -T postgres psql -U athos -d athosbet -tAc "select 1 from users where email='demo@athosbet.dev'" | grep -q 1; then
  echo "→ seeding demo data (≈1 min)"
  pnpm --filter @athosbet/api db:seed
fi
(cd apps/web && API_URL="http://localhost:${API_PORT}" pnpm exec next build)

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM
(cd apps/api && node --enable-source-maps dist/main.js) &
(cd apps/web && API_URL="http://localhost:${API_PORT}" pnpm exec next start -p "${WEB_PORT}" -H 0.0.0.0) &
sleep 5
cat <<MSG

  AthosBet está no ar
  ▸ Computador:  http://localhost:${WEB_PORT}/pt
  ${LAN_IP:+▸ Celular (mesmo Wi-Fi):  http://${LAN_IP}:${WEB_PORT}/pt}
  ▸ API / Swagger: http://localhost:${API_PORT}/api/docs

  Jogador: demo@athosbet.dev / DemoPlayer2026
  Admin:   admin@athosbet.dev / AthosAdmin2026  (TOTP: JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP)
  Ctrl+C para parar.
MSG
wait
