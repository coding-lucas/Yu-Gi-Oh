# AthosBet — instalador completo para Windows.
# Instala o que faltar (Git, Node 22, Docker Desktop via winget), clona o projeto e sobe o servidor local.
param([string]$Dir = (Join-Path ([Environment]::GetFolderPath("Desktop")) "athosbet"), [int]$WebPort = 8080)
$ErrorActionPreference = 'Stop'
function Need($cmd, $wingetId, $name) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "→ Instalando $name..." -ForegroundColor Cyan
    winget install --id $wingetId -e --accept-source-agreements --accept-package-agreements
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
  }
}
Need git 'Git.Git' 'Git'
Need node 'OpenJS.NodeJS.LTS' 'Node.js'
if ([int]((node -v).TrimStart('v').Split('.')[0]) -lt 22) { winget upgrade --id OpenJS.NodeJS.LTS -e; $env:Path += ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') }
Need docker 'Docker.DockerDesktop' 'Docker Desktop'

Write-Host "→ Aguardando o Docker Desktop iniciar..." -ForegroundColor Cyan
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 120; $i++) { Start-Sleep 2; docker info *> $null; if ($LASTEXITCODE -eq 0) { break } }
  if ($LASTEXITCODE -ne 0) { throw 'Docker nao iniciou. Abra o Docker Desktop manualmente (pode pedir reinicio do PC na primeira instalacao) e rode este comando de novo.' }
}

if (-not (Test-Path "$Dir\.git")) {
  Write-Host "→ Clonando o projeto em $Dir" -ForegroundColor Cyan
  git clone -b claude/athosbet-sports-betting-v5ps8k https://github.com/coding-lucas/Yu-Gi-Oh $Dir
} else {
  git -C $Dir pull
}
Set-Location $Dir
& powershell -ExecutionPolicy Bypass -File scripts\run-local.ps1 -WebPort $WebPort
