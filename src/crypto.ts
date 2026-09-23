import { KeyFileData } from './types';

const PBKDF2_ITERATIONS = 600000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 256;
const VERSION_BYTE = 0x01;

export class CryptoService {
  private masterKey: CryptoKey | null = null;

  isUnlocked(): boolean {
    return this.masterKey !== null;
  }

  lock(): void {
    this.masterKey = null;
  }

  async initializeKeyFile(password: string): Promise<KeyFileData> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const wrappingKey = await this.deriveKey(password, salt.buffer);

    const masterKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: KEY_LENGTH },
      true,
      ['encrypt', 'decrypt']
    );

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const wrappedKey = await crypto.subtle.wrapKey(
      'raw', masterKey, wrappingKey, { name: 'AES-GCM', iv }
    );

    // Re-import as non-extractable for runtime use
    const rawKey = await crypto.subtle.exportKey('raw', masterKey);
    this.masterKey = await crypto.subtle.importKey(
      'raw', rawKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );

    return {
      version: 1,
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: PBKDF2_ITERATIONS,
        salt: this.bufferToBase64(salt),
      },
      masterKey: {
        algorithm: 'AES-256-GCM',
        iv: this.bufferToBase64(iv),
        data: this.bufferToBase64(new Uint8Array(wrappedKey)),
      },
    };
  }

  async unlock(password: string, keyData: KeyFileData): Promise<void> {
    const salt = this.base64ToBuffer(keyData.kdf.salt);
    const iv = this.base64ToBuffer(keyData.masterKey.iv);
    const wrappedKey = this.base64ToBuffer(keyData.masterKey.data);

    const wrappingKey = await this.deriveKey(password, salt, keyData.kdf.iterations);

    try {
      this.masterKey = await crypto.subtle.unwrapKey(
        'raw', wrappedKey, wrappingKey,
        { name: 'AES-GCM', iv },
        { name: 'AES-GCM', length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
      );
    } catch {
      throw new Error('Wrong password or corrupted key data');
    }
  }

  async changePassword(
    oldPassword: string,
    newPassword: string,
    keyData: KeyFileData
  ): Promise<KeyFileData> {
    // Temporarily unlock with old password
    const oldSalt = this.base64ToBuffer(keyData.kdf.salt);
    const oldIv = this.base64ToBuffer(keyData.masterKey.iv);
    const oldWrapped = this.base64ToBuffer(keyData.masterKey.data);
    const oldWrappingKey = await this.deriveKey(oldPassword, oldSalt, keyData.kdf.iterations);

    let extractableKey: CryptoKey;
    try {
      extractableKey = await crypto.subtle.unwrapKey(
        'raw', oldWrapped, oldWrappingKey,
        { name: 'AES-GCM', iv: oldIv },
        { name: 'AES-GCM', length: KEY_LENGTH },
        true,
        ['encrypt', 'decrypt']
      );
    } catch {
      throw new Error('Wrong old password');
    }

    // Wrap with new password
    const newSalt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
    const newWrappingKey = await this.deriveKey(newPassword, newSalt.buffer);
    const newIv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const newWrapped = await crypto.subtle.wrapKey(
      'raw', extractableKey, newWrappingKey, { name: 'AES-GCM', iv: newIv }
    );

    // Update runtime key (non-extractable)
    const raw = await crypto.subtle.exportKey('raw', extractableKey);
    this.masterKey = await crypto.subtle.importKey(
      'raw', raw,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['encrypt', 'decrypt']
    );

    return {
      version: 1,
      kdf: {
        algorithm: 'PBKDF2',
        hash: 'SHA-256',
        iterations: PBKDF2_ITERATIONS,
        salt: this.bufferToBase64(newSalt),
      },
      masterKey: {
        algorithm: 'AES-256-GCM',
        iv: this.bufferToBase64(newIv),
        data: this.bufferToBase64(new Uint8Array(newWrapped)),
      },
    };
  }

  async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.masterKey) throw new Error('Master key is locked');

    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv }, this.masterKey, data
    );

    const result = new Uint8Array(1 + IV_LENGTH + encrypted.byteLength);
    result[0] = VERSION_BYTE;
    result.set(iv, 1);
    result.set(new Uint8Array(encrypted), 1 + IV_LENGTH);
    return result.buffer;
  }

  async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!this.masterKey) throw new Error('Master key is locked');

    const bytes = new Uint8Array(data);
    if (bytes.length < 1 + IV_LENGTH + 16) {
      throw new Error('Encrypted data too short');
    }

    const version = bytes[0];
    if (version !== VERSION_BYTE) {
      throw new Error(`Unsupported encryption version: ${version}`);
    }

    const iv = bytes.slice(1, 1 + IV_LENGTH);
    const ciphertext = bytes.slice(1 + IV_LENGTH);

    try {
      return await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, this.masterKey, ciphertext
      );
    } catch {
      throw new Error('Decryption failed: data corrupted or wrong key');
    }
  }

  async hashContent(data: ArrayBuffer): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return this.bufferToHex(new Uint8Array(hash));
  }

  private async deriveKey(
    password: string,
    salt: ArrayBuffer,
    iterations: number = PBKDF2_ITERATIONS
  ): Promise<CryptoKey> {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );

    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      passwordKey,
      { name: 'AES-GCM', length: KEY_LENGTH },
      false,
      ['wrapKey', 'unwrapKey']
    );
  }

  private bufferToBase64(buffer: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return btoa(binary);
  }

  private base64ToBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      buffer[i] = binary.charCodeAt(i);
    }
    return buffer.buffer;
  }

  private bufferToHex(buffer: Uint8Array): string {
    return Array.from(buffer)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
