// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.skilldrills.pro',
  appName: 'SkillDrills Pro',
  webDir: 'out',         // Next.js static export output directory
  bundledWebRuntime: false,

  server: {
    // During development, point to local Next.js server (optional)
    // url: 'http://192.168.1.x:3000',
    // cleartext: true,
  },

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
      launchShowDuration: 2500,
      launchAutoHide: true,
      backgroundColor: '#050508',
      androidSplashResourceName: 'splash',
      showSpinner: false,
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
