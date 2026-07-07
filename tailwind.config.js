/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // var()-backed bridge into the skin system (src/styles/tokens.css).
      // Utilities like text-accent / bg-panel2 / border-line follow the active
      // [data-theme] instead of hard-coding the default green.
      colors: {
        ink: 'var(--ink)',
        ink2: 'var(--ink-2)',
        muted: 'var(--muted)',
        panel: 'var(--panel)',
        panel2: 'var(--panel-2)',
        panel3: 'var(--panel-3)',
        line: 'var(--line)',
        accent: 'var(--accent)',
        accentDim: 'var(--accent-dim)',
        warn: 'var(--warn)',
        error: 'var(--error)',
      },
      borderRadius: {
        DEFAULT: 'var(--radius)',
        card: 'var(--radius-card)',
        pill: 'var(--radius-pill)',
      },
      // Type ramp tokens (tokens.css). These override the Tailwind defaults for
      // xs…3xl on purpose — the app's compact hardware scale is the system.
      fontSize: {
        '2xs': 'var(--text-2xs)',
        xs: 'var(--text-xs)',
        sm: 'var(--text-sm)',
        base: 'var(--text-base)',
        md: 'var(--text-md)',
        lg: 'var(--text-lg)',
        xl: 'var(--text-xl)',
        '2xl': 'var(--text-2xl)',
        '3xl': 'var(--text-3xl)',
      },
      fontFamily: {
        lcd: ['"VT323"', '"Press Start 2P"', 'monospace'],
        mono: ['"JetBrains Mono"', '"Consolas"', 'monospace'],
        display: ['"Inter"', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
