import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { LOCALES } from '@athosbet/shared';
import { ZodPipe } from '../common/zod';
import { ACCESS_COOKIE, ACCESS_TTL_SECONDS, AuthUser, Client, ClientInfo, CurrentUser, Public, REFRESH_COOKIE } from '../common/auth';
import { AuthService, REFRESH_TTL_DAYS, Session } from './auth.service';
import { config } from '../config';
import { err } from '../common/errors';

const password = z.string().min(10).max(200).regex(/[A-Za-z]/).regex(/\d/);
const RegisterSchema = z.object({
  email: z.string().email().max(200),
  password,
  displayName: z.string().trim().min(2).max(40),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  country: z.string().regex(/^[A-Za-z]{2}$/),
  locale: z.enum(LOCALES).default('en'),
  timezone: z.string().max(64).default('UTC'),
  acceptTerms: z.literal(true),
});
const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(200), totp: z.string().regex(/^\d{6}$/).optional() });

function setCookies(res: Response, s: Session) {
  const secure = config().COOKIE_SECURE;
  res.cookie(ACCESS_COOKIE, s.accessToken, { httpOnly: true, sameSite: 'lax', secure, maxAge: ACCESS_TTL_SECONDS * 1000, path: '/' });
  res.cookie(REFRESH_COOKIE, s.refreshToken, { httpOnly: true, sameSite: 'strict', secure, maxAge: REFRESH_TTL_DAYS * 86_400_000, path: '/api/auth' });
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  async register(@Body(new ZodPipe(RegisterSchema)) body: z.infer<typeof RegisterSchema>, @Client() c: ClientInfo, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.register(body, c.ip, c.country);
    setCookies(res, s);
    return s;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('login')
  async login(@Body(new ZodPipe(LoginSchema)) body: z.infer<typeof LoginSchema>, @Client() c: ClientInfo, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.login(body.email, body.password, body.totp, c.ip);
    setCookies(res, s);
    return s;
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  async refresh(@Req() req: Request, @Body() body: { refreshToken?: string }, @Res({ passthrough: true }) res: Response) {
    const token = (req as any).cookies?.[REFRESH_COOKIE] ?? body?.refreshToken;
    if (!token) throw err.unauthorized('INVALID_REFRESH');
    const s = await this.auth.refresh(token);
    setCookies(res, s);
    return s;
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout((req as any).cookies?.[REFRESH_COOKIE]);
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.auth.me(u.id).then((p) => ({ ...p, sessionMfa: u.mfa }));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('password/forgot')
  async forgot(@Body(new ZodPipe(z.object({ email: z.string().email() }))) b: { email: string }) {
    const r = await this.auth.forgotPassword(b.email);
    return { ok: true, ...r };
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('password/reset')
  async reset(@Body(new ZodPipe(z.object({ token: z.string().min(10), password }))) b: { token: string; password: string }) {
    await this.auth.resetPassword(b.token, b.password);
    return { ok: true };
  }

  @Post('mfa/setup')
  mfaSetup(@CurrentUser() u: AuthUser) {
    return this.auth.mfaSetup(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('mfa/enable')
  async mfaEnable(@CurrentUser() u: AuthUser, @Body(new ZodPipe(z.object({ code: z.string().regex(/^\d{6}$/) }))) b: { code: string }, @Client() c: ClientInfo, @Res({ passthrough: true }) res: Response) {
    const s = await this.auth.mfaEnable(u.id, b.code, c.ip);
    setCookies(res, s);
    return s;
  }
}
