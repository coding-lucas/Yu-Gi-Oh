/**
 * k6 load test — browse + bet placement under concurrency.
 *   k6 run -e BASE=http://localhost:4000 -e VUS=50 tests/load/bet-placement.k6.js
 * Thresholds encode the SLOs documented in ARCHITECTURE.md.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:4000';
export const options = {
  scenarios: { players: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: '30s', target: Number(__ENV.VUS || 50) }, { duration: '1m', target: Number(__ENV.VUS || 50) }, { duration: '15s', target: 0 }] } },
  thresholds: { http_req_failed: ['rate<0.01'], 'http_req_duration{name:matches}': ['p(95)<400'], 'http_req_duration{name:bet}': ['p(95)<600'] },
};

export function setup() {
  const list = http.get(`${BASE}/api/matches?filter=week&tz=UTC`).json();
  const sels = list.groups.flatMap((g) => g.matches).filter((m) => m.mainMarket && m.mainMarket.status === 'OPEN').flatMap((m) => m.mainMarket.selections);
  return { sels };
}

export default function (data) {
  const email = `load_${__VU}_${__ITER}_${Date.now()}@k6.dev`;
  const reg = http.post(`${BASE}/api/auth/register`, JSON.stringify({ email, password: 'LoadTest2026', displayName: 'k6 user', dateOfBirth: '1990-01-01', country: 'GB', acceptTerms: true }), { headers: { 'content-type': 'application/json' } });
  check(reg, { registered: (r) => r.status === 201 });
  const token = reg.json('accessToken');
  const h = { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } };
  for (let i = 0; i < 5; i++) {
    http.get(`${BASE}/api/matches?filter=today&tz=UTC`, { tags: { name: 'matches' } });
    const s = data.sels[Math.floor(Math.random() * data.sels.length)];
    const r = http.post(`${BASE}/api/bets`, JSON.stringify({ legs: [{ oddsId: s.oddsId, odds: s.odds }], stake: '2.00', idempotencyKey: `${email}-${i}`, oddsPolicy: 'ANY' }), { ...h, tags: { name: 'bet' } });
    check(r, { 'bet accepted or cleanly rejected': (x) => [201, 409, 422].includes(x.status) });
    sleep(Math.random());
  }
}
