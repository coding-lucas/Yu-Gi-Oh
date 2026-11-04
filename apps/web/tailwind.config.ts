import type { Config } from 'tailwindcss';

export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        elevated: 'rgb(var(--elevated) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        brand: { DEFAULT: 'rgb(var(--brand) / <alpha-value>)', 600: 'rgb(var(--brand-600) / <alpha-value>)' },
        emerald: { DEFAULT: 'rgb(var(--emerald) / <alpha-value>)', 600: 'rgb(var(--emerald-600) / <alpha-value>)' },
        danger: 'rgb(var(--danger) / <alpha-value>)',
        warn: 'rgb(var(--warn) / <alpha-value>)',
      },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Noto Sans', 'Noto Sans Arabic', 'Noto Sans Devanagari', 'Noto Sans CJK SC', 'sans-serif'] },
      borderRadius: { xl: '14px', '2xl': '18px' },
      keyframes: {
        up: { '0%': { backgroundColor: 'rgb(var(--emerald) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
        down: { '0%': { backgroundColor: 'rgb(var(--danger) / 0.35)' }, '100%': { backgroundColor: 'transparent' } },
      },
      animation: { up: 'up 1.6s ease-out', down: 'down 1.6s ease-out' },
    },
  },
  plugins: [],
} satisfies Config;
