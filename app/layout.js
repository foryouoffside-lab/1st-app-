import './../styles/globals.css';
import { Inter, Anton, IBM_Plex_Mono } from 'next/font/google';
import AppShellClient from '../components/AppShellClient';
import { AuthProvider } from '../contexts/AuthContext';
import AuthGate from '../components/AuthGate';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  fallback: ['system-ui', 'arial'],
  adjustFontFallback: true,
});

const anton = Anton({
  subsets: ['latin'],
  weight: '400',
  variable: '--font-anton',
  fallback: ['system-ui', 'arial'],
  adjustFontFallback: true,
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-mono',
  fallback: ['ui-monospace', 'monospace'],
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
    // suppressHydrationWarning: the Android/ColorOS WebView injects inline
    // --safe-area-inset-* custom properties onto <html> before React hydrates,
    // which trips a dev-only hydration mismatch on this element. The attribute
    // silences the warning for <html>'s own attributes only (not its subtree),
    // and has no effect on the production static export.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${anton.variable} ${ibmPlexMono.variable} scroll-smooth`}
    >
      <head>
        {/* No Google Fonts preconnect here on purpose. next/font SELF-HOSTS
            Inter, Anton and IBM Plex Mono into /_next/static/media at build time, so
            nothing is ever fetched from fonts.googleapis.com or
            fonts.gstatic.com — these four hints only opened connections to
            hosts the app never talks to, which in an offline-capable WebView
            app is pure cost. The real font hints are the rel=preload tags
            injected into every exported page by scripts/preload-fonts.js. */}

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

        {/* No image preload here on purpose. icon-512x512.png is referenced
            only by manifest.json (the PWA install icon) and is never rendered,
            so preloading it fetched and decoded 90KB on every single page load
            and then threw it away — the WebView logged "preloaded but not used"
            on every route. Native builds get their launcher icon from Android,
            not from this tag. */}
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