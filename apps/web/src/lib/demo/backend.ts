/**
 * In-browser backend for the static demo (GitHub Pages). It serves the same routes and response
 * shapes as the NestJS API, using the SAME odds engine, settlement rules and demo data generator.
 * State (accounts, wallet, bets) lives in localStorage of the visitor's device. Fictitious money only.
 */
import {
  DEFAULT_PRICING_CONFIG, DEMO_LEAGUES, demoFixtures, fitRatings, priceMatch, MODEL_VERSION,
  type DemoFixture, type HistoricalMatch, type PricingResult, type RatingModel,
} from '@athosbet/odds-engine';
import {
  MARKET_RULES, acceptsPriceChange, combinedOddsK, parseMarketKey, potentialPayout, settleBet, settleSelection, validateSlip,
  type MatchOutcome, type SelectionResult,
} from '@athosbet/shared';
import { ApiError } from '../api';

const DAY = 86_400_000;
const STORE = 'athosbet-static-demo-v1';
const START_BALANCE = 100_000; // 1,000.00 ATH

const COMPETITIONS: Record<string, { name: string; country: string; countryCode: string | null; region: string; priority: number }> = {
  'brasileirao-serie-a': { name: 'Brasileirão Série A', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', priority: 1 },
  'brasileirao-serie-b': { name: 'Brasileirão Série B', country: 'Brazil', countryCode: 'BR', region: 'BRAZIL', priority: 2 },
  libertadores: { name: 'CONMEBOL Libertadores', country: 'South America', countryCode: null, region: 'SOUTH_AMERICA', priority: 10 },
  'uefa-champions-league': { name: 'UEFA Champions League', country: 'Europe', countryCode: null, region: 'EUROPE', priority: 20 },
  'premier-league': { name: 'Premier League', country: 'England', countryCode: 'GB', region: 'EUROPE', priority: 21 },
  'la-liga': { name: 'La Liga', country: 'Spain', countryCode: 'ES', region: 'EUROPE', priority: 22 },
  'serie-a-italia': { name: 'Serie A', country: 'Italy', countryCode: 'IT', region: 'EUROPE', priority: 23 },
  bundesliga: { name: 'Bundesliga', country: 'Germany', countryCode: 'DE', region: 'EUROPE', priority: 24 },
};
const REGION_ORDER = ['BRAZIL', 'SOUTH_AMERICA', 'EUROPE', 'WORLD', 'OTHER'];

// ───────────────────────── persistent state ─────────────────────────
interface Entry { id: number; at: string; type: string; amount: string; balanceAfter: string; referenceType?: string; referenceId?: string; metadata?: Record<string, unknown> }
interface DUser { id: string; email: string; password: string; displayName: string; role: 'USER' | 'ADMIN'; country: string; locale: string; timezone: string; createdAt: string; mfaEnabled: boolean; kycStatus: string }
interface DLeg { id: string; matchId: string; marketKey: string; selection: string; oddsK: number; result: SelectionResult | 'PENDING'; resultVersion: number | null; voidReason: string | null }
interface DBet { id: string; code: string; userId: string; type: 'SINGLE' | 'MULTIPLE'; stake: number; combinedOddsK: number; potentialPayout: number; status: 'OPEN' | 'WON' | 'LOST' | 'VOID'; payout: number | null; settlementVersion: number; placedAt: string; settledAt: string | null; idempotencyKey: string; legs: DLeg[] }
interface DPayment { id: string; userId: string; provider: string; method: string; direction: 'DEPOSIT' | 'WITHDRAWAL'; amount: string; currency: string; status: string; idempotencyKey: string; createdAt: string; nextAction: any; providerRef: string }
interface Override { status: 'FINISHED' | 'CANCELLED' | 'ABANDONED' | 'POSTPONED'; homeGoals: number | null; awayGoals: number | null; version: number }
interface State {
  users: DUser[]; session: string | null; wallets: Record<string, { balance: number; entries: Entry[] }>; bets: DBet[]; payments: DPayment[];
  favorites: { userId: string; kind: string; refId: string }[]; limits: Record<string, Record<string, string | null>>; exclusions: Record<string, { kind: string; endsAt: string | null; startsAt: string }>;
  overrides: Record<string, Override>; audit: { id: number; createdAt: string; action: string; actorRole: string; entityType: string; entityId: string; after: unknown }[]; seq: number;
}

let state: State | null = null;
function load(): State {
  if (state) return state;
  try {
    state = JSON.parse(localStorage.getItem(STORE) ?? 'null');
  } catch {
    state = null;
  }
  if (!state) {
    state = { users: [], session: null, wallets: {}, bets: [], payments: [], favorites: [], limits: {}, exclusions: {}, overrides: {}, audit: [], seq: 1 };
    createUser({ email: 'demo@athosbet.dev', password: 'DemoPlayer2026', displayName: 'Demo', country: 'BR', locale: 'pt', timezone: 'America/Sao_Paulo' }, 'USER');
    createUser({ email: 'admin@athosbet.dev', password: 'AthosAdmin2026', displayName: 'AthosBet Admin', country: 'PT', locale: 'pt', timezone: 'America/Sao_Paulo' }, 'ADMIN');
    save();
  }
  return state!;
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state));
  } catch { /* private mode: state stays in memory */ }
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
function audit(action: string, entityType: string, entityId: string, after?: unknown, actorRole = 'USER') {
  const s = load();
  s.audit.unshift({ id: s.seq++, createdAt: new Date().toISOString(), action, actorRole, entityType, entityId, after });
  s.audit = s.audit.slice(0, 300);
}
function createUser(b: { email: string; password: string; displayName: string; country: string; locale: string; timezone: string }, role: 'USER' | 'ADMIN') {
  const s = state!;
  const u: DUser = { id: uid(), email: b.email.toLowerCase(), password: b.password, displayName: b.displayName, role, country: b.country.toUpperCase(), locale: b.locale, timezone: b.timezone, createdAt: new Date().toISOString(), mfaEnabled: role === 'ADMIN', kycStatus: 'NONE' };
  s.users.push(u);
  s.wallets[u.id] = { balance: 0, entries: [] };
  if (role === 'USER') post(u.id, 'ADJUSTMENT', START_BALANCE, { metadata: { reason: 'SANDBOX_WELCOME_BALANCE' } });
  return u;
}
function post(userId: string, type: string, amount: number, extra: Partial<Entry> = {}) {
  const w = load().wallets[userId];
  w.balance += amount;
  w.entries.unshift({ id: load().seq++, at: new Date().toISOString(), type, amount: String(amount), balanceAfter: String(w.balance), ...extra });
}
function me(): DUser {
  const s = load();
  const u = s.users.find((x) => x.id === s.session);
  if (!u) throw new ApiError(401, 'UNAUTHORIZED');
  return u;
}
const publicUser = (u: DUser) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: 'ACTIVE', country: u.country, locale: u.locale, timezone: u.timezone, kycStatus: u.kycStatus, mfaEnabled: u.mfaEnabled, createdAt: u.createdAt, sessionMfa: true });

