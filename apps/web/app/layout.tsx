import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import './globals.css';

// Font files come from the @fontsource packages (OFL) and are served by next/font/local, so
// neither build nor runtime needs to reach Google — next/font/google could not on networks
// that inspect TLS. next/font still preloads them and generates metric-matched fallbacks.
const mono = localFont({
  src: [
    {
      path: '../../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2',
      weight: '400',
    },
    {
      path: '../../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2',
      weight: '500',
    },
  ],
  variable: '--font-mono',
  display: 'swap',
});

// Plus Jakarta Sans for display headings on the public pages; Inter for all interface text.
const display = localFont({
  src: [
    {
      path: '../../../node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-500-normal.woff2',
      weight: '500',
    },
    {
      path: '../../../node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-600-normal.woff2',
      weight: '600',
    },
  ],
  variable: '--font-display',
  display: 'swap',
});
const inter = localFont({
  src: [
    { path: '../../../node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2', weight: '400' },
    { path: '../../../node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2', weight: '500' },
    { path: '../../../node_modules/@fontsource/inter/files/inter-latin-600-normal.woff2', weight: '600' },
  ],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'SpecFix — requirements review',
  description:
    'Review model-detected ambiguities in product requirements before development starts.',
};

export const viewport: Viewport = {
  themeColor: '#090909', // the app frame
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable} ${mono.variable}`} suppressHydrationWarning>
      <body className="min-h-screen font-sans text-sm antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-sheet focus:px-3 focus:py-2 focus:shadow-float focus:outline-none focus:ring-2 focus:ring-teal"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
