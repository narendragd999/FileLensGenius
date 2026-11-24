import {
  DeviceIndexFilters,
  DeviceRootPreset,
  DeviceStorageRoot,
  FileCategory,
} from '../types/filelens';

const DB_NAME = 'filelens_device_roots_v1';
const STORE_NAME = 'roots';

interface StoredRootRecord extends DeviceStorageRoot {
  handle?: FileSystemDirectoryHandle;
}

// Local browser File System Access API augmentations
interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface PermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface ExtendedDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission?: (desc?: PermissionDescriptor) => Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?: (desc?: PermissionDescriptor) => Promise<'granted' | 'denied' | 'prompt'>;
}

const IGNORED_SYSTEM_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.trash',
  '$recycle.bin',
  'system volume information',
  '.cache',
  'cache',
  'caches',
  'temp',
  'tmp',
  '.venv',
  'venv',
  '__pycache__',
  '.npm',
  '.yarn',
  '.pnpm-store',
  '.gradle',
  'build',
  'dist',
  'target',
  '.thumbnails',
  'appdata',
  'library',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
]);

export const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'png',
  'webp',
  'bmp',
  'gif',
  'tif',
  'tiff',
  'avif',
  'heic',
  'svg',
]);

export const OFFICE_EXTS = new Set([
  'docx',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'rtf',
  'doc',
  'xls',
  'ppt',
]);

export const TEXT_CODE_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'xml',
  'yaml',
  'yml',
  'log',
  'ini',
  'cfg',
  'conf',
  'env',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'java',
  'kt',
  'kts',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sql',
  'sh',
  'bash',
  'zsh',
  'bat',
  'ps1',
  'swift',
  'dart',
  'r',
  'eml',
  'ics',
  'vcf',
  'srt',
  'vtt',
  'tex',
  'toml',
]);

export const MEDIA_EXTS = new Set([
  'mp3',
  'wav',
  'm4a',
  'aac',
  'flac',
  'ogg',
  'wma',
  'opus',
  'mp4',
  'mov',
  'mkv',
  'webm',
  'avi',
  'wmv',
  'm4v',
  '3gp',
]);

export const ARCHIVE_EXTS = new Set(['zip', 'jar', 'apk', 'rar', '7z', 'tar', 'gz', 'tgz']);

export const DEFAULT_DEVICE_INDEX_FILTERS: DeviceIndexFilters = {
  includePdf: true,
  includeImages: true,
  includeOfficeDocs: true,
  includeTextDocs: true,
  includeMediaAndArchives: true,
  includeAllOtherFiles: true,
  skipSystemFolders: true,
  maxFilesPerRun: 500,
};

export function classifyFileCategory(fileName: string, mimeType = ''): FileCategory {
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : '';
  if (ext === 'pdf' || mimeType === 'application/pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext) || mimeType.startsWith('image/')) return 'image';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (TEXT_CODE_EXTS.has(ext) || mimeType.startsWith('text/')) return 'text_code';
  if (MEDIA_EXTS.has(ext) || mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return 'audio_video';
  }
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  return 'other';
}

export function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as Record<string, unknown>).showDirectoryPicker === 'function'
  );
}

function openRootsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listStoredDeviceRoots(): Promise<DeviceStorageRoot[]> {
  try {
    const db = await openRootsDb();
    return await new Promise<DeviceStorageRoot[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const rows = (req.result as StoredRootRecord[]) ?? [];
        resolve(
          rows
            .map(({ handle: _h, ...meta }) => meta)
            .sort((a, b) => b.linkedAtIso.localeCompare(a.linkedAtIso))
        );
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function getStoredDeviceRootHandle(
  id: string
): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openRootsDb();
    return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        const rec = req.result as StoredRootRecord | undefined;
        resolve(rec?.handle ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

export async function saveStoredDeviceRoot(
  root: DeviceStorageRoot,
  handle?: FileSystemDirectoryHandle
): Promise<void> {
  try {
    const db = await openRootsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredRootRecord = { ...root, handle };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore IndexedDB quota/private-mode restrictions
  }
}

export async function updateStoredDeviceRootStats(
  id: string,
  lastFileCount: number,
  foldersScanned: number
): Promise<void> {
  try {
    const db = await openRootsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result as StoredRootRecord | undefined;
        if (!rec) {
          resolve();
          return;
        }
        rec.lastFileCount = lastFileCount;
        rec.foldersScanned = foldersScanned;
        rec.lastSyncedIso = new Date().toISOString();
        const putReq = store.put(rec);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch {
    // Ignore errors
  }
}

export async function deleteStoredDeviceRoot(id: string): Promise<void> {
  try {
    const db = await openRootsDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Ignore errors
  }
}

export type PickRootResult =
  | { status: 'linked'; root: DeviceStorageRoot; handle: FileSystemDirectoryHandle }
  | { status: 'cancelled' }
  | { status: 'fallback_needed'; reason: string };

/**
 * Opens native File System Access directory picker anchored to a device location
 * (Documents, Downloads, Pictures, Desktop, or full Drive/Home storage).
 * Automatically signals fallback_needed if inside a restricted iframe or unsupported browser.
 */
export async function pickAndLinkDeviceRoot(preset: DeviceRootPreset): Promise<PickRootResult> {
  if (!isFileSystemAccessSupported()) {
    return {
      status: 'fallback_needed',
      reason: 'Browser uses standard folder upload picker.',
    };
  }

  try {
    const picker = (
      window as unknown as {
        showDirectoryPicker: (opts?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    const options: DirectoryPickerOptions = {
      id: `filelens-${preset}`,
      mode: 'read',
    };
    if (preset !== 'custom') {
      options.startIn = preset;
    }

    const handle = await picker(options);
    const id = `root-${preset}-${handle.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const root: DeviceStorageRoot = {
      id,
      name: handle.name || (preset === 'custom' ? 'Device Storage' : preset),
      preset,
      linkedAtIso: new Date().toISOString(),
      lastFileCount: 0,
      foldersScanned: 0,
      hasPersistentHandle: true,
    };

    await saveStoredDeviceRoot(root, handle);
    return { status: 'linked', root, handle };
  } catch (err) {
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'AbortError') {
      return { status: 'cancelled' };
    }
    return {
      status: 'fallback_needed',
      reason:
        name === 'SecurityError'
          ? 'Embedded preview uses native OS folder selector.'
          : 'Falling back to native OS folder selector.',
    };
  }
}

export async function ensureDirectoryReadPermission(
  handle: FileSystemDirectoryHandle
): Promise<boolean> {
  const extHandle = handle as ExtendedDirectoryHandle;
  try {
    if (typeof extHandle.queryPermission === 'function') {
      const state = await extHandle.queryPermission({ mode: 'read' });
      if (state === 'granted') return true;
    }
    if (typeof extHandle.requestPermission === 'function') {
      const reqState = await extHandle.requestPermission({ mode: 'read' });
      return reqState === 'granted';
    }
    return true;
  } catch {
    return false;
  }
}

export function isExtensionAllowedByFilters(
  fileName: string,
  filters: DeviceIndexFilters,
  mimeType = ''
): boolean {
  const cat = classifyFileCategory(fileName, mimeType);
  if (cat === 'pdf') return filters.includePdf;
  if (cat === 'image') return filters.includeImages;
  if (cat === 'office') return filters.includeOfficeDocs;
  if (cat === 'text_code') return filters.includeTextDocs;
  if (cat === 'audio_video' || cat === 'archive') return filters.includeMediaAndArchives;
  return filters.includeAllOtherFiles;
}

export interface WalkDiscoveryProgress {
  foldersScanned: number;
  filesFound: number;
  currentFolder: string;
}

export interface WalkDirectoryResult {
  files: File[];
  filePathMap: WeakMap<File, string>;
  foldersScanned: number;
  reachedCap: boolean;
}

/**
 * Recursively walks a granted FileSystemDirectoryHandle (entire drive, home directory,
 * Documents, Downloads, Pictures, DCIM, etc.), skipping noisy system/dev caches,
 * and collects all supported files with exact relative paths for delta fingerprinting.
 */
export async function walkDeviceDirectoryHandle(
  handle: FileSystemDirectoryHandle,
  rootPrefix: string,
  filters: DeviceIndexFilters,
  signal?: AbortSignal,
  onDiscover?: (prog: WalkDiscoveryProgress) => void
): Promise<WalkDirectoryResult> {
  const files: File[] = [];
  const filePathMap = new WeakMap<File, string>();
  let foldersScanned = 0;
  let reachedCap = false;

  async function walk(dir: FileSystemDirectoryHandle, currentPath: string) {
    if (signal?.aborted || reachedCap) return;
    foldersScanned++;
    onDiscover?.({
      foldersScanned,
      filesFound: files.length,
      currentFolder: currentPath,
    });

    const extDir = dir as ExtendedDirectoryHandle;
    try {
      for await (const [entryName, entry] of extDir.entries()) {
        if (signal?.aborted || reachedCap) break;

        if (entry.kind === 'directory') {
          const lower = entryName.toLowerCase();
          if (
            filters.skipSystemFolders &&
            (lower.startsWith('.') || IGNORED_SYSTEM_DIRS.has(lower))
          ) {
            continue;
          }
          await walk(entry as FileSystemDirectoryHandle, `${currentPath}/${entryName}`);
        } else if (entry.kind === 'file') {
          if (!isExtensionAllowedByFilters(entryName, filters)) continue;
          try {
            const file = await (entry as FileSystemFileHandle).getFile();
            const relPath = `${currentPath}/${entryName}`;
            filePathMap.set(file, relPath);
            files.push(file);
            if (files.length >= filters.maxFilesPerRun) {
              reachedCap = true;
              break;
            }
          } catch {
            // Skip unreadable/locked OS files gracefully
          }
        }
      }
    } catch {
      // Skip restricted subdirectories without aborting the entire device scan
    }
  }

  await walk(handle, rootPrefix || handle.name || 'Device');
  return { files, filePathMap, foldersScanned, reachedCap };
}
