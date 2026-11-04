import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

/** Detects the language from Accept-Language / cookie. Language never affects jurisdiction. */
export default createMiddleware(routing);

export const config = { matcher: ['/((?!api|_next|icons|.*\\..*).*)'] };
