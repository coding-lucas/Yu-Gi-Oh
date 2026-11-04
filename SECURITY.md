# Segurança

## Autenticação e sessão

* Senhas com **scrypt** (N=2¹⁵, r=8, p=1, sal de 16 bytes), comparação em tempo constante; política mínima de 10
  caracteres com letras e números.
* Access token JWT HS256 (15 min, `iss=athosbet`) em cookie `httpOnly; SameSite=Lax`; refresh token opaco (48 bytes)
  em cookie `httpOnly; SameSite=Strict; Path=/api/auth`, armazenado apenas como SHA-256.
* **Rotação de refresh token** com detecção de reuso: reapresentar um token já rotacionado revoga toda a família.
* Bloqueio após 5 falhas de login (15 min) + alerta `BRUTE_FORCE_LOCKOUT`; rate limiting (`@nestjs/throttler`) global e
  mais restrito em login/cadastro/recuperação.
* Recuperação de senha: token de uso único (30 min, hash SHA-256), resposta idêntica para e-mails inexistentes,
  revoga todas as sessões. Em produção o token só é entregue por e-mail (integração de e-mail pendente).
* **MFA administrativo**: TOTP (RFC 6238, validado contra vetores RFC 4226/6238). Perfis `SUPPORT`, `RISK` e `ADMIN`
  **não acessam** rotas `/admin` sem sessão MFA; segredos TOTP cifrados em repouso com **AES-256-GCM**
  (`DATA_ENCRYPTION_KEY`).

## Autorização

* Guard global: tudo é privado por padrão (`@Public()` explícito). RBAC por `@Roles()`; ações financeiras/sensíveis
  restritas a `ADMIN`/`RISK`.
* Jogadores só leem os próprios recursos (filtro por `user_id` em todas as consultas).

## CSRF, CORS e cabeçalhos

* Mutações autenticadas por cookie exigem o cabeçalho `x-athos-csrf: 1` (impossível de enviar cross-site sem
  passar pelo preflight CORS). CORS restrito a `CORS_ORIGIN` com credenciais.
* `helmet` na API; no web: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.

## Entrada e erros

* Validação estrita com **zod** em todos os corpos (incluindo `.strict()` nas configurações administrativas).
* SQL sempre parametrizado (Drizzle / template `sql`); teste de injeção incluído.
* Erros padronizados `{ code, details }`; stack traces nunca saem da API.

## Integridade financeira (defesa em profundidade)

* Triggers de banco tornam razão e auditoria **append-only** e exigem transações balanceadas, mesmo que a aplicação falhe.
* Idempotência em apostas, depósitos, saques, webhooks e liquidações; testes de concorrência comprovam ausência de
  gasto duplo e de crédito duplo.
* Webhooks de pagamento assinados (HMAC-SHA256, comparação constante) e deduplicados por `(provider, event_id)`;
  assinaturas inválidas são rejeitadas e auditadas. O conteúdo do webhook **nunca** move dinheiro: o status é relido
  na API do provedor antes de qualquer lançamento.
* Cartões: PCI DSS SAQ-A — dados capturados nos campos hospedados do Paysafe.js; o backend recebe apenas tokens de uso
  único e recusa números de cartão para gateways reais. Credenciais Paysafe ficam só no servidor; apenas a chave
  pública de tokenização é enviada ao navegador.
* Destinos de saque (chave PIX, conta) armazenados mascarados e cifrados (AES-256-GCM) quando necessários.

## Segredos e configuração

* A API **recusa iniciar em produção** com `JWT_SECRET` ou `DATA_ENCRYPTION_KEY` padrão.
* `.env` fora do Git; `.env.example` sem segredos reais. Em produção usar o cofre do provedor (Vercel/AWS/GCP Secrets).
* Cabeçalhos de geolocalização só são considerados quando `TRUST_GEO_HEADER=true` (atrás da CDN que os define).

## Auditoria

`audit_logs` registra login (sucesso/falha), cadastro, MFA, recuperação de senha, alterações de limites e
autoexclusão, mudanças de configuração (antes/depois), suspensões de mercado, resultados sandbox, ações sobre
pagamentos, usuários, competições e jurisdições, execuções de jobs e backtests.

## Testes de segurança automatizados

`apps/api/test/integration/security.spec.ts`: rotas privadas, RBAC, MFA obrigatório para equipe, CSRF, rotação/reuso
de refresh, bloqueio por força bruta, reset de senha de uso único, validação de entrada/injeção, trilha de auditoria.

## Pendências antes de produção

* Pentest externo; SAST/DAST e scanning de dependências no CI; política de rotação de chaves (KMS).
* Integração de e-mail transacional (reset de senha, alertas de login).
* WAF/proteção a bots na borda; device fingerprinting para prevenção a fraude.
* Content-Security-Policy estrita no web (nonce) após estabilizar scripts de terceiros.

## Reporte de vulnerabilidades

Envie para security@athos.software (placeholder — definir canal oficial). Não abra issues públicas.
