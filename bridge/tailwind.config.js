// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/renderer/**/*.{html,js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        'bridge-bg': '#111827',
        'bridge-surface': '#1f2937',
        'bridge-border': '#374151',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace']
      }
    }
  },
  plugins: []
}
