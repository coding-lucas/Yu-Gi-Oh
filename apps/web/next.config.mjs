import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
/** Static demo (GitHub Pages): no server, in-browser backend, static export under a base path. */
const STATIC_DEMO = process.env.NEXT_PUBLIC_STATIC_DEMO === '1';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

async function rewrites() {
  // Same-origin API proxy: httpOnly auth cookies never leave the first-party origin.
  return [{ source: '/api/:path*', destination: `${API_URL}/api/:path*` }];
}

async function headers() {
  return [{
    source: '/:path*',
    headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ],
  }];
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@athosbet/shared', '@athosbet/odds-engine'],
  ...(STATIC_DEMO
    ? { output: 'export', basePath: BASE_PATH, trailingSlash: true, images: { unoptimized: true } }
    : { rewrites, headers }),
};

export default withNextIntl(nextConfig);