// ───────────────────────── sports data & pricing ─────────────────────────
interface Match extends Omit<DemoFixture, 'status'> { status: DemoFixture['status'] | 'ABANDONED' | 'POSTPONED'; slug: string; resultVersion: number; resultSource: string | null }
let cache: { at: number; matches: Match[]; model: RatingModel; history: HistoricalMatch[]; prices: Map<string, PricingResult> } | null = null;
const odds = new Map<number, { matchId: string; marketKey: string; selection: string; oddsK: number }>();

function hash32(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 2_000_000_000 + 1;
}

function data() {
  if (cache && Date.now() - cache.at < 5 * 60_000) return cache;
  const now = new Date();
  const s = load();
  const matches: Match[] = [];
  for (const slug of Object.keys(DEMO_LEAGUES)) {
    for (const f of demoFixtures(slug, new Date(now.getTime() + 15 * DAY), now)) {
      if (f.kickoffAt.getTime() < now.getTime() - 400 * DAY) continue;
      const m: Match = { ...f, slug, resultVersion: f.status === 'FINISHED' || f.status === 'CANCELLED' ? 1 : 0, resultSource: f.status === 'FINISHED' ? 'demo' : null };
      const o = s.overrides[m.providerId];
      if (o) Object.assign(m, { status: o.status, homeGoals: o.homeGoals, awayGoals: o.awayGoals, resultVersion: o.version, resultSource: 'ADMIN' });
      matches.push(m);
    }
  }
  const history: HistoricalMatch[] = matches.filter((m) => m.status === 'FINISHED' && m.homeGoals !== null && m.kickoffAt.getTime() > now.getTime() - 365 * DAY)
    .map((m) => ({ homeId: m.home.providerId, awayId: m.away.providerId, homeGoals: m.homeGoals!, awayGoals: m.awayGoals!, date: m.kickoffAt }));
  const model = fitRatings(history, { asOf: now, maxIter: 80 });
  cache = { at: Date.now(), matches, model, history, prices: new Map() };
  return cache;
}

function price(m: Match): PricingResult {
  const d = data();
  let r = d.prices.get(m.providerId);
  if (!r) {
    r = priceMatch({ model: d.model, homeId: m.home.providerId, awayId: m.away.providerId, context: { history: d.history, asOf: new Date() } });
    d.prices.set(m.providerId, r);
  }
  return r;
}

const isOpen = (m: Match) => m.status === 'SCHEDULED' && m.kickoffAt.getTime() > Date.now();

function marketsOf(m: Match) {
  if (m.status !== 'SCHEDULED') return [];
  const r = price(m);
  if (r.status !== 'OPEN') return [];
  const open = isOpen(m);
  return r.markets.map((mk) => ({
    id: `${m.providerId}|${mk.key}`, key: mk.key, type: mk.type, line: mk.line, status: open ? mk.status : 'CLOSED', suspensionReason: mk.suspensionReason ?? null, version: 1,
    selections: mk.selections.map((s) => {
      const oddsK = Math.round(s.odds * 1000);
      const oddsId = hash32(`${m.providerId}|${mk.key}|${s.key}|${oddsK}`);
      odds.set(oddsId, { matchId: m.providerId, marketKey: mk.key, selection: s.key, oddsK });
      return { key: s.key, oddsId, odds: s.odds, oddsK, version: 1 };
    }),
  }));
}

