// lib/firebase.js
// SkillDrills Pro — Firebase Client Initializer

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Pre-configured default database options
const DEFAULT_CONFIG = {
  apiKey: "AIzaSyDPnV6CHfZoLXF-vupkHJRXMSJNtS7BmFE",
  authDomain: "skilldrills-42ddc.firebaseapp.com",
  projectId: "skilldrills-42ddc",
  storageBucket: "skilldrills-42ddc.firebasestorage.app",
  messagingSenderId: "220381726989",
  appId: "1:220381726989:web:48fd81731308abee608844",
  measurementId: "G-DTWCZKL7ZT"
};

/**
 * Initialize Firebase
 * @returns {{ app: Object, db: Object, auth: Object } | null}
 */
export function initFirebase() {
  if (typeof window === 'undefined') return null;

  try {
    // If already initialized, return existing instance
    if (getApps().length > 0) {
      const app = getApp();
      const db = getFirestore(app);
      const auth = getAuth(app);
      return { app, db, auth };
    }

    // Initialize new app instance
    const app = initializeApp(DEFAULT_CONFIG);
    const db = getFirestore(app);
    const auth = getAuth(app);
    return { app, db, auth };
  } catch (e) {
    console.error("Firebase initialization failed:", e);
    return null;
  }
}
