import { OperationContext, PaymentProvider, ProviderNotConfiguredError, ProviderResult, WebhookEvent } from '../provider';

/**
 * Nuvei — secondary PSP. Registered in the PaymentProviderRegistry so that routing, eligibility
 * and admin tooling already account for it. The API calls are intentionally not implemented until a
 * Nuvei merchant agreement for licensed gambling exists; isConfigured() therefore stays false and
 * the eligibility service never routes to it. Implementing it requires only this class.
 */
export class NuveiProvider implements PaymentProvider {
  readonly name = 'nuvei';
  readonly mode = 'SANDBOX' as const;
  constructor(private readonly creds: { merchantId?: string; siteId?: string; secret?: string }) {}
  isConfigured() {
    return false; // flip only after the connector below is implemented and homologated
  }
  supports() {
    return false;
  }
  private no(): never {
    throw new ProviderNotConfiguredError(this.name);
  }
  async createDeposit(_ctx: OperationContext): Promise<ProviderResult> { return this.no(); }
  async createPayout(_ctx: OperationContext): Promise<ProviderResult> { return this.no(); }
  async refund(_ctx: OperationContext): Promise<ProviderResult> { return this.no(); }
  async sync(_ctx: OperationContext): Promise<ProviderResult> { return this.no(); }
  parseWebhook(): WebhookEvent | null {
    return null;
  }
}
