export interface KeyFileData {
  version: number;
  kdf: {
    algorithm: string;
    hash: string;
    iterations: number;
    salt: string;
  };
  masterKey: {
    algorithm: string;
    iv: string;
    data: string;
  };
}

export interface FileSyncRecord {
  driveFileId: string;
  localMtime: number;
  contentHash: string;
  remoteChecksum: string;
  lastSynced: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
}

export interface SyncAction {
  type: 'upload' | 'download' | 'conflict';
  localPath: string;
  remoteFile?: DriveFile;
}

export interface PluginSettings {
  encryptionPassword: string;
  keyData: KeyFileData | null;
  googleClientId: string;
  googleClientSecret: string;
  googleAccessToken: string;
  googleRefreshToken: string;
  googleTokenExpiry: number;
  driveFolderId: string;
  driveFolderName: string;
  autoSync: boolean;
  syncIntervalMinutes: number;
  excludePatterns: string[];
  syncState: Record<string, FileSyncRecord>;
  folderCache: Record<string, string>;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  encryptionPassword: '',
  keyData: null,
  googleClientId: '',
  googleClientSecret: '',
  googleAccessToken: '',
  googleRefreshToken: '',
  googleTokenExpiry: 0,
  driveFolderId: '',
  driveFolderName: 'ObsidianEncryptedSync',
  autoSync: false,
  syncIntervalMinutes: 30,
  excludePatterns: [],
  syncState: {},
  folderCache: {},
};
