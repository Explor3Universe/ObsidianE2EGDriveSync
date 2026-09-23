import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type E2EGDriveSyncPlugin from './main';

export class E2EGDriveSyncSettingTab extends PluginSettingTab {
  plugin: E2EGDriveSyncPlugin;

  constructor(app: App, plugin: E2EGDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('e2e-gdrive-sync-settings');

    this.renderEncryptionSection(containerEl);
    this.renderGoogleDriveSection(containerEl);
    this.renderSyncSection(containerEl);
  }

  // ─── Encryption ───────────────────────────────────────────

  private renderEncryptionSection(el: HTMLElement): void {
    new Setting(el).setName('Encryption').setHeading();

    if (!this.plugin.settings.keyData) {
      this.renderKeySetup(el);
    } else {
      this.renderKeyStatus(el);
    }
  }

  private renderKeySetup(el: HTMLElement): void {
    el.createEl('p', {
      text: 'Set an encryption password. It protects the master key that encrypts your vault. Remember it — without it your data cannot be decrypted!',
      cls: 'setting-item-description',
    });

    let pw = '';
    let confirm = '';

    new Setting(el)
      .setName('Password')
      .setDesc('Minimum 8 characters')
      .addText(t =>
        t.setPlaceholder('Enter password')
          .then(c => { c.inputEl.type = 'password'; })
          .onChange(v => { pw = v; })
      );

    new Setting(el)
      .setName('Confirm password')
      .addText(t =>
        t.setPlaceholder('Repeat password')
          .then(c => { c.inputEl.type = 'password'; })
          .onChange(v => { confirm = v; })
      );

    new Setting(el).addButton(btn =>
      btn.setButtonText('Create encryption key').setCta().onClick(async () => {
        if (pw.length < 8) {
          new Notice('Password must be at least 8 characters');
          return;
        }
        if (pw !== confirm) {
          new Notice('Passwords do not match');
          return;
        }
        try {
          new Notice('Generating key (may take a few seconds)...');
          const keyData = await this.plugin.cryptoService.initializeKeyFile(pw);
          this.plugin.settings.keyData = keyData;
          this.plugin.rememberSessionPassword(pw);
          await this.plugin.saveSettings();
          new Notice('Encryption key created!');
          this.display();
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          new Notice(`Error: ${message}`);
        }
      })
    );
  }

  private renderKeyStatus(el: HTMLElement): void {
    const unlocked = this.plugin.cryptoService.isUnlocked();

    new Setting(el)
      .setName('Status')
      .setDesc(unlocked ? 'Unlocked' : 'Locked');

    if (!unlocked) {
      let pw = '';
      new Setting(el)
        .setName('Unlock master key')
        .addText(t =>
          t.setPlaceholder('Password')
            .then(c => { c.inputEl.type = 'password'; })
            .onChange(v => { pw = v; })
        )
        .addButton(btn =>
          btn.setButtonText('Unlock').setCta().onClick(async () => {
            try {
              await this.plugin.cryptoService.unlock(pw, this.plugin.settings.keyData!);
              this.plugin.rememberSessionPassword(pw);
              await this.plugin.saveSettings();
              new Notice('Master key unlocked!');
              this.display();
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              new Notice(`Error: ${message}`);
            }
          })
        );
    }

    new Setting(el)
      .setName('Remember password')
      .setDesc('Save password for auto-unlock on startup. Less secure but convenient.')
      .addToggle(t =>
        t.setValue(!!this.plugin.settings.encryptionPassword).onChange(async v => {
          if (v && !this.plugin.getSessionPassword()) {
            new Notice('Unlock the master key before remembering your password');
            this.display();
            return;
          }
          this.plugin.settings.encryptionPassword = v ? this.plugin.getSessionPassword() : '';
          await this.plugin.saveSettings();
        })
      );

    // Change password
    if (unlocked) {
      let oldPw = '';
      let newPw = '';
      let confirmPw = '';

      const details = el.createEl('details');
      details.createEl('summary', { text: 'Change password' });

      new Setting(details)
        .setName('Current password')
        .addText(t =>
          t.then(c => { c.inputEl.type = 'password'; })
            .onChange(v => { oldPw = v; })
        );

      new Setting(details)
        .setName('New password')
        .addText(t =>
          t.then(c => { c.inputEl.type = 'password'; })
            .onChange(v => { newPw = v; })
        );

      new Setting(details)
        .setName('Confirm new password')
        .addText(t =>
          t.then(c => { c.inputEl.type = 'password'; })
            .onChange(v => { confirmPw = v; })
        );

      new Setting(details).addButton(btn =>
        btn.setButtonText('Change password').setWarning().onClick(async () => {
          if (newPw.length < 8) {
            new Notice('New password must be at least 8 characters');
            return;
          }
          if (newPw !== confirmPw) {
            new Notice('New passwords do not match');
            return;
          }
          try {
            const keyData = await this.plugin.cryptoService.changePassword(
              oldPw, newPw, this.plugin.settings.keyData!
            );
            this.plugin.settings.keyData = keyData;
            this.plugin.rememberSessionPassword(newPw);
            await this.plugin.saveSettings();
            new Notice('Password changed successfully!');
            this.display();
          } catch (e: unknown) {
            const message = e instanceof Error ? e.message : String(e);
            new Notice(`Error: ${message}`);
          }
        })
      );
    }
  }

  // ─── Google Drive ─────────────────────────────────────────

