# Pagamentos — Paysafe (principal), Nuvei (secundário) e simulador interno

> **Nenhum pagamento real está ativo.** `PAYSAFE_ENV=test` (sandbox Paysafe) é o padrão; a API **recusa iniciar** com
> `PAYSAFE_ENV=live` enquanto `REAL_MONEY_ENABLED=false`, e o modo REAL só pode ser ligado após homologação e
> autorização jurídica (ver COMPLIANCE.md).

## Arquitetura

```
 PaymentsService (núcleo: ledger, limites, AML, auditoria, idempotência)
        │  depende apenas de ▼
 PaymentProvider (interface)  ── createDeposit · createPayout · refund · sync · parseWebhook
        ├── PaysafeProvider   (apps/api/src/payments/providers/paysafe)  — principal
        ├── NuveiProvider     (registrado, desativado até contrato/homologação)
        └── InternalSandboxProvider (simulador sem chamadas externas)
 EligibilityService ── decide QUAL provedor atende (método × país × modo) — ou nenhum
```

Adicionar a Nuvei = implementar `NuveiProvider` (mesma interface) e registrar linhas de elegibilidade; nada muda em
razão, carteira, apostas ou liquidação.

## Elegibilidade de métodos (gate obrigatório)

Tabela `payment_method_eligibility` (provider, method, country|`*`, mode, currency, directions, priority, limites):

| Requisito | Campo |
| --- | --- |
| Elegibilidade da AthosBet (licença/registro para oferecer o método no país) | `athosbet_eligible` |
| Regulamentação aplicável validada pelo jurídico | `regulatory_approved` |
| Aprovação comercial do gateway (merchant de gambling, MCC 7995) | `gateway_approved` |
| Referência de evidência (contrato, parecer, ticket de onboarding) | `evidence` |
| Ativação | `enabled` (constraint no banco impede ativar sem as 3 aprovações) |

Além disso o provedor precisa estar configurado (`isConfigured`) e, para `REAL`, `REAL_MONEY_ENABLED=true` +
jurisdição `LICENSED` + KYC. Revogar qualquer aprovação desativa o método imediatamente. Somente `ADMIN` (com MFA)
altera a tabela; toda alteração é auditada (antes/depois). Linhas Paysafe são criadas **desativadas**.

País considerado: geolocalização confiável da requisição (ou país da conta quando desconhecido) — nunca o idioma.

## Métodos e fluxos Paysafe

| AthosBet | Paysafe `paymentType` (padrão, configurável) | Depósito | Saque | Reembolso |
| --- | --- | --- | --- | --- |
| Cartão crédito/débito | `CARD` | Paysafe.js → token → `POST /payments` | payment handle `STANDALONE_CREDIT` → `POST /standalonecredits` | `POST /settlements/{paymentId}/refunds` |
| PIX | `PIX`* | payment handle (redirect/QR) → PAYABLE → `POST /payments` | standalone credit | refund |
| Boleto | `BOLETO`* | payment handle → pago → PAYABLE → `POST /payments` | standalone credit | (crédito) |
| Transferência | `PAY_BY_BANK`* | payment handle (redirect) | standalone credit | refund |
| Pay with Crypto (BTC quando disponível) | `CRYPTO`* | payment handle (redirect) | conforme disponibilidade | conforme disponibilidade |

\* Os nomes exatos dos `paymentType` alternativos e as contas (`accountId`) por moeda dependem da configuração do
merchant na Paysafe e **devem ser confirmados na homologação** (`PAYSAFE_PAYMENT_TYPES`, `PAYSAFE_ACCOUNTS`).

* Base: `https://api.test.paysafe.com/paymenthub/v1` (sandbox) / `https://api.paysafe.com/paymenthub/v1` (live).
* Autenticação Basic (`PAYSAFE_API_USERNAME`/`PAYSAFE_API_PASSWORD`); cabeçalho `Simulator: EXTERNAL` só em test.
* `merchantRefNum` = id do pagamento AthosBet (`{id}-h` para o payment handle) + `dupCheck: true` → idempotência no
  provedor. Reenvio após resposta perdida que retorne duplicidade (5031) é resolvido consultando por `merchantRefNum`.
* `settleWithAuth: true` em depósitos (captura imediata). Valores em centavos.
* Cartões: **PCI DSS SAQ-A** — dados digitados nos campos hospedados do Paysafe.js; o backend só recebe o token de uso
  único (`POST /api/payments/:id/confirm`). O backend **nunca** aceita número de cartão para gateways reais.
* Retries com back-off em erros de rede/5xx/429; erros 4xx definitivos falham a operação sem mover dinheiro.

