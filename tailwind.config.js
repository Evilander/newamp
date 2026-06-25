/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Classic Winamp green-on-black aesthetic, with modern accents
        amp: {
          bg: '#0a0e07',
          panel: '#141b14',
          panel2: '#1f2a1f',
          line: '#2a3a2a',
          green: '#39ff14',
          'green-dim': '#1aa30a',
          'green-glow': '#7fff5b',
          amber: '#ffb000',
          red: '#ff3333',
          cyan: '#00f0ff',
          ink: '#cfead0',
          muted: '#5e7d5e',
        },
      },
      fontFamily: {
        lcd: ['"VT323"', '"Press Start 2P"', 'monospace'],
        mono: ['"JetBrains Mono"', '"Consolas"', 'monospace'],
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 12px rgba(57, 255, 20, 0.55), 0 0 28px rgba(57, 255, 20, 0.25)',
        'glow-soft': '0 0 6px rgba(57, 255, 20, 0.35)',
        'inset-panel': 'inset 0 0 0 1px rgba(57,255,20,0.12), inset 0 1px 0 rgba(255,255,255,0.04)',
      },
      animation: {
        'pulse-fast': 'pulse 1.2s cubic-bezier(0.4,0,0.6,1) infinite',
        marquee: 'marquee 18s linear infinite',
      },
      keyframes: {
        marquee: {
          '0%': { transform: 'translateX(0%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
      },
    },
  },
  plugins: [],
};
