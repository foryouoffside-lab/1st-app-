// capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

const devUrl = process.env.CAP_DEV_URL;

const config: CapacitorConfig = {
  appId: 'com.skilldrills.pro',
  appName: 'SkillDrills',
  webDir: 'out',         
  server: devUrl ? { url: devUrl, cleartext: true } : {},

  android: {
    allowMixedContent: false,
    backgroundColor: '#050508',
    // Hardware back button uses native browser history
    captureInput: true,
    // Derived, never hand-set. true exposes the WebView to chrome://inspect
    // from any machine that can reach the device over adb — which means the
    // signed-in user's session can be read straight out of localStorage by
    // anyone with physical access. Tying it to CAP_DEV_URL means it is on
    // only during a `npm run mobile:live` session and is structurally
    // impossible to leave on in a release build, which `mobile:release`
    // produces with no CAP_DEV_URL set.
    webContentsDebuggingEnabled: !!devUrl,
  },

  plugins: {
    FirebaseAuthentication: {
      skipNativeAuth: false,
      providers: ['google.com'],
    },
    SplashScreen: {
      launchShowDuration: 1,
      launchAutoHide: true,
      backgroundColor: '#050508',
      androidSplashResourceName: 'splash',
      showSpinner: true,
      androidSpinnerStyle: 'large',
      spinnerColor: '#8b5cf6', 
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
