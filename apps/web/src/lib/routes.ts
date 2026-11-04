import { STATIC_DEMO } from './api';

/** Static export cannot pre-render unknown match ids, so the demo build uses /match?id=… */
export function matchHref(id: string) {
  return STATIC_DEMO ? `/match?id=${encodeURIComponent(id)}` : `/match/${encodeURIComponent(id)}`;
}
