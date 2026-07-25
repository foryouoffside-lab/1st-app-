import './../styles/globals.css';
import { Inter, Space_Grotesk } from 'next/font/google';
import AppShellClient from '../components/AppShellClient';
import { AuthProvider } from '../contexts/AuthContext';
import AuthGate from '../components/AuthGate';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  fallback: ['system-ui', 'arial'],
  adjustFontFallback: true,
});

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  variable: '--font-space-grotesk',
  fallback: ['system-ui', 'arial'],
  adjustFontFallback: true,
});

export const metadata = {
  title: 'SkillDrills',
  appleWebApp: {
    capable: true,
    title: 'SkillDrills',
    statusBarStyle: 'black-translucent',
  },
  manifest: '/manifest.json',
};

export const viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${inter.variable} ${spaceGrotesk.variable} scroll-smooth`}>
      <head>
        {/* Preconnect for Google Fonts, used by the app UI itself */}
        <link rel="dns-prefetch" href="//fonts.googleapis.com" />
        <link rel="dns-prefetch" href="//fonts.gstatic.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" crossOrigin="anonymous" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />

        {/* Favicon & Icons */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.svg" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-192x192.png" />

        {/* PWA */}
        <link rel="manifest" href="/manifest.json" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="SkillDrills" />

        {/* Preload critical image */}
        <link rel="preload" href="/icons/icon-512x512.png" as="image" type="image/png" />
      </head>
      <body className={`${inter.className} antialiased`}>
        <main id="main-content">
          <AuthProvider>
            <AuthGate>
              <AppShellClient>{children}</AppShellClient>
            </AuthGate>
          </AuthProvider>
        </main>
      </body>
    </html>
  );
}