import { CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { config } from '../config';
import { err } from './errors';

export type Role = 'USER' | 'SUPPORT' | 'RISK' | 'ADMIN';
export const STAFF_ROLES: Role[] = ['SUPPORT', 'RISK', 'ADMIN'];

export interface AuthUser {
  id: string;
  role: Role;
  mfa: boolean;
}

export interface AccessClaims {
  sub: string;
  role: Role;
  mfa: boolean;
  typ: 'access';
}

export const ACCESS_TTL_SECONDS = 15 * 60;
export const ACCESS_COOKIE = 'ab_at';
export const REFRESH_COOKIE = 'ab_rt';
export const CSRF_HEADER = 'x-athos-csrf';

export function signAccess(u: AuthUser): string {
  const claims: AccessClaims = { sub: u.id, role: u.role, mfa: u.mfa, typ: 'access' };
  return jwt.sign(claims, config().JWT_SECRET, { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS, issuer: 'athosbet' });
}

export function verifyAccess(token: string): AuthUser | null {
  try {
    const c = jwt.verify(token, config().JWT_SECRET, { algorithms: ['HS256'], issuer: 'athosbet' }) as AccessClaims;
    if (c.typ !== 'access') return null;
    return { id: c.sub, role: c.role, mfa: !!c.mfa };
  } catch {
    return null;
  }
}

const PUBLIC = 'isPublic';
const ROLES = 'roles';
export const Public = () => SetMetadata(PUBLIC, true);
/** Staff routes: requires one of the roles AND a session that passed MFA. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export type AuthedRequest = Request & { user?: AuthUser; authVia?: 'cookie' | 'bearer' };

export function extractUser(req: AuthedRequest): AuthUser | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) {
    req.authVia = 'bearer';
    return verifyAccess(h.slice(7));
  }
  const c = (req as any).cookies?.[ACCESS_COOKIE];
  if (c) {
    req.authVia = 'cookie';
    return verifyAccess(c);
  }
  return null;
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    const user = extractUser(req);
    if (user) req.user = user;
    // CSRF: cookie-authenticated state changes must carry a custom header, which a cross-site form
    // cannot set without passing CORS pre-flight.
    if (!SAFE.has(req.method) && req.authVia === 'cookie' && req.headers[CSRF_HEADER] !== '1') {
      throw err.forbidden('CSRF_HEADER_MISSING');
    }
    if (isPublic) return true;
    if (!user) throw err.unauthorized();
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, [ctx.getHandler(), ctx.getClass()]);
    if (roles?.length) {
      if (!roles.includes(user.role)) throw err.forbidden('INSUFFICIENT_ROLE');
      if (STAFF_ROLES.includes(user.role) && !user.mfa) throw err.forbidden('MFA_REQUIRED');
    }
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw err.unauthorized();
  return req.user;
});

export interface ClientInfo {
  ip: string | null;
  country: string;
  userAgent: string | null;
}

/** Country comes only from trusted edge headers — never from the UI language or user input. */
export function clientInfo(req: Request): ClientInfo {
  const cfg = config();
  let country = cfg.DEFAULT_COUNTRY;
  if (cfg.TRUST_GEO_HEADER) {
    const h = (req.headers['cf-ipcountry'] || req.headers['x-vercel-ip-country']) as string | undefined;
    if (h && /^[A-Za-z]{2}$/.test(h)) country = h.toUpperCase();
  }
  return { ip: req.ip ?? null, country, userAgent: (req.headers['user-agent'] as string) ?? null };
}

export const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => clientInfo(ctx.switchToHttp().getRequest()));