function team(t: DemoFixture['home']) {
  return { id: t.providerId, name: t.name, shortName: t.shortName, logoUrl: null, primaryColor: t.primaryColor ?? null, secondaryColor: t.secondaryColor ?? null, crestPattern: t.crestPattern ?? null };
}
function competition(slug: string) {
  const c = COMPETITIONS[slug];
  return { id: slug, slug, ...c };
}
function summary(m: Match) {
  const mk = marketsOf(m);
  const main = mk.find((x) => x.key === 'MATCH_RESULT');
  return {
    id: m.providerId, kickoffAt: m.kickoffAt.toISOString(), status: m.status, statusDetail: m.statusDetail, round: m.round, homeGoals: m.homeGoals, awayGoals: m.awayGoals,
    featured: false, provider: 'demo', home: team(m.home), away: team(m.away), competition: competition(m.slug),
    marketCount: mk.filter((x) => x.status === 'OPEN').length,
    mainMarket: main ? { id: main.id, status: main.status, selections: main.selections.map(({ key, oddsId, odds: o, oddsK }) => ({ key, oddsId, odds: o, oddsK })) } : null,
  };
}

const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const addDays = (s: string, n: number) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

function listMatches(q: URLSearchParams) {
  const tz = (() => { const t = q.get('tz') || 'UTC'; try { new Intl.DateTimeFormat('en', { timeZone: t }); return t; } catch { return 'UTC'; } })();
  const filter = q.get('filter') ?? 'week';
  const today = ymd(new Date(), tz);
  const days = filter === 'today' ? [today] : filter === 'tomorrow' ? [addDays(today, 1)] : filter === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(today, i)) : filter === 'date' ? [q.get('date') ?? today] : [];
  const comp = q.get('competition');
  const favOnly = q.get('favorites') === '1';
  const s = load();
  const favs = favOnly ? s.favorites.filter((f) => f.userId === s.session) : [];
  const list = data().matches.filter((m) => {
    if (filter === 'live' ? m.status !== 'LIVE' : !days.includes(ymd(m.kickoffAt, tz))) return false;
    if (comp && m.slug !== comp) return false;
    if (favOnly && !favs.some((f) => f.refId === m.slug || f.refId === m.home.providerId || f.refId === m.away.providerId)) return false;
    return true;
  }).sort((a, b) => COMPETITIONS[a.slug].priority - COMPETITIONS[b.slug].priority || a.kickoffAt.getTime() - b.kickoffAt.getTime());
  const groups = new Map<string, { competition: ReturnType<typeof competition>; matches: ReturnType<typeof summary>[] }>();
  for (const m of list) {
    const g = groups.get(m.slug) ?? { competition: competition(m.slug), matches: [] };
    g.matches.push(summary(m));
    groups.set(m.slug, g);
  }
  const out = [...groups.values()].sort((a, b) => REGION_ORDER.indexOf(a.competition.region) - REGION_ORDER.indexOf(b.competition.region) || a.competition.priority - b.competition.priority);
  return { tz, today, filter, groups: out, total: list.length };
}

function featured() {
  const soon = data().matches.filter((m) => isOpen(m) && m.kickoffAt.getTime() < Date.now() + 72 * 3600_000).map(summary).filter((m) => m.mainMarket?.status === 'OPEN');
  const score = (m: ReturnType<typeof summary>) => {
    const h = m.mainMarket!.selections.find((x) => x.key === 'HOME')?.odds ?? 3, a = m.mainMarket!.selections.find((x) => x.key === 'AWAY')?.odds ?? 3;
    return m.competition.priority * 0.5 + Math.abs(Math.log(h / a)) * 4;
  };
  return soon.sort((a, b) => score(a) - score(b)).slice(0, 8);
}

function findMatch(id: string) {
  const m = data().matches.find((x) => x.providerId === id);
  if (!m) throw new ApiError(404, 'MATCH_NOT_FOUND');
  return m;
}

function matchDetail(id: string) {
  const m = findMatch(id);
  const r = m.status === 'SCHEDULED' ? price(m) : null;
  const form = (tid: string) => data().matches.filter((x) => x.status === 'FINISHED' && x.kickoffAt < m.kickoffAt && (x.home.providerId === tid || x.away.providerId === tid))
    .sort((a, b) => b.kickoffAt.getTime() - a.kickoffAt.getTime()).slice(0, 5)
    .map((x) => { const gf = x.home.providerId === tid ? x.homeGoals! : x.awayGoals!, ga = x.home.providerId === tid ? x.awayGoals! : x.homeGoals!; return gf > ga ? 'W' : gf === ga ? 'D' : 'L'; });
  return {
    ...summary(m), markets: marketsOf(m),
    model: r ? { version: MODEL_VERSION, lambdaHome: r.lambdas.home, lambdaAway: r.lambdas.away, status: r.status, suspensionReason: r.suspensionReason ?? null, external: null, at: new Date().toISOString() } : null,
    form: { home: form(m.home.providerId), away: form(m.away.providerId) },
  };
}

