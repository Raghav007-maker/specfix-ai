import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SpecFix — requirements review',
  description:
    'Review model-detected ambiguities in product requirements before development starts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased" suppressHydrationWarning>{children}</body>
    </html>
  );
}