## Confirmação assíncrona e webhooks

`POST /api/payments/webhooks/paysafe`
1. Assinatura: HMAC-SHA256 do corpo bruto com `PAYSAFE_WEBHOOK_HMAC_KEY`, base64, no cabeçalho
   `PAYSAFE_SIGNATURE_HEADER` (padrão `signature`), comparação em tempo constante. Inválida → 401 + auditoria.
2. Deduplicação por `(provider, event_id)` (`payment_events`).
3. Localiza o pagamento por `merchantRefNum` (ou id do provedor).
4. **Relê o status na API Paysafe** (`sync`) — valores e status do payload nunca são usados para mover dinheiro.
   Se o handle estiver `PAYABLE`, o pagamento/crédito é processado (idempotente).
5. Aplica a transição sob lock: lançamentos idempotentes (`payment:{id}:complete`, `payment:{id}:reverse`).

Rede de segurança: job `payments-sync` (1 min) consulta pagamentos `PENDING/REQUIRES_ACTION` (cobre webhooks
perdidos); depósitos abandonados expiram em 48 h (sem crédito).

## Contabilidade (partidas dobradas)

| Evento | Lançamentos |
| --- | --- |
| Depósito confirmado | PAYMENT_CLEARING −A · USER_WALLET +A |
| Saque solicitado | USER_WALLET −A (saldo ≥ 0) · WITHDRAWALS_PENDING +A |
| Saque pago | WITHDRAWALS_PENDING −A · PAYMENT_CLEARING +A |
| Saque falhou/rejeitado | reversão exata da solicitação |
| Reembolso solicitado | USER_WALLET −A (saldo ≥ 0) · WITHDRAWALS_PENDING +A (`REFUND_REQUEST`) |
| Reembolso pago / falhou | `REFUND_COMPLETE` / `REFUND_REVERSAL` |

Sandbox: valores de teste do provedor (ex.: BRL) correspondem 1:1 ao saldo fictício `ATH`; em modo REAL as moedas
devem coincidir. Soma de reembolsos ≤ depósito original (validado sob lock e pela Paysafe).

Status final divergente reportado pelo provedor (ex.: COMPLETED → FAILED) **não** é revertido automaticamente: gera
alerta `PAYMENT_STATUS_MISMATCH` (HIGH) para análise manual.

## Conciliação

`POST /api/admin/payments/reconcile/:provider` e job horário `payments-reconcile`:
* status do provedor × status AthosBet para cada pagamento com referência (janela de 7 dias);
* razão: exatamente um lançamento de conclusão por pagamento concluído, valor creditado = valor do depósito, nenhuma
  conclusão em pagamento não concluído, reversão presente em saques/reembolsos falhos.
Resultados em `payment_reconciliation_runs`; divergências geram alerta `PAYMENT_RECONCILIATION_MISMATCH`.

## Auditoria

`payment.deposit.create`, `payment.withdrawal.create|approve|reject`, `payment.refund.create`,
`payment.{direction}.{completed|failed|cancelled}`, `payment.provider.error`, `payment.status.mismatch`,
`payment.webhook.invalid_signature|unmatched`, `payments.eligibility.update`, `admin.payments.reconcile`.

## Testes

* `apps/api/test/unit/paysafe.spec.ts` — URLs, Basic auth, retries, mapeamento de status, PIX/handle, tokenização de
  cartão, resposta perdida + dupCheck, conta ausente, assinatura de webhook, bloqueio do ambiente live.
* `apps/api/test/integration/paysafe.spec.ts` — Paysafe simulada (`test/fakes/fake-paysafe.ts`) + PostgreSQL real:
  gate de aprovações, PIX com webhooks duplicados/concorrentes e payload adulterado, webhook forjado, webhook perdido,
  cartão aprovado/recusado, saque e falha de saque, reembolso parcial/excedente/idempotente, conciliação com divergência,
  revogação de aprovação e Nuvei nunca roteada.

## Checklist de homologação Paysafe

- [ ] Liberar `developer.paysafe.com` / `api.test.paysafe.com` na rede do ambiente e validar contratos de campos.
- [ ] Credenciais sandbox (API key privada, single-use-token key pública, chave HMAC de webhook).
- [ ] `accountId` por método/moeda; confirmar `paymentType` de PIX, Boleto, Pay by Bank e Pay with Crypto.
- [ ] Cadastrar URL de webhook e eventos; validar formato real do cabeçalho de assinatura.
- [ ] Validar campos obrigatórios por método (CPF para PIX/Boleto, dados de payout).
- [ ] Testes ponta a ponta no sandbox Paysafe com cada método; registrar evidências na tabela de elegibilidade.