// ───────────────────────── bets & settlement ─────────────────────────
function outcome(m: Match): MatchOutcome | null {
  if (m.status === 'FINISHED' && m.homeGoals !== null && m.awayGoals !== null) return { kind: 'RESULT', homeGoals: m.homeGoals, awayGoals: m.awayGoals };
  if (m.status === 'CANCELLED' || m.status === 'ABANDONED') return { kind: 'VOID' };
  return null;
}

/** Same rules as the API: idempotent per result version, corrections re-settle with reversal. */
function settleAll() {
  const s = load();
  const byId = new Map(data().matches.map((m) => [m.providerId, m]));
  let changed = false;
  for (const b of s.bets) {
    let legChanged = false;
    for (const l of b.legs) {
      const m = byId.get(l.matchId);
      if (!m) continue;
      const o = outcome(m);
      if (!o || (l.result !== 'PENDING' && l.resultVersion === m.resultVersion)) continue;
      const { type, line } = parseMarketKey(l.marketKey);
      l.result = settleSelection(type, line, l.selection, o);
      l.resultVersion = m.resultVersion;
      l.voidReason = o.kind === 'VOID' ? m.status : null;
      legChanged = true;
    }
    if (!legChanged || b.legs.some((l) => l.result === 'PENDING')) continue;
    const r = settleBet(BigInt(b.stake), b.legs.map((l) => ({ oddsK: l.oddsK, result: l.result as SelectionResult })));
    const payout = Number(r.payoutMinor);
    if (b.status !== 'OPEN') {
      if (b.status === r.result && b.payout === payout) continue;
      if (b.payout) post(b.userId, 'BET_RESETTLE_REVERSAL', -b.payout, { referenceType: 'bet', referenceId: b.id });
    }
    if (payout > 0) post(b.userId, 'BET_SETTLE', payout, { referenceType: 'bet', referenceId: b.id });
    else s.wallets[b.userId].entries.unshift({ id: s.seq++, at: new Date().toISOString(), type: 'BET_SETTLE', amount: '0', balanceAfter: String(s.wallets[b.userId].balance), referenceType: 'bet', referenceId: b.id });
    b.status = r.result;
    b.payout = payout;
    b.settlementVersion++;
    b.settledAt = new Date().toISOString();
    changed = true;
  }
  if (changed) save();
}

const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function betView(b: DBet) {
  const byId = new Map(data().matches.map((m) => [m.providerId, m]));
  return {
    id: b.id, code: b.code, type: b.type, status: b.status, stake: String(b.stake), currency: 'ATH', mode: 'SANDBOX', combinedOdds: b.combinedOddsK / 1000,
    potentialPayout: String(b.potentialPayout), payout: b.payout === null ? null : String(b.payout), placedAt: b.placedAt, settledAt: b.settledAt, settlementVersion: b.settlementVersion,
    legs: b.legs.map((l) => {
      const m = byId.get(l.matchId);
      return { id: l.id, matchId: l.matchId, home: m?.home.name ?? '?', away: m?.away.name ?? '?', kickoffAt: m?.kickoffAt.toISOString() ?? '', matchStatus: m?.status ?? 'SCHEDULED', score: m && m.homeGoals !== null ? `${m.homeGoals}-${m.awayGoals}` : null, marketKey: l.marketKey, selection: l.selection, odds: l.oddsK / 1000, result: l.result, voidReason: l.voidReason };
    }),
  };
}

function toMinor(v: unknown): number {
  const s = String(v ?? '').replace(',', '.').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new ApiError(400, 'VALIDATION_FAILED');
  const [i, f = ''] = s.split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}

