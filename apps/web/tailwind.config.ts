import type { Config } from 'tailwindcss';

// The Review desk token set (DESIGN.md at the repo root, version 2). Colours are RGB-channel CSS
// variables set in globals.css; the legacy shadcn-style names stay as aliases so pages not yet
// redesigned share the same palette.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        frame: token('frame'),
        sheet: token('sheet'),
        raised: token('raised'),
        active: token('active'),
        rule: token('rule'),
        control: token('control'),
        field: token('field'),
        text: token('text'),
        // DESIGN.md `accent`. Named `teal` here because `accent` and `muted` keep their legacy
        // meaning (pale hover / well backgrounds) for pages not yet redesigned.
        teal: { DEFAULT: token('accent'), ink: token('accent-ink'), tag: token('accent-tag') },
        accent: { DEFAULT: token('raised'), foreground: token('text') },
        mark: { DEFAULT: token('mark'), selected: token('mark-selected') },
        positive: {
          DEFAULT: token('positive'),
          bg: token('positive-bg'),
          ink: token('positive-ink'),
        },
        negative: {
          DEFAULT: token('negative'),
          bg: token('negative-bg'),
          ink: token('negative-ink'),
        },
        warning: {
          DEFAULT: token('warning'),
          bg: token('warning-bg'),
          ink: token('warning-ink'),
          line: token('warning-line'),
        },
        neutral: { bg: token('neutral-bg'), ink: token('neutral-ink') },

        border: token('border'),
        input: token('input'),
        ring: token('ring'),
        background: token('background'),
        foreground: token('foreground'),
        muted: { DEFAULT: token('raised'), foreground: token('muted') },
        card: { DEFAULT: token('card'), foreground: token('card-foreground') },
        primary: { DEFAULT: token('primary'), foreground: token('primary-foreground') },
        destructive: {
          DEFAULT: token('destructive'),
          foreground: token('destructive-foreground'),
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: '4px',
        md: '6px',
        lg: '8px',
        sheet: '16px',
      },
      // Focus rings sit on dark surfaces; the default white offset would draw a halo.
      ringOffsetColor: { DEFAULT: token('sheet') },
      boxShadow: {
        float: 'var(--float)',
      },
      maxWidth: {
        reading: '68ch',
      },
    },
  },
  plugins: [],
};

export default config;
