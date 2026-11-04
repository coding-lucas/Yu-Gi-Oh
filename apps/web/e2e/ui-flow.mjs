/**
 * UI end-to-end smoke (Playwright): language detection, RTL, match board, bet slip, bet placement,
 * admin MFA login, sandbox result and settlement visible to the player.
 * Usage: BASE_URL=http://localhost:3000 ADMIN_TOTP_SECRET=... node e2e/ui-flow.mjs [screenshotDir]
 */
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const OUT = process.argv[2] ?? null;
const SECRET = process.env.ADMIN_TOTP_SECRET ?? 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0; const out = [];
  for (const c of secret) { val = (val << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', Buffer.from(out)).update(msg).digest(); const o = h[h.length - 1] & 15;
  return (((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).toString().padStart(6, '0');
}
const shot = async (page, name) => OUT && page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
const assert = (c, m) => { if (!c) throw new Error(`ASSERTION FAILED: ${m}`); console.log(`✓ ${m}`); };

const browser = await chromium.launch();
try {
  // 1. mobile, Portuguese via Accept-Language
  const mobile = await browser.newContext({ ...devices['iPhone 13'], locale: 'pt-BR', extraHTTPHeaders: { 'accept-language': 'pt-BR,pt;q=0.9' } });
  const page = await mobile.newPage();
  await page.goto(BASE + '/');
  assert(page.url().includes('/pt'), 'language auto-detected (pt)');
  await page.getByText('Futebol brasileiro').first().waitFor({ timeout: 20000 });
  assert(await page.getByText('Brasileirão Série A').first().isVisible(), 'Brasileirão listed');
  await shot(page, '01-mobile-home-pt');

  // register
  const email = `ui${Date.now()}@athosbet.dev`;
  await page.goto(BASE + '/pt/register');
  await page.locator('input').nth(0).fill('Torcedor UI');
  await page.locator('input[type=email]').fill(email);
  await page.locator('input[type=password]').fill('UiTest2026pass');
  await page.locator('input[type=date]').fill('1990-02-02');
  await page.locator('input[type=checkbox]').check();
  await page.getByRole('main').getByRole('button', { name: 'Cadastrar' }).click();
  await page.waitForURL(/\/pt$/, { timeout: 15000 });
  await page.getByText(/ATH/).first().waitFor();
  assert(true, 'registered & logged in, sandbox balance shown');

  // add first open 1X2 home odds to slip
  await page.goto(BASE + '/pt');
  await page.getByText('Futebol brasileiro').first().waitFor({ timeout: 20000 });
  await shot(page, '01b-mobile-logged-in');
  const oddsBtn = page.locator('main button[aria-pressed="false"]:not([disabled])').filter({ hasText: /^1\s*\d/ }).first();
  await oddsBtn.click();
  await page.getByRole('button', { name: /Bilhete/ }).click();
  await page.getByRole('dialog').waitFor();
  await shot(page, '02-mobile-betslip');
  await page.getByRole('dialog').getByRole('button', { name: 'Fazer aposta' }).click();
  await page.getByText(/Aposta feita! Código AB-/).waitFor({ timeout: 15000 });
  assert(true, 'bet placed from the mobile slip');
  await page.goto(BASE + '/pt/bets');
  await page.getByText(/AB-/).first().waitFor();
  await shot(page, '03-mobile-my-bets');
  const matchHref = await page.evaluate(async () => {
    const r = await fetch('/api/bets?status=OPEN', { credentials: 'include' }); const b = await r.json(); return b[0].legs[0].matchId;
  });

  // 2. desktop admin with MFA → set result
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
  const ap = await desk.newPage();
  await ap.goto(BASE + '/en/login');
  await ap.locator('input[type=email]').fill('admin@athosbet.dev');
  await ap.locator('input[type=password]').fill(process.env.ADMIN_PASSWORD ?? 'AthosAdmin2026');
  await ap.getByRole('main').getByRole('button', { name: 'Log in' }).click();
  await ap.locator('input[autocomplete=one-time-code]').waitFor();
  await ap.locator('input[autocomplete=one-time-code]').fill(totp(SECRET));
  await ap.getByRole('main').getByRole('button', { name: 'Log in' }).click();
  await ap.waitForURL(/admin/, { timeout: 15000 });
  await ap.getByText('Volume').first().waitFor({ timeout: 15000 });
  await shot(ap, '04-desktop-admin');
  const res = await ap.evaluate(async (id) => {
    const r = await fetch(`/api/admin/sandbox/matches/${id}/result`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-athos-csrf': '1' }, body: JSON.stringify({ status: 'FINISHED', homeGoals: 3, awayGoals: 0 }) });
    return r.json();
  }, matchHref);
  assert(res.settlement && res.settlement.betsSettled >= 1, 'admin set official result → automatic settlement');

  // 3. player sees the win
  await page.goto(BASE + '/pt/bets');
  await page.getByRole('tab', { name: 'Liquidadas' }).click();
  await page.getByText('Ganha').first().waitFor({ timeout: 15000 });
  assert(true, 'player sees settled WON bet');
  await shot(page, '05-mobile-settled');

  // 4. desktop home + match page + Arabic RTL
  const dp = await desk.newPage();
  await dp.goto(BASE + '/en');
  await dp.getByText('Featured matches').waitFor();
  await shot(dp, '06-desktop-home');
  await dp.locator('a[href*="/match/"]').first().click();
  await dp.getByText('Correct score').waitFor({ timeout: 15000 });
  await shot(dp, '07-desktop-match');
  await dp.goto(BASE + '/ar');
  assert((await dp.locator('html').getAttribute('dir')) === 'rtl', 'Arabic renders RTL');
  await dp.getByText('مباريات مميزة').waitFor();
  await shot(dp, '08-desktop-home-ar');
  const ja = await desk.newPage();
  await ja.goto(BASE + '/ja');
  await ja.getByText('注目の試合').waitFor();
  assert(true, 'Japanese locale renders');
  console.log('UI FLOW OK');
} finally {
  await browser.close();
}
