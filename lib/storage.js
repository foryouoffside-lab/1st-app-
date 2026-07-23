// lib/storage.js
// SkillDrills Pro — Universal Device Storage Adapter
// Uses @capacitor/preferences on Android native, localStorage on web.
// All lib/* files import from here — never use localStorage directly.

let _Preferences = null;

// Capacitor plugin objects expose a `.then` property (their proxy returns a
// callable wrapper for any property access), so returning one directly from
// an async function makes JS's promise resolution mistake it for a nested
// thenable and call `.then()` on it, crashing with e.g. "Preferences.then()
// is not implemented on android". Wrapping it in a plain object avoids that.
async function getPreferences() {
  if (typeof window !== 'undefined' && !window.Capacitor) {
    return { Preferences: null }; // Running in regular web browser, bypass Capacitor and use localStorage
  }
  if (_Preferences) return { Preferences: _Preferences };
  try {
    const cap = await import('@capacitor/preferences');
    _Preferences = cap.Preferences;
    return { Preferences: _Preferences };
  } catch {
    return { Preferences: null }; // Not in Capacitor context — fall back to localStorage
  }
}

/**
 * Universal Storage adapter.
 * API is async to match @capacitor/preferences — always await these.
 */
export const Storage = {
  /**
   * Get a string value by key. Returns null if not found.
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    try {
      const { Preferences } = await getPreferences();
      if (Preferences) {
        const { value } = await Preferences.get({ key });
        return value;
      }
      return localStorage.getItem(key);
    } catch {
      try { return localStorage.getItem(key); } catch { return null; }
    }
  },

  /**
   * Store a string value.
   * @param {string} key
   * @param {string} value
   */
  async set(key, value) {
    try {
      const { Preferences } = await getPreferences();
      if (Preferences) {
        await Preferences.set({ key, value });
        return;
      }
      localStorage.setItem(key, value);
    } catch {
      try { localStorage.setItem(key, value); } catch {}
    }
  },

  /**
   * Remove a key.
   * @param {string} key
   */
  async remove(key) {
    try {
      const { Preferences } = await getPreferences();
      if (Preferences) {
        await Preferences.remove({ key });
        return;
      }
      localStorage.removeItem(key);
    } catch {
      try { localStorage.removeItem(key); } catch {}
    }
  },

  /**
   * Get a parsed JSON object. Returns defaultValue if missing or invalid.
   * @param {string} key
   * @param {*} defaultValue
   */
  async getJSON(key, defaultValue = null) {
    const raw = await this.get(key);
    if (!raw) return defaultValue;
    try { return JSON.parse(raw); } catch { return defaultValue; }
  },

  /**
   * Store an object as JSON.
   * @param {string} key
   * @param {*} value
   */
  async setJSON(key, value) {
    await this.set(key, JSON.stringify(value));
  },

  /** Synchronous localStorage fallback — use ONLY where async is impossible. */
  syncGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  syncSet(key, value) {
    try { localStorage.setItem(key, value); } catch {}
  },
};
