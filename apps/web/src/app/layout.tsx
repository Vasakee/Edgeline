import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Edgeline',
  description: 'Solana-based autonomous sports trading agent dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