function placeBet(body: any) {
  const u = me();
  const s = load();
  const dup = s.bets.find((b) => b.userId === u.id && b.idempotencyKey === body.idempotencyKey);
  if (dup) return { ...betView(dup), idempotentReplay: true };
  const ex = s.exclusions[u.id];
  if (ex && (!ex.endsAt || new Date(ex.endsAt) > new Date())) throw new ApiError(403, 'SELF_EXCLUDED');
  const stake = toMinor(body.stake);
  if (stake < 100) throw new ApiError(422, 'STAKE_BELOW_MINIMUM');
  if (stake > 500_000) throw new ApiError(422, 'STAKE_ABOVE_MAXIMUM');
  const maxStake = s.limits[u.id]?.maxStake;
  if (maxStake && stake > Number(maxStake)) throw new ApiError(403, 'STAKE_LIMIT_EXCEEDED');
  const shown = (body.legs as { oddsId: number; odds: number }[]).map((l) => ({ ...l, ref: odds.get(l.oddsId) }));
  if (shown.some((l) => !l.ref)) throw new ApiError(422, 'SELECTION_NOT_FOUND');
  const errs = validateSlip(shown.map((l) => ({ matchId: l.ref!.matchId, marketKey: l.ref!.marketKey, selection: l.ref!.selection })));
  if (errs.length) throw new ApiError(422, 'INVALID_SLIP', errs);
  const changes: { oddsId: number; shownK: number; currentK: number; currentOddsId: number }[] = [];
  const legs = shown.map((l) => {
    const m = findMatch(l.ref!.matchId);
    if (!isOpen(m)) throw new ApiError(422, 'MATCH_NOT_OPEN');
    const mk = marketsOf(m).find((x) => x.key === l.ref!.marketKey);
    if (!mk || mk.status !== 'OPEN') throw new ApiError(422, 'MARKET_NOT_OPEN');
    const cur = mk.selections.find((x) => x.key === l.ref!.selection)!;
    const shownK = Math.round(l.odds * 1000);
    if (cur.oddsK !== shownK) changes.push({ oddsId: l.oddsId, shownK, currentK: cur.oddsK, currentOddsId: cur.oddsId });
    if (!acceptsPriceChange(body.oddsPolicy ?? 'NONE', shownK, cur.oddsK)) return null;
    return { m, mk, cur };
  });
  if (legs.some((x) => x === null)) throw new ApiError(409, 'ODDS_CHANGED', { changes });
  const ks = legs.map((x) => x!.cur.oddsK);
  if (s.wallets[u.id].balance < stake) throw new ApiError(422, 'INSUFFICIENT_FUNDS');
  const bet: DBet = {
    id: uid(), code: 'AB-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (x) => CODE[x % CODE.length]).join(''), userId: u.id, type: legs.length === 1 ? 'SINGLE' : 'MULTIPLE',
    stake, combinedOddsK: Number(combinedOddsK(ks)), potentialPayout: Number(potentialPayout(BigInt(stake), ks)), status: 'OPEN', payout: null, settlementVersion: 0,
    placedAt: new Date().toISOString(), settledAt: null, idempotencyKey: body.idempotencyKey,
    legs: legs.map((x) => ({ id: uid(), matchId: x!.m.providerId, marketKey: x!.mk.key, selection: x!.cur.key, oddsK: x!.cur.oddsK, result: 'PENDING', resultVersion: null, voidReason: null })),
  };
  s.bets.unshift(bet);
  post(u.id, 'BET_PLACE', -stake, { referenceType: 'bet', referenceId: bet.id });
  save();
  return betView(bet);
}

// ───────────────────────── payments (simulated) ─────────────────────────
const METHODS = ['PIX', 'CREDIT_CARD', 'DEBIT_CARD', 'BOLETO', 'BANK_TRANSFER', 'CRYPTO'];
const INSTRUCTIONS: Record<string, Record<string, string>> = {
  PIX: { pixCopyPaste: '00020126SANDBOX-ATHOSBET-STATIC-DEMO5204000053039865802BR6304ABCD', expiresInMinutes: '30' },
  BOLETO: { digitableLine: '00190.00009 01234.567890 12345.678901 1 00000000000000', dueInDays: '3' },
  BANK_TRANSFER: { iban: 'XX00 SAND BOX0 0000 0000 00', reference: 'ATHOSDEMO' },
  CRYPTO: { asset: 'BTC', network: 'bitcoin-testnet', address: 'tb1qsandboxathosbet0000000000000000000000' },
};
function deposit(body: any) {
  const u = me();
  const s = load();
  const dup = s.payments.find((p) => p.userId === u.id && p.idempotencyKey === body.idempotencyKey);
  if (dup) return { payment: dup, nextAction: dup.nextAction, idempotentReplay: true };
  const amount = toMinor(body.amount);
  const card = String(body.method).includes('CARD');
  const declined = card && String(body.card?.number ?? '').replace(/\s/g, '') === '4000000000000002';
  const p: DPayment = {
    id: uid(), userId: u.id, provider: 'sandbox', method: body.method, direction: 'DEPOSIT', amount: String(amount), currency: 'ATH',
    status: card ? (declined ? 'FAILED' : 'COMPLETED') : 'REQUIRES_ACTION', idempotencyKey: body.idempotencyKey, createdAt: new Date().toISOString(),
    nextAction: card ? null : { type: 'DISPLAY_INSTRUCTIONS', instructions: INSTRUCTIONS[body.method] }, providerRef: `sbx_${uid()}`,
  };
  s.payments.unshift(p);
  if (p.status === 'COMPLETED') post(u.id, 'DEPOSIT', amount, { referenceType: 'payment', referenceId: p.id });
  save();
  return { payment: p, nextAction: p.nextAction, instructions: p.nextAction?.instructions ?? null };
}
function simulate(id: string) {
  const u = me();
  const p = load().payments.find((x) => x.id === id && x.userId === u.id);
  if (!p) throw new ApiError(404, 'PAYMENT_NOT_FOUND');
  if (p.status !== 'COMPLETED') {
    p.status = 'COMPLETED';
    p.nextAction = null;
    post(u.id, 'DEPOSIT', Number(p.amount), { referenceType: 'payment', referenceId: p.id });
    save();
  }
  return { duplicate: false, matched: true };
}
function withdraw(body: any) {
  const u = me();
  const s = load();
  const dup = s.payments.find((p) => p.userId === u.id && p.idempotencyKey === body.idempotencyKey);
  if (dup) return { payment: dup, idempotentReplay: true };
  const amount = toMinor(body.amount);
  if (s.wallets[u.id].balance < amount) throw new ApiError(422, 'INSUFFICIENT_FUNDS');
  const p: DPayment = { id: uid(), userId: u.id, provider: 'sandbox', method: body.method, direction: 'WITHDRAWAL', amount: String(amount), currency: 'ATH', status: 'COMPLETED', idempotencyKey: body.idempotencyKey, createdAt: new Date().toISOString(), nextAction: null, providerRef: `sbx_po_${uid()}` };
  s.payments.unshift(p);
  post(u.id, 'WITHDRAWAL_REQUEST', -amount, { referenceType: 'payment', referenceId: p.id });
  save();
  return { payment: p };
}

