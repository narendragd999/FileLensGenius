import {
  AppPreferences,
  DeviceIndexSummary,
  DocFolder,
  SavedSearch,
  SavedSignature,
  ScanDocument,
  VoiceNote,
} from '../types/filelens';
import {
  DEFAULT_PREFERENCES,
  INITIAL_DOCUMENTS,
  INITIAL_FOLDERS,
  INITIAL_SAVED_SEARCHES,
  INITIAL_VOICE_NOTES,
} from '../data/seedData';

const VAULT_DB_NAME = 'filelens_vault_db_v1';
const VAULT_STORE = 'workspace';
const VAULT_KEY = 'state';
const LEGACY_LOCALSTORAGE_KEYS = [
  'filelens_scan_workspace_v2',
  'filelens_scan_workspace_v1',
];

export interface PersistedVaultState {
  documents: ScanDocument[];
  folders: DocFolder[];
  voiceNotes: VoiceNote[];
  savedSearches: SavedSearch[];
  savedSignatures: SavedSignature[];
  preferences: AppPreferences;
  lastIndexSummary: DeviceIndexSummary | null;
}

export function createEmptyVaultState(): PersistedVaultState {
  return {
    documents: INITIAL_DOCUMENTS,
    folders: INITIAL_FOLDERS,
    voiceNotes: INITIAL_VOICE_NOTES,
    savedSearches: INITIAL_SAVED_SEARCHES,
    savedSignatures: [],
    preferences: DEFAULT_PREFERENCES,
    lastIndexSummary: null,
  };
}

function purgeLegacyLocalStorage(): void {
  try {
    for (const key of LEGACY_LOCALSTORAGE_KEYS) {
      localStorage.removeItem(key);
    }
  } catch {
    // Ignore storage access restrictions
  }
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;

function openVaultDb(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;
  cachedDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      cachedDbPromise = null;
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VAULT_STORE)) {
        db.createObjectStore(VAULT_STORE);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { cachedDbPromise = null; };
      db.onversionchange = () => { db.close(); cachedDbPromise = null; };
      resolve(db);
    };
    req.onerror = () => {
      cachedDbPromise = null;
      reject(req.error);
    };
  });
  return cachedDbPromise;
}

export async function loadVaultState(): Promise<PersistedVaultState> {
  purgeLegacyLocalStorage();
  try {
    const db = await openVaultDb();
    const stored = await new Promise<Partial<PersistedVaultState> | undefined>(
      (resolve, reject) => {
        const tx = db.transaction(VAULT_STORE, 'readonly');
        const store = tx.objectStore(VAULT_STORE);
        const req = store.get(VAULT_KEY);
        req.onsuccess = () =>
          resolve(req.result as Partial<PersistedVaultState> | undefined);
        req.onerror = () => reject(req.error);
      }
    );

    if (stored && Array.isArray(stored.documents)) {
      return {
        documents: stored.documents,
        folders:
          Array.isArray(stored.folders) && stored.folders.length > 0
            ? stored.folders
            : INITIAL_FOLDERS,
        voiceNotes: Array.isArray(stored.voiceNotes) ? stored.voiceNotes : [],
        savedSearches: Array.isArray(stored.savedSearches)
          ? stored.savedSearches
          : [],
        savedSignatures: Array.isArray(stored.savedSignatures)
          ? stored.savedSignatures
          : [],
        preferences: { ...DEFAULT_PREFERENCES, ...(stored.preferences ?? {}) },
        lastIndexSummary: stored.lastIndexSummary ?? null,
      };
    }
  } catch {
    // Fallback to clean empty state
  }
  return createEmptyVaultState();
}

export async function saveVaultState(state: PersistedVaultState): Promise<void> {
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE, 'readwrite');
      const store = tx.objectStore(VAULT_STORE);
      const req = store.put(state, VAULT_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore private-mode / quota errors gracefully
  }
}

export async function clearVaultState(): Promise<void> {
  purgeLegacyLocalStorage();
  try {
    const db = await openVaultDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(VAULT_STORE, 'readwrite');
      const store = tx.objectStore(VAULT_STORE);
      const req = store.delete(VAULT_KEY);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore errors
  }
}

export async function getBrowserStorageUsageBytes(): Promise<number> {
  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const est = await navigator.storage.estimate();
      return est.usage ?? 0;
    }
  } catch {
    // Ignore unsupported browsers
  }
  return 0;
}
