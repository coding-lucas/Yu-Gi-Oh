import { z } from 'zod';

const bool = (d: boolean) => z.enum(['true', 'false', '1', '0']).optional().transform((v) => (v === undefined ? d : v === 'true' || v === '1'));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/athosbet'),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-dev-only-secret-change-me'),
  /** 32-byte hex key used to encrypt MFA secrets at rest (AES-256-GCM) */
  DATA_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).default('0'.repeat(63) + '1'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  /** only trust CDN geo headers (cf-ipcountry / x-vercel-ip-country) when behind that CDN */
  TRUST_GEO_HEADER: bool(false),
  /** fallback country when geo cannot be resolved — 'XX' = unknown */
  DEFAULT_COUNTRY: z.string().length(2).default('XX'),
  SPORTS_PROVIDER: z.enum(['api-football', 'demo']).default('demo'),
  API_FOOTBALL_KEY: z.string().optional(),
  API_FOOTBALL_BASE_URL: z.string().default('https://v3.football.api-sports.io'),
  ODDS_API_KEY: z.string().optional(),
  ODDS_API_BASE_URL: z.string().default('https://api.the-odds-api.com/v4'),
  /** global kill-switch for real-money play. Must stay false until legal sign-off. */
  REAL_MONEY_ENABLED: bool(false),
  /** sandbox only: auto-generate results for demo fixtures after kick-off */
  SANDBOX_SIMULATE_RESULTS: bool(true),
  SANDBOX_STARTING_BALANCE: z.coerce.number().default(100000), // minor units = 1,000.00 ATH
  SCHEDULER_ENABLED: bool(true),
  COOKIE_SECURE: bool(false),
  SANDBOX_WEBHOOK_SECRET: z.string().default('sandbox-webhook-secret'),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  if (parsed.NODE_ENV === 'production') {
    if (parsed.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
    if (/^0+1$/.test(parsed.DATA_ENCRYPTION_KEY)) throw new Error('DATA_ENCRYPTION_KEY must be set in production');
  }
  return parsed;
}
export function config(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}
export function overrideConfig(patch: Partial<Config>) {
  cached = { ...config(), ...patch };
}
export const CONFIG = Symbol('CONFIG');
