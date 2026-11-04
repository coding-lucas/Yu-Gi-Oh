import { hotp, totp, verifyTotp, base32Encode, base32Decode, encrypt, decrypt, hashPassword, verifyPassword } from '../../src/common/crypto';
import { ApiFootballProvider, mapApiFootballStatus } from '../../src/sports/providers/api-football.provider';
import { OddsApiClient, normalizeTeamName } from '../../src/odds/odds-api.client';
import { localDayRange, tzOffsetMs, addDaysYmd } from '../../src/common/time';
import { DemoProvider } from '../../src/sports/providers/demo.provider';
import { matchOutcome } from '../../src/settlement/settlement.service';
import { seasonFor, CATALOG } from '../../src/sports/catalog';
import { loadConfig } from '../../src/config';

describe('crypto', () => {
  it('HOTP matches RFC 4226 test vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect(['755224', '287082', '359152', '969429', '338314'].map((_, i) => hotp(key, i))).toEqual(['755224', '287082', '359152', '969429', '338314']);
  });
  it('TOTP matches RFC 6238 (SHA-1, T=59s → 94287082 for 8 digits)', () => {
    expect(hotp(Buffer.from('12345678901234567890'), 1, 8)).toBe('94287082');
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const code = totp(secret, 1_700_000_000_000);
    expect(verifyTotp(secret, code, 1_700_000_000_000 + 29_000)).toBe(true);
    expect(verifyTotp(secret, code, 1_700_000_000_000 + 120_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
  });
  it('AES-GCM round trip and tamper detection', () => {
    const k = 'a'.repeat(64);
    const c = encrypt('secret', k);
    expect(decrypt(c, k)).toBe('secret');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decrypt(parts.join('.'), k)).toThrow();
  });
  it('scrypt password hashing', async () => {
    const h = await hashPassword('correct horse 1');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse 1', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
});

describe('API-Football mapping', () => {
  it('maps statuses', () => {
    expect(mapApiFootballStatus('NS')).toBe('SCHEDULED');
    expect(mapApiFootballStatus('2H')).toBe('LIVE');
    expect(mapApiFootballStatus('AET')).toBe('FINISHED');
    expect(mapApiFootballStatus('PST')).toBe('POSTPONED');
    expect(mapApiFootballStatus('CANC')).toBe('CANCELLED');
    expect(mapApiFootballStatus('ABD')).toBe('ABANDONED');
    expect(mapApiFootballStatus('AWD')).toBe('CANCELLED');
    expect(mapApiFootballStatus('???')).toBe('SUSPENDED');
  });
  it('uses the 90-minute score, never extra time', () => {
    const f = ApiFootballProvider.toFixture({
      fixture: { id: 1, date: '2026-05-01T19:00:00+00:00', status: { short: 'AET', long: 'After extra time' }, venue: { name: 'Maracanã' } },
      league: { season: 2026, round: 'Final' },
      teams: { home: { id: 127, name: 'Flamengo' }, away: { id: 121, name: 'Palmeiras' } },
      goals: { home: 2, away: 1 }, score: { fulltime: { home: 1, away: 1 }, extratime: { home: 1, away: 0 } },
    });
    expect(f).toMatchObject({ status: 'FINISHED', homeGoals: 1, awayGoals: 1, venue: 'Maracanã', providerId: '1' });
  });
  it('handles HTTP errors, provider errors and timeouts as ProviderError', async () => {
    const p = new ApiFootballProvider('k', 'https://x', (async () => new Response('', { status: 503 })) as any);
    await expect(p.fixtures({ providerId: '71', season: 2026, slug: 'x' }, new Date(), new Date())).rejects.toMatchObject({ httpStatus: 503, retryable: true });
    const p2 = new ApiFootballProvider('k', 'https://x', (async () => new Response(JSON.stringify({ errors: { token: 'invalid' }, response: [] }), { status: 200 })) as any);
    await expect(p2.fixtures({ providerId: '71', season: 2026, slug: 'x' }, new Date(), new Date())).rejects.toMatchObject({ retryable: false });
    const p3 = new ApiFootballProvider('k', 'https://x', (async () => { throw new Error('ECONNRESET'); }) as any);
    await expect(p3.fixtures({ providerId: '71', season: 2026, slug: 'x' }, new Date(), new Date())).rejects.toThrow(/network/);
    const p4 = new ApiFootballProvider('k', 'https://x', (async () => new Response('not json', { status: 200 })) as any);
    await expect(p4.fixtures({ providerId: '71', season: 2026, slug: 'x' }, new Date(), new Date())).rejects.toThrow(/malformed/);
  });
  it('sends the api key header and query parameters', async () => {
    let seen: any;
    const p = new ApiFootballProvider('KEY', 'https://v3.football.api-sports.io', (async (url: URL, init: any) => { seen = { url: url.toString(), init }; return new Response(JSON.stringify({ response: [], errors: [] })); }) as any);
    await p.fixtures({ providerId: '71', season: 2026, slug: 'x' }, new Date('2026-11-01'), new Date('2026-11-08'));
    expect(seen.url).toContain('league=71');
    expect(seen.url).toContain('from=2026-11-01');
    expect(seen.init.headers['x-apisports-key']).toBe('KEY');
  });
});

describe('The Odds API parsing', () => {
  it('averages bookmakers', () => {
    const e = OddsApiClient.parse({
      id: 'e1', home_team: 'Flamengo', away_team: 'Palmeiras', commence_time: '2026-11-08T19:00:00Z',
      bookmakers: [
        { markets: [{ key: 'h2h', outcomes: [{ name: 'Flamengo', price: 2.0 }, { name: 'Palmeiras', price: 4.0 }, { name: 'Draw', price: 3.2 }] }, { key: 'totals', outcomes: [{ name: 'Over', point: 2.5, price: 2.1 }, { name: 'Under', point: 2.5, price: 1.75 }] }] },
        { markets: [{ key: 'h2h', outcomes: [{ name: 'Flamengo', price: 2.2 }, { name: 'Palmeiras', price: 3.8 }, { name: 'Draw', price: 3.4 }] }] },
      ],
    });
    expect(e.consensus.matchResult).toEqual({ home: 2.1, draw: 3.3, away: 3.9 });
    expect(e.consensus.totals25).toEqual({ over: 2.1, under: 1.75 });
    expect(e.consensus.bookmakers).toBe(2);
  });
  it('normalises team names for matching', () => {
    expect(normalizeTeamName('São Paulo FC')).toBe(normalizeTeamName('Sao Paulo'));
    expect(normalizeTeamName('Grêmio')).toBe('gremio');
  });
});

describe('time zones', () => {
  it('computes local day boundaries', () => {
    const [s, e] = localDayRange('2026-11-04', 'America/Sao_Paulo');
    expect(s.toISOString()).toBe('2026-11-04T03:00:00.000Z');
    expect(e.toISOString()).toBe('2026-11-05T03:00:00.000Z');
    const [s2] = localDayRange('2026-11-04', 'Asia/Tokyo');
    expect(s2.toISOString()).toBe('2026-11-03T15:00:00.000Z');
    expect(tzOffsetMs('UTC', new Date())).toBe(0);
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('demo provider (sandbox data)', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  const p = new DemoProvider(true, () => now);
  const ref = { providerId: '71', season: 2026, slug: 'brasileirao-serie-a' };
  it('is deterministic and covers the next 7 days', async () => {
    const a = await p.fixtures(ref, now, new Date(now.getTime() + 7 * 86_400_000));
    const b = await p.fixtures(ref, now, new Date(now.getTime() + 7 * 86_400_000));
    expect(a.length).toBeGreaterThan(10);
    expect(a.map((x) => x.providerId)).toEqual(b.map((x) => x.providerId));
    expect(a.every((x) => x.home.providerId !== x.away.providerId)).toBe(true);
  });
  it('each team plays at most once per matchday and history is finished with scores', async () => {
    const h = await p.history(ref);
    expect(h.length).toBeGreaterThan(300);
    expect(h.every((x) => x.status === 'FINISHED' && x.homeGoals !== null)).toBe(true);
    const byRound = new Map<string, string[]>();
    for (const f of h) {
      const k = f.providerId.split(':')[1];
      byRound.set(k, [...(byRound.get(k) ?? []), f.home.name, f.away.name]);
    }
    for (const teams of byRound.values()) expect(new Set(teams).size).toBe(teams.length);
  });
});

describe('settlement outcome rules', () => {
  const base: any = { status: 'SCHEDULED', homeGoals: null, awayGoals: null, kickoffAt: new Date('2026-11-04T20:00:00Z'), originalKickoffAt: new Date('2026-11-04T20:00:00Z') };
  it('derives outcomes', () => {
    expect(matchOutcome(base)).toBeNull();
    expect(matchOutcome({ ...base, status: 'FINISHED', homeGoals: 1, awayGoals: 0 })!.outcome).toEqual({ kind: 'RESULT', homeGoals: 1, awayGoals: 0 });
    expect(matchOutcome({ ...base, status: 'ABANDONED' })!.outcome.kind).toBe('VOID');
    expect(matchOutcome({ ...base, status: 'POSTPONED' }, new Date('2026-11-05T20:00:00Z'))).toBeNull();
    expect(matchOutcome({ ...base, status: 'POSTPONED' }, new Date('2026-11-07T20:00:01Z'))!.reason).toBe('POSTPONED');
    expect(matchOutcome({ ...base, kickoffAt: new Date('2026-11-05T19:00:00Z') })).toBeNull(); // moved within 48h: bets stand
    expect(matchOutcome({ ...base, kickoffAt: new Date('2026-11-08T19:00:00Z') })!.reason).toBe('RESCHEDULED');
  });
});

describe('catalogue & config', () => {
  it('has unique slugs and ids, Brasileirão first', () => {
    expect(new Set(CATALOG.map((c) => c.slug)).size).toBe(CATALOG.length);
    expect(new Set(CATALOG.map((c) => c.apiFootballId)).size).toBe(CATALOG.length);
    expect([...CATALOG].sort((a, b) => a.priority - b.priority)[0].slug).toBe('brasileirao-serie-a');
    expect(seasonFor({ seasonMode: 'SPLIT' }, new Date('2026-03-01'))).toBe(2025);
    expect(seasonFor({ seasonMode: 'SPLIT' }, new Date('2026-09-01'))).toBe(2026);
    expect(seasonFor({ seasonMode: 'CALENDAR' }, new Date('2026-03-01'))).toBe(2026);
  });
  it('refuses insecure production configuration and keeps real money off by default', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as any)).toThrow(/JWT_SECRET/);
    expect(loadConfig({} as any).REAL_MONEY_ENABLED).toBe(false);
  });
});
