/** @type {import('tailwindcss').Config} */
export default {
  // The night theme is a class on <body>, not an OS preference, so `dark:`
  // has to follow `.theme-night`. Left on the default `media` strategy the
  // dark: variants only fired when the phone itself was in dark mode, which
  // is how light-grey text ended up on the near-black night menu.
  darkMode: ['selector', '.theme-night'],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Noto Sans Thai"', '"Open Sans"', 'system-ui', 'sans-serif'],
        thai: ['"Noto Sans Thai"', '"Open Sans"', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
        kanit: ['Prompt', '"Noto Sans Thai"', 'sans-serif'],
      },
      colors: {
        // The grey ramp is a theme token too. The back-office and staff panels
        // are written in plain `text-neutral-500` / `bg-neutral-100` utilities,
        // so pointing the scale itself at variables flips all of them at once
        // instead of asking every file to carry a `dark:` twin. Day holds
        // Tailwind's stock greys; night holds a warm ramp running the other
        // way (50 = darkest surface, 800 = brightest text), which is why
        // `text-neutral-500` stays "muted" and `bg-neutral-100` stays "raised"
        // in both themes. Values live in index.css.
        //
        // These are `R G B` triples, not hex, so /opacity suffixes such as
        // `bg-neutral-900/20` keep working.
        neutral: {
          50: 'rgb(var(--n-50) / <alpha-value>)',
          100: 'rgb(var(--n-100) / <alpha-value>)',
          150: 'rgb(var(--n-150) / <alpha-value>)',
          200: 'rgb(var(--n-200) / <alpha-value>)',
          300: 'rgb(var(--n-300) / <alpha-value>)',
          400: 'rgb(var(--n-400) / <alpha-value>)',
          500: 'rgb(var(--n-500) / <alpha-value>)',
          600: 'rgb(var(--n-600) / <alpha-value>)',
          700: 'rgb(var(--n-700) / <alpha-value>)',
          800: 'rgb(var(--n-800) / <alpha-value>)',
          900: 'rgb(var(--n-900) / <alpha-value>)',
          950: 'rgb(var(--n-950) / <alpha-value>)',
        },
        // Theme tokens. The values live in the .theme-day / .theme-night
        // blocks of index.css, so `bg-card` is white by day and #241D16 by
        // night without the JSX naming either colour.
        app: 'var(--c-app)',
        strip: {
          DEFAULT: 'var(--c-strip)',
          soft: 'var(--c-strip-soft)',
        },
        card: {
          DEFAULT: 'var(--c-card)',
          hover: 'var(--c-card-hover)',
        },
        raised: {
          DEFAULT: 'var(--c-raised)',
          hover: 'var(--c-raised-hover)',
          ink: 'var(--c-raised-ink)',
        },
        header: {
          ink: 'var(--c-header-ink)',
        },
        logo: 'var(--c-logo)',
        well: {
          DEFAULT: 'var(--c-well)',
          2: 'var(--c-well-2)',
        },
        line: {
          DEFAULT: 'var(--c-line)',
          strong: 'var(--c-line-strong)',
        },
        ink: {
          DEFAULT: 'var(--c-ink)',
          2: 'var(--c-ink-2)',
          3: 'var(--c-ink-3)',
        },
        title: 'var(--c-title)',
        heading: 'var(--c-heading)',
        accent: 'var(--c-accent)',
        link: 'var(--c-link)',
        cta: {
          DEFAULT: 'var(--c-cta)',
          hover: 'var(--c-cta-hover)',
          ink: 'var(--c-cta-ink)',
        },
        add: {
          DEFAULT: 'var(--c-add)',
          hover: 'var(--c-add-hover)',
          ink: 'var(--c-add-ink)',
        },
        // Back-office (owner) tokens. Same idea as the storefront ones above:
        // the values live in index.css so the colours can be changed there
        // without touching any JSX.
        admin: {
          bar: 'var(--c-admin-bar)',
          // Surfaces inside the back-office/staff panels: the cards that used
          // to be a literal bg-white, the tinted form panels, and the input
          // backgrounds. Split from the storefront `card`/`well` tokens so the
          // two sides can be re-coloured independently.
          card: 'var(--c-admin-card)',
          cta: {
            DEFAULT: 'var(--c-admin-cta)',
            hover: 'var(--c-admin-cta-hover)',
            ink: 'var(--c-admin-cta-ink)',
          },
          panel: 'var(--c-admin-panel)',
          field: 'var(--c-admin-field)',
          line: 'var(--c-admin-line)',
          tab: {
            DEFAULT: 'var(--c-admin-tab)',
            ink: 'var(--c-admin-tab-ink)',
            idle: 'var(--c-admin-tab-idle)',
            hover: 'var(--c-admin-tab-hover)',
          },
          // Money colours, shared by the dashboard tiles and the summary table
          // so the two pages can never drift apart again.
          income: {
            DEFAULT: 'var(--c-admin-income)',
            soft: 'var(--c-admin-income-soft)',
            ink: 'var(--c-admin-income-ink)',
          },
          expense: {
            DEFAULT: 'var(--c-admin-expense)',
            soft: 'var(--c-admin-expense-soft)',
            ink: 'var(--c-admin-expense-ink)',
          },
        },
        // Trend-chart marks. Referenced through stroke-/fill- utilities rather
        // than SVG attributes, because attributes can't hold a var().
        chart: {
          revenue: 'var(--c-chart-revenue)',
          profit: 'var(--c-chart-profit)',
          loss: 'var(--c-chart-loss)',
          grid: 'var(--c-chart-grid)',
          axis: 'var(--c-chart-axis)',
          zero: 'var(--c-chart-zero)',
          cross: 'var(--c-chart-cross)',
          // The ring drawn around the hover markers, so they stay legible
          // where they cross a line. Matches the card behind the chart.
          surface: 'var(--c-admin-card)',
        },
        // Solid "do it" buttons in the back-office and staff panels. Near-black
        // by day; inverting the grey ramp would have turned these near-white
        // with white text on top, so they get a token of their own.
        ctl: {
          DEFAULT: 'var(--c-ctl)',
          hover: 'var(--c-ctl-hover)',
          ink: 'var(--c-ctl-ink)',
        },
        wood: {
          DEFAULT: '#8A5A32',
          dark: '#6B4021',
          light: '#A9713D',
        },
        cocoa: '#5A2E14',
        clay: '#7B2D12',
      },
    },
  },
  plugins: [],
}
