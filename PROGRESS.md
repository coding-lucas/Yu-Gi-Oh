# Progresso

Legenda: ✅ implementado **e** coberto por testes automatizados · 🟡 implementado parcialmente / sem teste com dados
reais · ⏳ não iniciado. Nada é marcado ✅ sem teste.

_Última atualização: 2026-11-04._

## Fase 1 — Monorepo, arquitetura, banco, autenticação, identidade
* ✅ Monorepo pnpm (`apps/api`, `apps/web`, `packages/shared`, `packages/odds-engine`)
* ✅ Schema PostgreSQL com constraints, índices, triggers de imutabilidade e balanceamento; migrator versionado com checksum
* ✅ Cadastro (18+, território), login, refresh com rotação/reuso, recuperação de senha, bloqueio por força bruta
* ✅ MFA TOTP obrigatório para equipe; RBAC (USER/SUPPORT/RISK/ADMIN); CSRF; auditoria
* ✅ Marca AthosBet (logotipo SVG original, paleta azul/esmeralda/grafite/branco, ícones PWA)

## Fase 2 — Interface mobile first e i18n
* ✅ 11 idiomas com chaves/placeholder validados por teste; detecção automática; seletor manual; RTL (árabe)
* ✅ Navegação inferior no mobile, bilhete persistente (localStorage) com bottom sheet no mobile e painel no desktop
* ✅ PWA instalável (manifest, ícones 192/512/maskable, service worker que nunca faz cache de `/api`)
* ✅ Fluxo de UI testado com Playwright (`apps/web/e2e/ui-flow.mjs`): pt mobile, cadastro, aposta, admin MFA, liquidação, ar RTL, ja
* 🟡 Moedas regionais: formatação via `Intl` pronta; a moeda é única (`ATH`) enquanto sandbox
* ⏳ Tema claro (o produto é dark-first por requisito)

## Fase 3 — Futebol internacional
* ✅ Catálogo de 37 competições (Brasil, América do Sul, Europa, outras) — adicionar competição = 1 entrada no catálogo
* ✅ Sincronização idempotente, deduplicação entre fontes, adiamentos/cancelamentos/remarcações, correções de resultado,
  falhas de API registradas, suspensão por dados obsoletos (testes de integração com provedor fake)
* ✅ Cliente API-Football (status, placar de 90', erros HTTP/payload/timeout) — testado com respostas simuladas
* ✅ Provedor demo determinístico (8 ligas sintéticas) para o MVP sandbox
* 🟡 **Cobertura real NÃO verificada**: não havia `API_FOOTBALL_KEY` neste ambiente. Todas as competições estão com
  `coverage_status = UNVERIFIED`. Com a chave: `POST /api/admin/jobs/coverage` e testes com dados reais por competição.
  IDs de estaduais (475/624/629/477) e de algumas copas precisam de confirmação.
* 🟡 Desfalques/lesões: ingestão via `/injuries` com heurística (6%/ausência, teto 50%) até existir rating por jogador
* ⏳ Estatísticas detalhadas por partida (tabela `match_statistics` pronta, ingestão pendente)

## Fase 4 — Motor estatístico
* ✅ Poisson + Dixon–Coles (ρ por verossimilhança de perfil), força ofensiva/defensiva por MLE com decaimento temporal
  e ridge, mando de campo, forma recente, H2H, desfalques, qualidade do adversário (intrínseca ao MLE)
* ✅ Margem configurável (power/proporcional), escada de preços com arredondamento para baixo, limites de odd
* ✅ Comparação com mercado (de-vig) — blend recalibrando λ (consistência entre mercados) e suspensão por divergência
* ✅ Suspensão automática: dados insuficientes, inconsistentes, divergência, baixa confiança (placar exato)
* ✅ Backtest walk-forward, Brier, log loss, RPS, calibração/ECE (painel admin e CLI `node dist/odds/backtest.cli.js`)
* 🟡 Métricas só em dados **sintéticos** (histórico demo, 6.804 previsões): Brier 0,585 vs. 0,644 da linha de base;
  log loss 0,983 vs. 1,064; ECE 0,005. **Validação com dados reais pendente** (depende da chave API-Football).
* ✅ The Odds API: parsing e matching testados; 🟡 chamada real não testada (sem chave)
* ⏳ Nenhuma IA generativa é usada para probabilidades (requisito atendido por construção)

## Fase 5 — Bilhetes, carteira, liquidação (sandbox)
* ✅ Simples e múltiplas; bloqueio de seleções da mesma partida em múltiplas; mudança de odds (NONE/HIGHER/ANY)
* ✅ Aceitação atômica, idempotente, sem gasto duplo sob concorrência (16 requisições simultâneas)
* ✅ Razão de partidas dobradas imutável, conciliação, reversões
* ✅ Liquidação automática idempotente (execuções concorrentes), reliquidação em correções (v1→v2→v3), anulações
* ✅ Depósitos/saques sandbox, webhooks assinados e deduplicados, saques com revisão manual

## Fase 6 — Painel administrativo e risco
* ✅ KPIs (usuários, volume, GGR, hold, prêmios, apostas abertas/liquidadas, exposição, depósitos/saques, mercados,
  erros de API), série de 14 dias, exposição por seleção, conciliação
* ✅ Partidas (suspender/retomar, resultado sandbox), pagamentos (aprovar/rejeitar), usuários, auditoria, margens,
  limites de risco, competições, jurisdições, jobs, backtest, execuções de modelo, alertas AML
* 🟡 Exportações/relatórios regulatórios

## Fase 7 — Integrações financeiras, segurança, conformidade
* ✅ Gateway sandbox completo (PIX, cartão crédito/débito, boleto, transferência, BTC simulados)
* 🟡 Nuvei/Paysafe: apenas interfaces desativadas — depende de contrato e licença
* ✅ Limites de jogo responsável com resfriamento, autoexclusão, gate territorial, alertas AML
* ⏳ Provedor de KYC/verificação de idade documental; e-mail transacional

## Fase 8 — Testes finais, documentação, observabilidade, produção
* ✅ Testes: shared (20), odds-engine (19), API unit (16), integração (36), E2E MVP (1), web (18), UI Playwright
* 🟡 Teste de carga: script k6 pronto (`tests/load`), **não executado** neste ambiente (k6 indisponível)
* ✅ `/api/health`, `/api/metrics` (Prometheus), `provider_sync_runs`, auditoria
* ✅ Docker Compose, Dockerfiles, CI (GitHub Actions), `.env.example`, Swagger (`/api/docs`), guia de deploy
* 🟡 Imagens Docker não construídas neste ambiente (limite de pull do Docker Hub); bundle de produção
  (`pnpm deploy`) validado localmente
* ⏳ Adaptador Redis do Socket.IO para múltiplas réplicas; tracing distribuído (OpenTelemetry)
* ⏳ Apostas ao vivo (fase posterior: feed com baixa latência, delays de aceitação, cash-out)

## Critério de MVP
Coberto pelo teste `apps/api/test/e2e/mvp.spec.ts` e pelo fluxo Playwright: cadastro com idioma, Brasileirão e
outras ligas listados (com o **provedor demo**), odds calculadas pelo modelo, aposta com saldo fictício, resultado
oficial (entrada sandbox pelo mesmo caminho de ingestão), liquidação automática correta, painel e auditoria.
**Pendência para o critério literal "partidas reais"**: configurar `API_FOOTBALL_KEY` e verificar a cobertura.
