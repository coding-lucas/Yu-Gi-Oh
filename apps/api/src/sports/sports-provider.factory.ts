import { config } from '../config';
import { ApiFootballProvider } from './providers/api-football.provider';
import { DemoProvider } from './providers/demo.provider';
import { SportsProvider } from './providers/types';

export const SPORTS_PROVIDER = Symbol('SPORTS_PROVIDER');

export function createSportsProvider(): SportsProvider {
  const c = config();
  if (c.SPORTS_PROVIDER === 'api-football') {
    if (!c.API_FOOTBALL_KEY) throw new Error('SPORTS_PROVIDER=api-football requires API_FOOTBALL_KEY');
    return new ApiFootballProvider(c.API_FOOTBALL_KEY, c.API_FOOTBALL_BASE_URL);
  }
  return new DemoProvider(c.SANDBOX_SIMULATE_RESULTS);
}
