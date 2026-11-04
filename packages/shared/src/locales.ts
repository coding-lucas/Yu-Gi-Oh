export const LOCALES = ['pt', 'en', 'es', 'fr', 'de', 'it', 'ar', 'hi', 'zh', 'ja', 'ko'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';
export const RTL_LOCALES: readonly Locale[] = ['ar'];

/** BCP-47 tags used with Intl.* for number, currency and date formatting. */
export const LOCALE_BCP47: Record<Locale, string> = {
  pt: 'pt-BR', en: 'en-GB', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
  ar: 'ar', hi: 'hi-IN', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR',
};

export const LOCALE_NAMES: Record<Locale, string> = {
  pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano',
  ar: 'العربية', hi: 'हिन्दी', zh: '简体中文', ja: '日本語', ko: '한국어',
};

export function isRtl(locale: string): boolean {
  return (RTL_LOCALES as readonly string[]).includes(locale);
}
export function isLocale(x: string): x is Locale {
  return (LOCALES as readonly string[]).includes(x);
}