  private renderGoogleDriveSection(el: HTMLElement): void {
    new Setting(el).setName('Google Drive').setHeading();

    const details = el.createEl('details');
    details.createEl('summary', { text: 'Setup instructions' });
    const ol = details.createEl('ol');
    ol.createEl('li', { text: 'Go to console.cloud.google.com' });
    ol.createEl('li', { text: 'Create a new project or select an existing one' });
    ol.createEl('li', { text: 'Enable the Google Drive API for your project' });
    ol.createEl('li', { text: 'Navigate to the credentials page and create a new client' });
    ol.createEl('li', { text: 'Choose type "desktop app"' });
    ol.createEl('li', { text: 'Copy client ID and client secret into the fields below' });
    ol.createEl('li').createEl('strong', { text: 'Add yourself as a test user in the consent screen if the app is in "testing" mode' });

    let connectBtn: HTMLButtonElement | null = null;

    const updateConnectBtn = () => {
      if (connectBtn) {
        connectBtn.disabled =
          !this.plugin.settings.googleClientId || !this.plugin.settings.googleClientSecret;
      }
    };

    new Setting(el)
      .setName('Client ID')
      .setDesc('Enter the client ID from your project')
      .addText(t =>
        t.setPlaceholder('...apps.googleusercontent.com')
          .setValue(this.plugin.settings.googleClientId)
          .onChange(async v => {
            this.plugin.settings.googleClientId = v.trim();
            await this.plugin.saveSettings();
            updateConnectBtn();
          })
      );

    new Setting(el)
      .setName('Client secret')
      .addText(t =>
        t.setPlaceholder('Enter client secret')
          .setValue(this.plugin.settings.googleClientSecret)
          .then(c => { c.inputEl.type = 'password'; })
          .onChange(async v => {
            this.plugin.settings.googleClientSecret = v.trim();
            await this.plugin.saveSettings();
            updateConnectBtn();
          })
      );

    const connected = !!this.plugin.settings.googleRefreshToken;

    new Setting(el)
      .setName('Connection')
      .setDesc(connected ? 'Connected to Google Drive' : 'Not connected')
      .addButton(btn => {
        connectBtn = btn.buttonEl;
        btn
          .setButtonText(connected ? 'Reconnect' : 'Connect Google Drive')
          .setCta()
          .setDisabled(!this.plugin.settings.googleClientId || !this.plugin.settings.googleClientSecret)
          .onClick(async () => {
            try {
              new Notice('Opening authorization page...');
              await this.plugin.driveClient.authorize();
              new Notice('Google Drive connected!');
              this.display();
            } catch (e: unknown) {
              const message = e instanceof Error ? e.message : String(e);
              new Notice(`Auth error: ${message}`);
            }
          });
      });

    new Setting(el)
      .setName('Drive folder name')
      .setDesc('Folder for encrypted files on Google Drive')
      .addText(t =>
        t.setValue(this.plugin.settings.driveFolderName).onChange(async v => {
          this.plugin.settings.driveFolderName = v.trim() || 'ObsidianEncryptedSync';
          this.plugin.settings.driveFolderId = '';
          this.plugin.settings.folderCache = {};
          await this.plugin.saveSettings();
        })
      );
  }

  // ─── Sync ─────────────────────────────────────────────────

  private renderSyncSection(el: HTMLElement): void {
    new Setting(el).setName('Sync').setHeading();

    new Setting(el)
      .setName('Auto-sync')
      .setDesc('Automatically sync at a regular interval')
      .addToggle(t =>
        t.setValue(this.plugin.settings.autoSync).onChange(async v => {
          this.plugin.settings.autoSync = v;
          await this.plugin.saveSettings();
          this.plugin.setupAutoSync();
        })
      );

    new Setting(el)
      .setName('Sync interval (minutes)')
      .addText(t =>
        t.setValue(String(this.plugin.settings.syncIntervalMinutes)).onChange(async v => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 1) {
            this.plugin.settings.syncIntervalMinutes = n;
            await this.plugin.saveSettings();
            this.plugin.setupAutoSync();
          }
        })
      );

    new Setting(el)
      .setName('Exclude patterns')
      .setDesc('One pattern per line. Supports: *.ext, folder/, substring')
      .addTextArea(t =>
        t.setValue(this.plugin.settings.excludePatterns.join('\n'))
          .setPlaceholder('*.tmp\nnode_modules/\n.DS_Store')
          .onChange(async v => {
            this.plugin.settings.excludePatterns = v
              .split('\n')
              .map(s => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    const ready =
      this.plugin.cryptoService.isUnlocked() && this.plugin.driveClient.isConfigured();

    new Setting(el)
      .setName('Sync now')
      .setDesc(
        ready
          ? 'Run a manual sync'
          : 'Configure encryption and Google Drive first'
      )
      .addButton(btn =>
        btn
          .setButtonText('Sync')
          .setCta()
          .setDisabled(!ready || this.plugin.syncEngine.isSyncing())
          .onClick(() => this.plugin.runSync())
      );

    const count = Object.keys(this.plugin.settings.syncState).length;
    if (count > 0) {
      new Setting(el)
        .setName('Sync state')
        .setDesc(`Tracked files: ${count}`)
        .addButton(btn =>
          btn.setButtonText('Reset sync state').setWarning().onClick(async () => {
            this.plugin.settings.syncState = {};
            this.plugin.settings.folderCache = {};
            this.plugin.settings.driveFolderId = '';
            await this.plugin.saveSettings();
            new Notice('Sync state reset');
            this.display();
          })
        );
    }
  }
}
