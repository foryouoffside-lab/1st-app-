// lib/firebase.js
// SkillDrills Pro — Firebase Client Initializer

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

// Pre-configured default database options
const DEFAULT_CONFIG = {
  apiKey: "AIzaSyA8_tgz5gtnlaqJCeeaKq70d6unW2mQZ04",
  authDomain: "skilldrills-8450d.firebaseapp.com",
  projectId: "skilldrills-8450d",
  storageBucket: "skilldrills-8450d.firebasestorage.app",
  messagingSenderId: "484889550946",
  appId: "1:484889550946:web:95548ce9c0111bd74e713b",
  measurementId: "G-2X277EG6JE"
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
