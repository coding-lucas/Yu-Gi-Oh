# Conformidade, jogo responsável e restrições territoriais

## Princípios

1. **Sandbox por padrão.** Toda a operação usa a moeda fictícia `ATH` em modo `SANDBOX`. Não há conversão para
   dinheiro real nem prêmios reais.
2. **Kill-switch de dinheiro real.** `REAL_MONEY_ENABLED=false`. Mesmo com a flag ligada, apostas reais exigem jurisdição
   `LICENSED` **e** KYC `VERIFIED` (função `gateBetting` em `packages/shared/src/compliance.ts`, testada).
3. **Idioma nunca define território.** A jurisdição vem de sinais verificáveis (geolocalização da borda/CDN e país da
   conta/KYC) e o mais restritivo prevalece. Trocar o idioma não altera nada (teste automatizado).
4. **Cobertura esportiva ≠ permissão comercial.** Oferecer o Brasileirão não significa aceitar apostas de residentes
   no Brasil.

## Política territorial padrão

| Status | Efeito |
| --- | --- |
| `BLOCKED` | sem cadastro, depósito ou aposta — nem em sandbox |
| `SANDBOX_ONLY` | apenas saldo fictício |
| `LICENSED` | dinheiro real **possível** (somente com licença válida + flag global + KYC) |

Padrão para países não listados: `SANDBOX_ONLY`. Lista inicial em `DEFAULT_JURISDICTIONS` (editável no painel, com
auditoria): `BR` SANDBOX_ONLY (exige autorização SPA/MF — Lei 14.790/2023 — e domínio `.bet.br`); `US`, `FR`, `NL`,
`AU`, `SG`, `CN`, `AE`, `SA` e países sancionados (`KP`, `IR`, `CU`, `SY`) BLOCKED; `GB`, `ES`, `IT` SANDBOX_ONLY.
**Esta tabela é um ponto de partida técnico e deve ser validada pelo jurídico.**

## Jogo responsável (implementado)

* Verificação de idade (18+) no cadastro e no gate de cada aposta.
* Limites de depósito (diário/semanal/mensal), de perda (diário/semanal/mensal) e de stake por aposta.
  Reduções são imediatas; **aumentos/remoções só valem após 24 h** (período de resfriamento).
* Pausa (1–42 dias) e autoexclusão (≥ 180 dias ou permanente). Durante a exclusão: sem apostas e sem depósitos;
  saques do saldo existente continuam permitidos.
* Página de jogo responsável e aviso 18+ em todos os idiomas.

## AML e prevenção a fraudes (implementado — heurísticas iniciais)

Alertas em `suspicious_activities`, revisáveis no painel:

* `LARGE_DEPOSIT` / `LARGE_WITHDRAWAL` acima do limiar configurável;
* `LOW_TURNOVER_WITHDRAWAL` (saque com volume apostado < 50% dos depósitos em 7 dias);
* `DEPOSIT_VELOCITY` (≥ 10 depósitos/hora);
* `BRUTE_FORCE_LOCKOUT`;
* `LEDGER_RECONCILIATION_FAILED` (integridade contábil).

Saques acima de `largeWithdrawalReview` ficam `REQUIRES_REVIEW` até aprovação de `RISK`/`ADMIN` (com auditoria).

## KYC

Campo `kyc_status` (`NONE/PENDING/VERIFIED/REJECTED`) já participa do gate de dinheiro real. **Integração com provedor
de KYC (documento + prova de vida + PEP/sanções) está pendente.**

## Pagamentos

* Provedor principal: **Paysafe Payments API** (sandbox `PAYSAFE_ENV=test`); secundário: **Nuvei** (registrado,
  desativado); simulador interno para o sandbox. Detalhes em [docs/PAYMENTS.md](docs/PAYMENTS.md).
* **Cada método só é oferecido após registro de três aprovações** — elegibilidade da AthosBet, regulamentação
  aplicável e aprovação comercial do gateway — mais uma referência de evidência, por provedor × método × país × modo.
  O banco impede ativar sem elas; revogar qualquer aprovação desativa o método; toda mudança é auditada.
* Todas as linhas Paysafe nascem desativadas. O ambiente `live` da Paysafe é recusado na inicialização enquanto
  `REAL_MONEY_ENABLED=false`.
* É **proibido** usar intermediários ou descritores comerciais que ocultem a atividade de apostas; o merchant deve ser
  aprovado expressamente para gambling licenciado (MCC 7995).
* Cartões em conformidade PCI DSS SAQ-A (campos hospedados Paysafe.js); dados de destino de saque são mascarados e,
  quando necessários para pagamento posterior, cifrados com AES-256-GCM.

## Escudos e marcas de clubes

Escudos oficiais são marcas registradas. A AthosBet só exibe um escudo oficial quando ele vem de fonte licenciada (logo
fornecido pelo feed de dados contratado, ex.: API-Football, ou arquivo enviado por operador que detenha os direitos —
campo `logo_source`, auditado). Na ausência disso, a interface gera um brasão próprio da AthosBet nas cores do clube
com o monograma, sem imitar o escudo registrado.

## Regras de mercado

Regras explícitas de liquidação em `MARKET_RULES` (exibidas na UI): tempo regulamentar (90' + acréscimos), sem
prorrogação/pênaltis; cancelamento/abandono/adiamento > 48 h ⇒ anulação (odd 1,00); "Empate anula" devolve no empate;
linhas de gols com meia unidade; correção de resultado oficial ⇒ reliquidação.

## Checklist antes de qualquer operação com dinheiro real

- [ ] Parecer jurídico por mercado e licença emitida
- [ ] Provedor de KYC/AML integrado e testado; triagem de sanções/PEP
- [ ] PSP licenciado para gambling, homologação concluída
- [ ] Geolocalização com provedor certificado (não apenas header de CDN)
- [ ] Termos, política de privacidade (LGPD/GDPR) e de jogo responsável revisados
- [ ] Relatórios regulatórios e retenção de dados definidos
- [ ] Auditoria de segurança externa
