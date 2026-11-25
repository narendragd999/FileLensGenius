/**
 * Encrypted Workspace Backup Manager (.fspbackup)
 * Ported from FileLensMobile's BackupManager.kt:
 * Format: "FSPB" (4 bytes) + 16-byte salt + 12-byte IV + AES-256-GCM ciphertext
 * Key derivation: PBKDF2-HMAC-SHA256, 100,000 iterations.
 */

const MAGIC = new Uint8Array([0x46, 0x53, 0x50, 0x42]); // "FSPB"

async function deriveAesKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function createEncryptedBackupBlob(
  jsonPayload: unknown,
  password: string
): Promise<Blob> {
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(jsonPayload));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey(password, salt);

  const cipherBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );
  const cipherBytes = new Uint8Array(cipherBuf);

  const out = new Uint8Array(MAGIC.length + salt.length + iv.length + cipherBytes.length);
  out.set(MAGIC, 0);
  out.set(salt, 4);
  out.set(iv, 20);
  out.set(cipherBytes, 32);

  return new Blob([out], { type: 'application/octet-stream' });
}

export async function decryptBackupBuffer<T = unknown>(
  buffer: ArrayBuffer,
  password: string
): Promise<T> {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 36 ||
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new Error('Invalid .fspbackup file format');
  }

  const salt = bytes.slice(4, 20);
  const iv = bytes.slice(20, 32);
  const ciphertext = bytes.slice(32);

  const key = await deriveAesKey(password, salt);
  const plainBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const dec = new TextDecoder();
  return JSON.parse(dec.decode(plainBuf)) as T;
}