// ───────────────────────── admin (read-mostly) ─────────────────────────
function requireAdmin() {
  const u = me();
  if (u.role === 'USER') throw new ApiError(403, 'INSUFFICIENT_ROLE');
  return u;
}
function dashboard() {
  const s = load();
  const settled = s.bets.filter((b) => b.status !== 'OPEN');
  const open = s.bets.filter((b) => b.status === 'OPEN');
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const volume = sum(s.bets.map((b) => b.stake));
  const payouts = sum(settled.map((b) => b.payout ?? 0));
  const settledStake = sum(settled.map((b) => b.stake));
  const dayMs = (d: number) => new Date(new Date().setHours(0, 0, 0, 0) - d * DAY);
  const series = Array.from({ length: 14 }, (_, i) => {
    const from = dayMs(13 - i), to = new Date(from.getTime() + DAY);
    const inDay = (t: string | null) => !!t && new Date(t) >= from && new Date(t) < to;
    return { day: from.toISOString().slice(0, 10), volume: String(sum(s.bets.filter((b) => inDay(b.placedAt)).map((b) => b.stake))), ggr: String(sum(settled.filter((b) => inDay(b.settledAt)).map((b) => b.stake - (b.payout ?? 0)))) };
  });
  const exposure = new Map<string, any>();
  for (const b of open) for (const l of b.legs.filter((x) => x.result === 'PENDING')) {
    const k = `${l.matchId}|${l.marketKey}|${l.selection}`;
    const m = data().matches.find((x) => x.providerId === l.matchId);
    const e = exposure.get(k) ?? { match_id: l.matchId, market_id: `${l.matchId}|${l.marketKey}`, market_key: l.marketKey, selection: l.selection, home: m?.home.name, away: m?.away.name, open_bets: 0, liability: 0 };
    e.open_bets++;
    e.liability += b.potentialPayout;
    exposure.set(k, e);
  }
  const upcoming = data().matches.filter((m) => isOpen(m) && m.kickoffAt.getTime() < Date.now() + 7 * DAY);
  return {
    kpis: {
      users: { total: s.users.length, new24h: s.users.filter((u) => new Date(u.createdAt).getTime() > Date.now() - DAY).length, staff: s.users.filter((u) => u.role !== 'USER').length },
      bets: { open: open.length, settled: settled.length, open_stake: String(sum(open.map((b) => b.stake))), open_liability: String(sum(open.map((b) => b.potentialPayout))), bets24h: 0 },
      money: { volume: String(volume), volume24h: '0', volume7d: '0', payouts: String(payouts), ggr: String(settledStake - payouts), settled_stake: String(settledStake), holdPercent: settledStake ? Math.round(((settledStake - payouts) / settledStake) * 10000) / 100 : null },
      markets: { open: upcoming.length * 12, suspended: 0, closed: 0, settled: 0, current_prices: upcoming.length * 52 },
      matches: { upcoming7d: upcoming.length, live: data().matches.filter((m) => m.status === 'LIVE').length, disrupted: 0 },
      payments: { deposits: String(sum(s.payments.filter((p) => p.direction === 'DEPOSIT' && p.status === 'COMPLETED').map((p) => Number(p.amount)))), withdrawals: String(sum(s.payments.filter((p) => p.direction === 'WITHDRAWAL').map((p) => Number(p.amount)))), pending_review: 0, failed: 0 },
      sync: { errors24h: 0, last_success: new Date().toISOString() },
      ledger: { house_pnl: String(settledStake - payouts), player_balances: String(sum(Object.values(s.wallets).map((w) => w.balance))) },
      currency: 'ATH', mode: 'SANDBOX',
    },
    series,
    exposure: [...exposure.values()].sort((a, b) => b.liability - a.liability).slice(0, 10).map((e) => ({ ...e, liability: String(e.liability) })),
  };
}
function adminMatches() {
  const s = load();
  return data().matches.filter((m) => m.kickoffAt.getTime() > Date.now() - 3 * DAY && m.kickoffAt.getTime() < Date.now() + 14 * DAY).sort((a, b) => a.kickoffAt.getTime() - b.kickoffAt.getTime()).slice(0, 300).map((m) => ({
    id: m.providerId, kickoff_at: m.kickoffAt.toISOString(), status: m.status, home_goals: m.homeGoals, away_goals: m.awayGoals, result_version: m.resultVersion, result_source: m.resultSource,
    featured: false, competition: COMPETITIONS[m.slug].name, home: m.home.name, away: m.away.name, open_markets: isOpen(m) ? 12 : 0, suspended_markets: 0,
    bets: s.bets.filter((b) => b.legs.some((l) => l.matchId === m.providerId)).length,
  }));
}
function setResult(id: string, body: any) {
  requireAdmin();
  const m = findMatch(id);
  const s = load();
  const prev = s.overrides[id];
  s.overrides[id] = { status: body.status, homeGoals: body.status === 'FINISHED' ? Number(body.homeGoals) : null, awayGoals: body.status === 'FINISHED' ? Number(body.awayGoals) : null, version: (prev?.version ?? m.resultVersion) + 1 };
  audit('admin.sandbox.result', 'match', id, body, 'ADMIN');
  cache = null;
  save();
  const before = s.bets.filter((b) => b.status === 'OPEN').length;
  settleAll();
  return { match: findMatch(id), settlement: { matchId: id, betsSettled: before - s.bets.filter((b) => b.status === 'OPEN').length } };
}

