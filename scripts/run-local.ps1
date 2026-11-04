# AthosBet — Windows (PowerShell): web on http://localhost:8000, API on :4000. Requires Node 22+ and Docker Desktop.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$WebPort = 8000; $ApiPort = 4000
corepack enable
$lan = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
if (-not (Test-Path .env)) {
  $jwt = node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  $key = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  (Get-Content .env.example) `
    -replace '^DATABASE_URL=.*', 'DATABASE_URL=postgres://athos:athos@localhost:5432/athosbet' `
    -replace '^CORS_ORIGIN=.*', "CORS_ORIGIN=http://localhost:$WebPort,http://${lan}:$WebPort" `
    -replace '^PUBLIC_APP_URL=.*', "PUBLIC_APP_URL=http://localhost:$WebPort" `
    -replace '^NEXT_PUBLIC_WS_URL=.*', 'NEXT_PUBLIC_WS_URL=' `
    -replace '^JWT_SECRET=.*', "JWT_SECRET=$jwt" `
    -replace '^DATA_ENCRYPTION_KEY=.*', "DATA_ENCRYPTION_KEY=$key" | Set-Content .env
}
Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object { $k, $v = $_ -split '=', 2; [Environment]::SetEnvironmentVariable($k, $v) }
docker compose up -d postgres redis
do { Start-Sleep 1; docker compose exec -T postgres pg_isready -U athos -d athosbet *> $null } until ($LASTEXITCODE -eq 0)
pnpm install --frozen-lockfile
pnpm build:packages
pnpm --filter @athosbet/api build
pnpm --filter @athosbet/api db:migrate
$seeded = docker compose exec -T postgres psql -U athos -d athosbet -tAc "select 1 from users where email='demo@athosbet.dev'"
if ($seeded -notmatch '1') { pnpm --filter @athosbet/api db:seed }
$env:API_URL = "http://localhost:$ApiPort"
Push-Location apps/web; pnpm exec next build; Pop-Location
Start-Process -NoNewWindow node -ArgumentList '--enable-source-maps', 'dist/main.js' -WorkingDirectory apps/api
Write-Host "`nAthosBet: http://localhost:$WebPort/pt   Celular (mesmo Wi-Fi): http://${lan}:$WebPort/pt`n"
Push-Location apps/web; pnpm exec next start -p $WebPort -H 0.0.0.0; Pop-Location
