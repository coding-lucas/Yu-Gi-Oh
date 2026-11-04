/**
 * Territorial rules. Language and UI locale NEVER influence these decisions: only the
 * jurisdiction resolved from verified signals (geo-IP at the edge, KYC address) does.
 */
export type JurisdictionStatus = 'BLOCKED' | 'SANDBOX_ONLY' | 'LICENSED';
export type WalletMode = 'SANDBOX' | 'REAL';

export interface JurisdictionRule {
  country: string; // ISO 3166-1 alpha-2, or 'XX' for unknown
  status: JurisdictionStatus;
  note?: string;
}

export interface BetGateInput {
  mode: WalletMode;
  realMoneyEnabled: boolean; // global kill-switch, false until legal sign-off
  jurisdiction: JurisdictionStatus;
  kycVerified: boolean;
  selfExcludedUntil: Date | null;
  now: Date;
  ageYears: number;
}

export type GateDenial =
  | 'JURISDICTION_BLOCKED'
  | 'REAL_MONEY_DISABLED'
  | 'REAL_MONEY_NOT_LICENSED'
  | 'KYC_REQUIRED'
  | 'SELF_EXCLUDED'
  | 'UNDERAGE';

export const MIN_AGE = 18;

export function gateBetting(i: BetGateInput): GateDenial | null {
  if (i.ageYears < MIN_AGE) return 'UNDERAGE';
  if (i.selfExcludedUntil && i.selfExcludedUntil > i.now) return 'SELF_EXCLUDED';
  if (i.jurisdiction === 'BLOCKED') return 'JURISDICTION_BLOCKED';
  if (i.mode === 'REAL') {
    if (!i.realMoneyEnabled) return 'REAL_MONEY_DISABLED';
    if (i.jurisdiction !== 'LICENSED') return 'REAL_MONEY_NOT_LICENSED';
    if (!i.kycVerified) return 'KYC_REQUIRED';
  }
  return null;
}

export function ageInYears(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/**
 * Default territorial policy: nowhere is licensed. Countries with explicit prohibitions or
 * sanctions are blocked even for the sandbox. Brazil requires an SPA/MF authorisation
 * (Lei 14.790/2023) and is therefore SANDBOX_ONLY — covering the Brasileirão does not mean
 * accepting real-money bets from Brazilian residents.
 */
export const DEFAULT_JURISDICTIONS: JurisdictionRule[] = [
  { country: 'BR', status: 'SANDBOX_ONLY', note: 'Requires SPA/MF authorisation (Lei 14.790/2023) and .bet.br domain' },
  { country: 'US', status: 'BLOCKED', note: 'State-by-state licensing; blocked by default' },
  { country: 'FR', status: 'BLOCKED', note: 'ANJ licence required' },
  { country: 'ES', status: 'SANDBOX_ONLY', note: 'DGOJ licence required' },
  { country: 'IT', status: 'SANDBOX_ONLY', note: 'ADM licence required' },
  { country: 'GB', status: 'SANDBOX_ONLY', note: 'UKGC licence required' },
  { country: 'NL', status: 'BLOCKED', note: 'KSA licence required' },
  { country: 'AU', status: 'BLOCKED' },
  { country: 'SG', status: 'BLOCKED' },
  { country: 'CN', status: 'BLOCKED' },
  { country: 'KP', status: 'BLOCKED', note: 'Sanctions' },
  { country: 'IR', status: 'BLOCKED', note: 'Sanctions' },
  { country: 'CU', status: 'BLOCKED', note: 'Sanctions' },
  { country: 'SY', status: 'BLOCKED', note: 'Sanctions' },
  { country: 'AE', status: 'BLOCKED' },
  { country: 'SA', status: 'BLOCKED' },
];
export const DEFAULT_JURISDICTION_STATUS: JurisdictionStatus = 'SANDBOX_ONLY';
