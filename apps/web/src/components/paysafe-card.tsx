'use client';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from 'lucide-react';
import { Button } from './ui/button';

declare global {
  interface Window { paysafe?: any }
}

const SDK_URL = 'https://hosted.paysafe.com/js/v1/latest/paysafe.min.js';

function loadSdk(): Promise<any> {
  if (window.paysafe) return Promise.resolve(window.paysafe);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SDK_URL;
    s.async = true;
    s.onload = () => resolve(window.paysafe);
    s.onerror = () => reject(new Error('Paysafe.js failed to load'));
    document.head.appendChild(s);
  });
}

/**
 * Paysafe.js hosted card fields (PCI DSS SAQ-A): card data is captured in Paysafe iframes and
 * exchanged for a single-use payment handle token, which is the only thing sent to AthosBet.
 * The setup/tokenize options mirror the backend's TOKENIZE_CARD next action; confirm field names
 * against the Paysafe.js reference during homologation.
 */
export function PaysafeCardFields({ sdk, onToken }: { sdk: Record<string, any>; onToken: (token: string) => Promise<void> }) {
  const t = useTranslations('wallet');
  const instance = useRef<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadSdk()
      .then((paysafe) => paysafe.fields.setup(sdk.apiKey, {
        environment: sdk.environment,
        fields: { cardNumber: { selector: '#ps-card', placeholder: '•••• •••• •••• ••••' }, expiryDate: { selector: '#ps-exp', placeholder: 'MM / YY' }, cvv: { selector: '#ps-cvv', placeholder: 'CVV' } },
        style: { input: { color: '#F0F4F8', 'font-size': '14px' } },
      }))
      .then((i: any) => (cancelled ? null : i.show().then(() => (instance.current = i))))
      .catch((e: Error) => setError(e.message));
    return () => { cancelled = true; };
  }, [sdk.apiKey, sdk.environment]);

  const field = 'h-11 rounded-xl border border-line bg-bg px-3 py-3';
  return (
    <div className="space-y-2">
      <div id="ps-card" className={field} />
      <div className="grid grid-cols-2 gap-2"><div id="ps-exp" className={field} /><div id="ps-cvv" className={field} /></div>
      <p className="flex items-center gap-1.5 text-[11px] text-muted"><ShieldCheck className="h-3.5 w-3.5 text-emerald" />{t('cardSecure')}</p>
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button className="w-full" variant="emerald" disabled={busy || !!error} onClick={async () => {
        if (!instance.current) return;
        setBusy(true);
        try {
          const r = await instance.current.tokenize({ amount: sdk.amount, transactionType: sdk.transactionType, paymentType: sdk.paymentType, merchantRefNum: sdk.merchantRefNum, currencyCode: sdk.currencyCode, accountId: sdk.accountId });
          await onToken(r.token);
        } catch (e: any) {
          setError(e?.displayMessage ?? e?.message ?? 'error');
        } finally {
          setBusy(false);
        }
      }}>{t('deposit')}</Button>
    </div>
  );
}
