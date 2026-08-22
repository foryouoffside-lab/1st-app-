// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const devUrl = process.env.CAP_DEV_URL;

const config: CapacitorConfig = {
  appId: 'com.skilldrills.pro',
  appName: 'SkillDrills Pro',
  webDir: 'out',         // Next.js static export output directory

  // Populated only when CAP_DEV_URL is set (see the note above); an empty
  // object is the normal production state.
  server: devUrl ? { url: devUrl, cleartext: true } : {},

  android: {
    allowMixedContent: false,
    backgroundColor: '#050508',
    // Hardware back button uses native browser history
    captureInput: true,
    webContentsDebuggingEnabled: false, // set true during development
  },

  plugins: {
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['google.com'],
    },
    SplashScreen: {
      // Effectively off. This is Capacitor's OWN splash layer, separate from
      // (and stacked right after) the Android 12+ OS-mandated one — that OS
      // layer can't be removed at all, but this one is ours to control, and
      // showing the same static logo twice in a row read as two screens
      // instead of one. Safe to collapse to ~0: the WebView's own background
      // color is already the correct dark ink (android.backgroundColor in
      // this same config) and the page's own CSS background paints within a
      // frame or two, so there's no white/blank flash left for this layer to
      // cover — it was only ever bridging a gap that's already covered
      // another way. The web loading screen (AuthGate.js) is what actually
      // carries the polished logo+spinner moment now, with its own
      // guaranteed minimum hold so it's never skipped past too fast either.
      launchShowDuration: 1,
      launchAutoHide: true,
      backgroundColor: '#050508',
      androidSplashResourceName: 'splash',
      showSpinner: true,
      androidSpinnerStyle: 'large',
      spinnerColor: '#8b5cf6', // violet-500, matches the web loading screen's ring
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'Dark',
      backgroundColor: '#050508',
      overlaysWebView: false,
    },
    Keyboard: {
      resize: 'body',
      style: 'dark',
      resizeOnFullScreen: true,
    },
    LocalNotifications: {
      // No custom drawable asset shipped yet, so this tints the OS's
      // built-in fallback icon rather than a proper monochrome brand icon.
      // Swap in a real `smallIcon` (a white silhouette drawable under
      // android/app/src/main/res/drawable) later for a polished look.
      iconColor: '#7c3aed',
    },
  },
};

export default config;
