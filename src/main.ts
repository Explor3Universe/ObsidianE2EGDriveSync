import { Plugin, Notice } from 'obsidian';
import { PluginSettings, DEFAULT_SETTINGS } from './types';
import { CryptoService } from './crypto';
import { GoogleDriveClient } from './gdrive';
import { SyncEngine } from './sync';
import { E2EGDriveSyncSettingTab } from './settings';

export default class E2EGDriveSyncPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  cryptoService: CryptoService = new CryptoService();
  driveClient!: GoogleDriveClient;
  syncEngine!: SyncEngine;

  private autoSyncIntervalId: number | null = null;
  private statusBarEl: HTMLElement | null = null;
  private sessionPassword = '';

  async onload() {
    await this.loadSettings();

    this.driveClient = new GoogleDriveClient(this.settings, async (updates) => {
      Object.assign(this.settings, updates);
      await this.saveSettings();
      this.driveClient.updateSettings(this.settings);
    });

    this.syncEngine = new SyncEngine(
      this.app.vault,
      this.cryptoService,
      this.driveClient,
      this.settings,
      () => this.saveSettings()
    );

    // Auto-unlock if password is saved
    if (this.settings.encryptionPassword && this.settings.keyData) {
      try {
        await this.cryptoService.unlock(
          this.settings.encryptionPassword,
          this.settings.keyData
        );
        this.sessionPassword = this.settings.encryptionPassword;
      } catch {
        new Notice('Auto-unlock failed — check your password');
      }
    }

    // Ribbon icon
    this.addRibbonIcon('refresh-cw', 'Sync vault', () => this.runSync());

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar();

    // Commands
    this.addCommand({
      id: 'sync-now',
      name: 'Sync now',
      callback: () => this.runSync(),
    });

    this.addCommand({
      id: 'lock',
      name: 'Lock encryption',
      callback: () => {
        this.cryptoService.lock();
        this.updateStatusBar();
        new Notice('Master key locked');
      },
    });

    // Settings tab
    this.addSettingTab(new E2EGDriveSyncSettingTab(this.app, this));

    // Auto-sync
    this.setupAutoSync();
  }

  onunload() {
    this.clearAutoSync();
    this.cryptoService.lock();
  }

  async loadSettings() {
    const loaded = await this.loadData() as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
    if (!this.settings.syncState) this.settings.syncState = {};
    if (!this.settings.folderCache) this.settings.folderCache = {};
    if (!this.settings.excludePatterns) this.settings.excludePatterns = [];
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.syncEngine?.updateSettings(this.settings);
    this.driveClient?.updateSettings(this.settings);
  }

  rememberSessionPassword(password: string): void {
    this.sessionPassword = password;
    if (this.settings.encryptionPassword) this.settings.encryptionPassword = password;
  }

  getSessionPassword(): string {
    return this.sessionPassword;
  }

  // ─── Sync ─────────────────────────────────────────────────

  async runSync() {
    if (!this.cryptoService.isUnlocked()) {
      new Notice('Unlock the master key in settings first');
      return;
    }
    if (!this.driveClient.isConfigured()) {
      new Notice('Configure Google Drive in settings first');
      return;
    }
    if (this.syncEngine.isSyncing()) {
      new Notice('Sync is already running');
      return;
    }

    this.updateStatusBar('syncing...');

    try {
      const s = await this.syncEngine.performSync();
      const parts: string[] = [];
      if (s.uploaded) parts.push(`uploaded ${s.uploaded}`);
      if (s.downloaded) parts.push(`downloaded ${s.downloaded}`);
      if (s.conflicts) parts.push(`conflicts ${s.conflicts}`);
      const msg = parts.length ? `Sync done: ${parts.join(', ')}` : 'Sync: up to date';
      new Notice(msg);
      this.updateStatusBar();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      new Notice(`Sync error: ${message}`);
      this.updateStatusBar('error');
      console.error('E2E Google Drive sync:', e);
    }
  }

  // ─── Auto-sync ────────────────────────────────────────────

  setupAutoSync() {
    this.clearAutoSync();

    if (this.settings.autoSync && this.settings.syncIntervalMinutes > 0) {
      const ms = this.settings.syncIntervalMinutes * 60 * 1000;
      this.autoSyncIntervalId = window.setInterval(() => { void this.runSync(); }, ms);
      this.registerInterval(this.autoSyncIntervalId);
    }
  }

  private clearAutoSync() {
    if (this.autoSyncIntervalId !== null) {
      window.clearInterval(this.autoSyncIntervalId);
      this.autoSyncIntervalId = null;
    }
  }

  // ─── Status bar ───────────────────────────────────────────

  private updateStatusBar(text?: string) {
    if (!this.statusBarEl) return;

    if (text) {
      this.statusBarEl.setText(`Google Drive: ${text}`);
      return;
    }

    const unlocked = this.cryptoService?.isUnlocked();
    const connected = this.driveClient?.isConfigured();

    if (!unlocked) {
      this.statusBarEl.setText('Google Drive: locked');
    } else if (!connected) {
      this.statusBarEl.setText('Google Drive: not connected');
    } else {
      this.statusBarEl.setText('Google Drive: ready');
    }
  }
}
