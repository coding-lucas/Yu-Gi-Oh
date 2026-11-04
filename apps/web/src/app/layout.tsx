import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'AthosBet', template: '%s · AthosBet' },
  description: 'AthosBet — football betting platform (sandbox)',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon-192.png' },
  appleWebApp: { capable: true, title: 'AthosBet', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = { themeColor: '#090D12', width: 'device-width', initialScale: 1, viewportFit: 'cover' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