// ───────────────────────── router ─────────────────────────
export async function handle(method: string, fullPath: string, body: any): Promise<any> {
  const url = new URL(fullPath, 'http://demo');
  const p = url.pathname;
  const q = url.searchParams;
  const s = load();
  let m: RegExpMatchArray | null;
  if (method === 'GET') settleAll();

  // public
  if (method === 'GET' && p === '/meta') return { dataProvider: 'demo', synthetic: true, realMoney: false, staticDemo: true, marketRules: MARKET_RULES };
  if (method === 'GET' && p === '/health') return { status: 'ok' };
  if (method === 'GET' && p === '/competitions') return Object.keys(COMPETITIONS).map((slug) => ({ ...competition(slug), type: 'LEAGUE', bettingEnabled: true, coverageStatus: 'UNVERIFIED', logoUrl: null })).sort((a, b) => a.priority - b.priority);
  if (method === 'GET' && p === '/matches') return listMatches(q);
  if (method === 'GET' && p === '/matches/featured') return featured();
  if (method === 'GET' && (m = p.match(/^\/matches\/(.+)$/))) return matchDetail(decodeURIComponent(m[1]));

  // auth
  if (method === 'POST' && p === '/auth/register') {
    if (s.users.some((u) => u.email === String(body.email).toLowerCase())) throw new ApiError(409, 'EMAIL_TAKEN');
    const dob = new Date(body.dateOfBirth);
    if (Number.isNaN(dob.getTime()) || Date.now() - dob.getTime() < 18 * 365.25 * DAY) throw new ApiError(403, 'UNDERAGE');
    if (!body.password || String(body.password).length < 10) throw new ApiError(400, 'VALIDATION_FAILED');
    const u = createUser({ email: body.email, password: body.password, displayName: body.displayName, country: body.country ?? 'BR', locale: body.locale ?? 'pt', timezone: body.timezone ?? 'UTC' }, 'USER');
    s.session = u.id;
    audit('auth.register', 'user', u.id);
    save();
    return { user: publicUser(u) };
  }
  if (method === 'POST' && p === '/auth/login') {
    const u = s.users.find((x) => x.email === String(body.email).toLowerCase() && x.password === body.password);
    if (!u) throw new ApiError(401, 'INVALID_CREDENTIALS');
    s.session = u.id;
    audit('auth.login', 'user', u.id, undefined, u.role);
    save();
    return { user: publicUser(u) };
  }
  if (method === 'POST' && p === '/auth/logout') { s.session = null; save(); return undefined; }
  if (method === 'POST' && p === '/auth/refresh') { me(); return {}; }
  if (method === 'GET' && p === '/auth/me') return publicUser(me());
  if (method === 'POST' && p === '/auth/password/forgot') return { ok: true };
  if (method === 'POST' && (p === '/auth/password/reset' || p.startsWith('/auth/mfa'))) throw new ApiError(400, 'GENERIC');

  // player
  if (method === 'GET' && p === '/wallet') return { currency: 'ATH', mode: 'SANDBOX', balance: String(s.wallets[me().id].balance), realMoney: false };
  if (method === 'GET' && p === '/wallet/statement') return s.wallets[me().id].entries.slice(0, 100);
  if (method === 'GET' && p === '/payments/methods') { me(); return METHODS.map((x) => ({ method: x, deposit: true, withdrawal: true, provider: 'sandbox', currency: 'ATH' })); }
  if (method === 'GET' && p === '/payments') { const u = me(); return s.payments.filter((x) => x.userId === u.id).map((x) => ({ ...x, metadata: { instructions: x.nextAction?.instructions ?? null } })); }
  if (method === 'POST' && p === '/payments/deposits') return deposit(body);
  if (method === 'POST' && p === '/payments/withdrawals') return withdraw(body);
  if (method === 'POST' && (m = p.match(/^\/payments\/([^/]+)\/simulate$/))) return simulate(m[1]);
  if (method === 'POST' && p === '/bets') return placeBet(body);
  if (method === 'GET' && p === '/bets') {
    const u = me();
    const st = q.get('status');
    return s.bets.filter((b) => b.userId === u.id && (!st || (st === 'OPEN' ? b.status === 'OPEN' : b.status !== 'OPEN'))).slice(0, 50).map(betView);
  }
  if (method === 'GET' && (m = p.match(/^\/bets\/(.+)$/))) { const b = s.bets.find((x) => x.id === m![1] && x.userId === me().id); if (!b) throw new ApiError(404, 'BET_NOT_FOUND'); return betView(b); }
  if (method === 'GET' && p === '/favorites') { const u = me(); return s.favorites.filter((f) => f.userId === u.id); }
  if (method === 'POST' && (m = p.match(/^\/favorites\/([^/]+)\/(.+)$/))) {
    const u = me();
    const kind = m[1].toUpperCase(), refId = decodeURIComponent(m[2]);
    const i = s.favorites.findIndex((f) => f.userId === u.id && f.kind === kind && f.refId === refId);
    if (i >= 0) s.favorites.splice(i, 1); else s.favorites.push({ userId: u.id, kind, refId });
    save();
    return { favorite: i < 0 };
  }
  if (method === 'PATCH' && p === '/account/profile') { const u = me(); Object.assign(u, { ...(body.locale ? { locale: body.locale } : {}), ...(body.timezone ? { timezone: body.timezone } : {}), ...(body.displayName ? { displayName: body.displayName } : {}) }); save(); return publicUser(u); }
  if (method === 'GET' && p === '/account/limits') return s.limits[me().id] ?? {};
  if (method === 'PATCH' && p === '/account/limits') {
    const u = me();
    const cur = s.limits[u.id] ?? {};
    for (const [k, v] of Object.entries(body)) cur[k] = v === null || v === '' ? null : String(toMinor(v));
    s.limits[u.id] = cur;
    audit('rg.limits.update', 'user', u.id, body);
    save();
    return cur;
  }
  if (method === 'GET' && p === '/account/exclusion') { const e = s.exclusions[me().id]; return { active: e && (!e.endsAt || new Date(e.endsAt) > new Date()) ? e : null }; }
  if (method === 'POST' && p === '/account/exclusion') {
    const u = me();
    s.exclusions[u.id] = { kind: body.kind, startsAt: new Date().toISOString(), endsAt: body.days ? new Date(Date.now() + body.days * DAY).toISOString() : null };
    audit(`rg.${String(body.kind).toLowerCase()}`, 'user', u.id, body);
    save();
    return s.exclusions[u.id];
  }
  if (method === 'GET' && p === '/account/jurisdiction') { const u = me(); return { requestCountry: 'XX', accountCountry: u.country, request: 'SANDBOX_ONLY', account: 'SANDBOX_ONLY', realMoneyAvailable: false }; }

  // admin
  if (p.startsWith('/admin')) {
    requireAdmin();
    if (method === 'GET' && p === '/admin/dashboard') return dashboard();
    if (method === 'GET' && p === '/admin/exposure') return dashboard().exposure;
    if (method === 'GET' && p === '/admin/ledger/reconcile') return { ok: true, checkedAt: new Date().toISOString(), accountMismatches: [], unbalancedTransactions: [], totals: [] };
    if (method === 'GET' && p === '/admin/matches') return adminMatches();
    if (method === 'POST' && (m = p.match(/^\/admin\/sandbox\/matches\/(.+)\/result$/))) return setResult(decodeURIComponent(m[1]), body);
    if (method === 'GET' && p === '/admin/audit') return s.audit;
    if (method === 'GET' && p === '/admin/users') return s.users.map((u) => ({ id: u.id, email: u.email, displayName: u.displayName, role: u.role, status: 'ACTIVE', country: u.country, kycStatus: u.kycStatus, mfaEnabled: u.mfaEnabled, createdAt: u.createdAt }));
    if (method === 'GET' && p === '/admin/payments') return s.payments;
    if (method === 'GET' && p === '/admin/settings') return { pricing: DEFAULT_PRICING_CONFIG, risk: { minStake: 100, maxStake: 500000, maxPayout: 10000000, maxLiabilityPerSelection: 20000000, maxLegs: 12, largeWithdrawalReview: 1000000, largeDepositFlag: 1000000 }, realMoneyEnabled: false, dataProvider: 'demo' };
    if (method === 'GET' && p === '/admin/competitions') return Object.keys(COMPETITIONS).map((slug) => ({ ...competition(slug), providerId: slug, enabled: true, bettingEnabled: true, coverageStatus: 'UNVERIFIED' }));
    if (method === 'GET' && p === '/admin/payments/providers') return [{ name: 'paysafe', mode: 'SANDBOX', configured: false }, { name: 'nuvei', mode: 'SANDBOX', configured: false }, { name: 'sandbox', mode: 'SANDBOX', configured: true }];
    if (method === 'GET' && p === '/admin/teams') {
      const t = new Map<string, any>();
      for (const x of data().matches) for (const tm of [x.home, x.away]) t.set(tm.providerId, { ...team(tm), logoSource: null });
      return [...t.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    if (method === 'GET') return [];
    throw new ApiError(400, 'DEMO_READ_ONLY');
  }
  throw new ApiError(404, 'NOT_FOUND');
}
