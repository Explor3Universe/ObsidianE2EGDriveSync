import { TFile, Vault, Notice } from 'obsidian';
import { CryptoService } from './crypto';
import { GoogleDriveClient } from './gdrive';
import { PluginSettings, DriveFile, SyncAction } from './types';

const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class SyncEngine {
  private vault: Vault;
  private crypto: CryptoService;
  private drive: GoogleDriveClient;
  private settings: PluginSettings;
  private saveSettings: () => Promise<void>;
  private syncing = false;

  constructor(
    vault: Vault,
    crypto: CryptoService,
    drive: GoogleDriveClient,
    settings: PluginSettings,
    saveSettings: () => Promise<void>
  ) {
    this.vault = vault;
    this.crypto = crypto;
    this.drive = drive;
    this.settings = settings;
    this.saveSettings = saveSettings;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  async performSync(): Promise<{
    uploaded: number;
    downloaded: number;
    conflicts: number;
  }> {
    if (this.syncing) throw new Error('Sync already in progress');
    if (!this.crypto.isUnlocked()) throw new Error('Master key is locked');
    if (!this.drive.isConfigured()) throw new Error('Google Drive not configured');

    this.syncing = true;
    const stats = { uploaded: 0, downloaded: 0, conflicts: 0 };

    try {
      // Ensure root folder
      if (!this.settings.driveFolderId) {
        this.settings.driveFolderId = await this.drive.findOrCreateFolder(
          this.settings.driveFolderName
        );
        await this.saveSettings();
      }

      new Notice('Sync: scanning files...');

      const localFiles = this.getLocalFiles();
      // Rebuild IDs from the actual remote tree, not a stale cache from a past run.
      this.settings.folderCache = {};
      const remoteFiles = await this.buildRemoteFileMap(
        this.settings.driveFolderId, ''
      );

      const actions = await this.computeActions(localFiles, remoteFiles);

      if (actions.length === 0) {
        // Touch-only mtime updates and the folder cache still need persistence.
        await this.saveSettings();
        new Notice('Sync: everything is up to date');
        return stats;
      }

      const total = actions.length;
      let current = 0;
      const failures: string[] = [];

      for (const action of actions) {
        current++;
        try {
          switch (action.type) {
            case 'upload':
              new Notice(`Upload (${current}/${total}): ${action.localPath}`);
              await this.uploadFile(action.localPath, action.remoteFile);
              stats.uploaded++;
              break;

            case 'download':
              new Notice(`Download (${current}/${total}): ${action.localPath}`);
              await this.downloadFile(action.localPath, action.remoteFile!);
              stats.downloaded++;
              break;

            case 'conflict':
              new Notice(`Conflict: ${action.localPath}`);
              await this.handleConflict(action.localPath, action.remoteFile!);
              stats.conflicts++;
              break;
          }
          // Checkpoint after every successful file; a later failure cannot erase progress.
          await this.saveSettings();
        } catch (e: unknown) {
          console.error(`Sync error for ${action.localPath}:`, e);
          const message = e instanceof Error ? e.message : String(e);
          failures.push(`${action.localPath}: ${message}`);
          new Notice(`Error: ${action.localPath} — ${message}`);
        }
      }

      await this.saveSettings();
      if (failures.length) {
        throw new Error(`${failures.length} file(s) failed to sync: ${failures.join('; ')}`);
      }
      return stats;
    } finally {
      this.syncing = false;
    }
  }

  // --- Local file scanning ---

  private getLocalFiles(): Map<string, TFile> {
    const files = new Map<string, TFile>();
    for (const file of this.vault.getFiles()) {
      if (!this.shouldExclude(file.path)) {
        files.set(file.path, file);
      }
    }
    return files;
  }

  private shouldExclude(path: string): boolean {
    const alwaysExclude = [`${this.vault.configDir}/`, '.trash/', '.git/'];
    for (const prefix of alwaysExclude) {
      if (path.startsWith(prefix)) return true;
    }

    for (const pattern of this.settings.excludePatterns) {
      if (!pattern) continue;
      if (pattern.startsWith('*.')) {
        if (path.endsWith(pattern.slice(1))) return true;
      } else if (pattern.endsWith('/')) {
        if (path.startsWith(pattern)) return true;
      } else {
        if (path.includes(pattern)) return true;
      }
    }

    return false;
  }

  // --- Remote file scanning ---

  private async buildRemoteFileMap(
    folderId: string,
    basePath: string,
    visited: Set<string> = new Set()
  ): Promise<Map<string, DriveFile>> {
    if (visited.has(folderId)) throw new Error('Google Drive folder cycle detected');
    visited.add(folderId);
    const result = new Map<string, DriveFile>();
    const children = await this.drive.listFiles(folderId);

    for (const child of children) {
      if (!child.name || child.name === '.' || child.name === '..' || /[\\/]/.test(child.name)) {
        throw new Error('Unsafe file name in Google Drive folder');
      }
      const childPath = basePath ? `${basePath}/${child.name}` : child.name;

      if (child.mimeType === FOLDER_MIME) {
        if (this.shouldExclude(`${childPath}/`)) continue;
        this.settings.folderCache[childPath] = child.id;
        const subFiles = await this.buildRemoteFileMap(child.id, childPath, visited);
        for (const [path, file] of subFiles) {
          if (result.has(path)) throw new Error(`Duplicate remote path: ${path}`);
          result.set(path, file);
        }
      } else if (child.name.endsWith('.enc')) {
        const fileName = child.name.slice(0, -4);
        const filePath = basePath ? `${basePath}/${fileName}` : fileName;
        if (!fileName || result.has(filePath)) throw new Error(`Duplicate or empty remote path: ${filePath}`);
        if (this.shouldExclude(filePath)) continue;
        result.set(filePath, child);
      }
    }

    return result;
  }

  // --- Action computation ---

  private async computeActions(
    localFiles: Map<string, TFile>,
    remoteFiles: Map<string, DriveFile>
  ): Promise<SyncAction[]> {
    const actions: SyncAction[] = [];
    const processed = new Set<string>();

    // Check each local file
    for (const [path, file] of localFiles) {
      processed.add(path);
      const record = this.settings.syncState[path];
      const remote = remoteFiles.get(path);

      if (!record) {
        if (remote) {
          // Never choose a winner based on timestamps from different machines.
          // Preserve the remote version as a conflict copy, then upload local.
          actions.push({ type: 'conflict', localPath: path, remoteFile: remote });
        } else {
          actions.push({ type: 'upload', localPath: path });
        }
        continue;
      }

      // Was synced before
      if (!remote) {
        // A missing remote file is not proof that the user intended deletion.
        actions.push({ type: 'upload', localPath: path });
        continue;
      }

      if (remote.id !== record.driveFileId) {
        // A replaced remote ID means another file took this path.
        actions.push({ type: 'conflict', localPath: path, remoteFile: remote });
        continue;
      }
      if (!remote.md5Checksum || !record.remoteChecksum) {
        throw new Error(`Missing checksum for ${path}; refusing to overwrite either copy`);
      }
      const remoteChanged = remote.md5Checksum !== record.remoteChecksum;
      // Timestamps can survive external edits or differ between machines.
      const content = await this.vault.readBinary(file);
      const hash = await this.crypto.hashContent(content);
      const localChanged = hash !== record.contentHash;
      if (!localChanged) record.localMtime = file.stat.mtime;
      if (localChanged && remoteChanged) {
        actions.push({ type: 'conflict', localPath: path, remoteFile: remote });
      } else if (localChanged) {
        actions.push({ type: 'upload', localPath: path, remoteFile: remote });
      } else if (remoteChanged) {
        actions.push({ type: 'download', localPath: path, remoteFile: remote });
      }
    }

    // Check remote files not found locally
    for (const [path, remote] of remoteFiles) {
      if (processed.has(path)) continue;

      // Keep the remote even if it was previously synced locally. A temporarily
      // missing local file must never cause irreversible remote deletion.
      actions.push({ type: 'download', localPath: path, remoteFile: remote });
    }

    return actions;
  }

  // --- File operations ---

  private async uploadFile(localPath: string, remote?: DriveFile): Promise<void> {
    const file = this.vault.getFileByPath(localPath);
    if (!file) throw new Error(`Local file disappeared: ${localPath}`);

    const content = await this.vault.readBinary(file);
    const encrypted = await this.crypto.encrypt(content);
    const contentHash = await this.crypto.hashContent(content);

    const folderId = await this.ensureRemoteFolders(localPath);
    const driveFile = await this.drive.uploadFile(
      file.name + '.enc',
      encrypted,
      folderId,
      remote?.id
    );

    this.settings.syncState[localPath] = {
      driveFileId: driveFile.id,
      localMtime: file.stat.mtime,
      contentHash,
      remoteChecksum: driveFile.md5Checksum || '',
      lastSynced: Date.now(),
    };
  }

  private async downloadFile(localPath: string, remote: DriveFile): Promise<void> {
    const encrypted = await this.drive.downloadFile(remote.id);
    const content = await this.crypto.decrypt(encrypted);
    const contentHash = await this.crypto.hashContent(content);

    // Ensure local parent folders
    const lastSlash = localPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await this.ensureLocalFolders(localPath.substring(0, lastSlash));
    }

    const existing = this.vault.getFileByPath(localPath);
    if (existing) {
      const record = this.settings.syncState[localPath];
      const latest = await this.vault.readBinary(existing);
      if (!record || await this.crypto.hashContent(latest) !== record.contentHash) {
        throw new Error(`Local file changed while downloading; retry to preserve both versions: ${localPath}`);
      }
      await this.vault.modifyBinary(existing, content);
    } else {
      await this.vault.createBinary(localPath, content);
    }

    const file = this.vault.getFileByPath(localPath);
    const localMtime = file instanceof TFile ? file.stat.mtime : Date.now();

    this.settings.syncState[localPath] = {
      driveFileId: remote.id,
      localMtime,
      contentHash,
      remoteChecksum: remote.md5Checksum || '',
      lastSynced: Date.now(),
    };
  }

  private async handleConflict(
    localPath: string,
    remote: DriveFile
  ): Promise<void> {
    // Download remote version as a conflict copy
    const encrypted = await this.drive.downloadFile(remote.id);
    const content = await this.crypto.decrypt(encrypted);

    const lastDot = localPath.lastIndexOf('.');
    const lastSeparator = localPath.lastIndexOf('/');
    const dotIndex = lastDot > lastSeparator + 1 ? lastDot : -1;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const stem = dotIndex >= 0 ? localPath.slice(0, dotIndex) : localPath;
    const extension = dotIndex >= 0 ? localPath.slice(dotIndex) : '';
    let conflictPath = `${stem} (conflict ${ts})${extension}`;
    let suffix = 2;
    while (this.vault.getFileByPath(conflictPath)) {
      conflictPath = `${stem} (conflict ${ts} ${suffix++})${extension}`;
    }

    const lastSlash = conflictPath.lastIndexOf('/');
    if (lastSlash > 0) {
      await this.ensureLocalFolders(conflictPath.substring(0, lastSlash));
    }
    await this.vault.createBinary(conflictPath, content);

    // Upload current local version to the existing remote ID (no duplicate).
    await this.uploadFile(localPath, remote);

    new Notice(`Conflict resolved: created ${conflictPath}`);
  }

  // --- Folder helpers ---

  private async ensureRemoteFolders(filePath: string): Promise<string> {
    const parts = filePath.split('/');
    parts.pop(); // remove filename

    if (parts.length === 0) return this.settings.driveFolderId;

    let parentId = this.settings.driveFolderId;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      if (this.settings.folderCache[currentPath]) {
        parentId = this.settings.folderCache[currentPath];
        continue;
      }

      parentId = await this.drive.findOrCreateFolder(part, parentId);
      this.settings.folderCache[currentPath] = parentId;
    }

    return parentId;
  }

  private async ensureLocalFolders(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.vault.getFolderByPath(currentPath)) {
        await this.vault.createFolder(currentPath);
      }
    }
  }
}
