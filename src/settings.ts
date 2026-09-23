import { App, Notice, PluginSettingTab } from 'obsidian';
import type { SettingDefinitionAction, SettingDefinitionItem, SettingDefinitionRender } from 'obsidian';
import type E2EGDriveSyncPlugin from './main';

type PasswordField = 'password' | 'confirmation' | 'oldPassword' | 'newPassword' | 'newConfirmation';

export class E2EGDriveSyncSettingTab extends PluginSettingTab {
  plugin: E2EGDriveSyncPlugin;
  private busy = false;
  private inputs: Record<PasswordField, string> = {
    password: '', confirmation: '', oldPassword: '', newPassword: '', newConfirmation: '',
  };

  constructor(app: App, plugin: E2EGDriveSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const hasKey = () => !!this.plugin.settings.keyData;
    const unlocked = () => this.plugin.cryptoService.isUnlocked();
    const lockedControls = () => this.busy || this.plugin.syncEngine.isSyncing();

    return [
      {
        type: 'group', heading: 'Encryption', items: [
          { name: 'Status', desc: hasKey() ? (unlocked() ? 'Unlocked' : 'Locked') : 'Create an encryption key to begin.' },
          this.passwordInput('Password', 'password', () => !hasKey(), 'Minimum 8 characters.'),
          this.passwordInput('Confirm password', 'confirmation', () => !hasKey()),
          this.actionSetting('Create encryption key', async () => {
            const { password, confirmation } = this.inputs;
            this.validatePassword(password, confirmation);
            const keyData = await this.plugin.cryptoService.initializeKeyFile(password);
            this.plugin.settings.keyData = keyData;
            this.plugin.rememberSessionPassword(password);
            await this.plugin.saveSettings();
            this.clearInputs();
            new Notice('Encryption key created');
          }, () => !hasKey()),
          this.passwordInput('Unlock password', 'password', () => hasKey() && !unlocked()),
          this.actionSetting('Unlock master key', async () => {
            const keyData = this.plugin.settings.keyData;
            if (!keyData) throw new Error('Create an encryption key first');
            await this.plugin.cryptoService.unlock(this.inputs.password, keyData);
            this.plugin.rememberSessionPassword(this.inputs.password);
            await this.plugin.saveSettings();
            this.clearInputs();
          }, () => hasKey() && !unlocked()),
          {
            name: 'Remember password',
            desc: 'Store the password in local plugin data for automatic unlocking.',
            visible: hasKey,
            control: { type: 'toggle', key: 'rememberPassword', disabled: () => !unlocked() || lockedControls() },
          },
        ],
      },
      {
        type: 'page', name: 'Change password', visible: () => hasKey() && unlocked(), items: [
          this.passwordInput('Current password', 'oldPassword'),
          this.passwordInput('New password', 'newPassword', undefined, 'Minimum 8 characters.'),
          this.passwordInput('Confirm new password', 'newConfirmation'),
          this.actionSetting('Change password', async () => {
            const { oldPassword, newPassword, newConfirmation } = this.inputs;
            this.validatePassword(newPassword, newConfirmation);
            const keyData = this.plugin.settings.keyData;
            if (!keyData) throw new Error('Create an encryption key first');
            this.plugin.settings.keyData = await this.plugin.cryptoService.changePassword(oldPassword, newPassword, keyData);
            this.plugin.rememberSessionPassword(newPassword);
            await this.plugin.saveSettings();
            this.clearInputs();
            new Notice('Password changed');
          }),
        ],
      },
      {
        type: 'group', heading: 'Google Drive', items: [
          {
            name: 'Setup instructions', desc: 'Create your own desktop authorization client in the Google console.',
            action: () => { window.open('https://github.com/Explor3Universe/ObsidianE2EGDriveSync#setup'); },
          },
          {
            name: 'Client ID', desc: 'Enter the client ID from your project.',
            control: { type: 'text', key: 'googleClientId', placeholder: '...apps.googleusercontent.com', disabled: lockedControls },
          },
          {
            name: 'Client secret',
            render: setting => {
              setting.addText(text => text
                .setValue(this.plugin.settings.googleClientSecret)
                .setDisabled(lockedControls())
                .then(component => { component.inputEl.type = 'password'; })
                .onChange(async value => { await this.setControlValue('googleClientSecret', value); }));
            },
          },
          this.actionSetting('Connect Google Drive', async () => {
            new Notice('Opening authorization page...');
            await this.plugin.driveClient.authorize();
            new Notice('Google Drive connected');
          }, undefined, () => !this.plugin.settings.googleClientId || !this.plugin.settings.googleClientSecret,
          this.plugin.driveClient.isConfigured() ? 'Connected. Click to reconnect.' : 'Not connected.'),
          {
            name: 'Drive folder name', desc: 'Folder for encrypted files on Google Drive.',
            control: { type: 'text', key: 'driveFolderName', disabled: lockedControls,
              validate: value => value.trim() ? undefined : 'Enter a folder name.' },
          },
        ],
      },
      {
        type: 'group', heading: 'Sync', items: [
          {
            name: 'Auto-sync', desc: 'Automatically sync at a regular interval.',
            control: { type: 'toggle', key: 'autoSync' },
          },
          {
            name: 'Sync interval (minutes)',
            control: { type: 'number', key: 'syncIntervalMinutes', min: 1, max: 10080, step: 1,
              validate: value => Number.isInteger(value) ? undefined : 'Enter a whole number of minutes.' },
          },
          this.actionSetting('Sync now', () => this.plugin.runSync(), undefined,
            () => !unlocked() || !this.plugin.driveClient.isConfigured()),
          this.actionSetting('Reset sync state', async () => {
            this.plugin.settings.syncState = {};
            this.resetFolderCache();
            await this.plugin.saveSettings();
            new Notice('Sync state reset');
          }, undefined, undefined, `Tracked files: ${Object.keys(this.plugin.settings.syncState).length}`),
          {
            name: 'Exclude patterns', desc: 'One pattern per line: *.ext, folder/, or a substring.',
            control: { type: 'textarea', key: 'excludePatterns', placeholder: '*.tmp\nnode_modules/\n.DS_Store', disabled: lockedControls },
          },
        ],
      },
    ];
  }

  getControlValue(key: string): unknown {
    const settings = this.plugin.settings;
    switch (key) {
      case 'rememberPassword': return !!settings.encryptionPassword;
      case 'excludePatterns': return settings.excludePatterns.join('\n');
      case 'googleClientId': return settings.googleClientId;
      case 'driveFolderName': return settings.driveFolderName;
      case 'autoSync': return settings.autoSync;
      case 'syncIntervalMinutes': return settings.syncIntervalMinutes;
      default: return undefined;
    }
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const settings = this.plugin.settings;
    if (this.plugin.syncEngine.isSyncing() && key !== 'autoSync' && key !== 'syncIntervalMinutes') {
      throw new Error('Wait for the current sync to finish before changing this setting');
    }
    switch (key) {
      case 'rememberPassword':
        if (typeof value !== 'boolean') throw new Error('Invalid password preference');
        if (value && (!this.plugin.cryptoService.isUnlocked() || !this.plugin.getSessionPassword())) {
          throw new Error('Unlock the master key before remembering your password');
        }
        settings.encryptionPassword = value ? this.plugin.getSessionPassword() : '';
        break;
      case 'excludePatterns':
        if (typeof value !== 'string') throw new Error('Invalid exclude patterns');
        settings.excludePatterns = value.split('\n').map(pattern => pattern.trim()).filter(Boolean);
        break;
      case 'googleClientId':
      case 'googleClientSecret':
        if (typeof value !== 'string') throw new Error('Invalid client credentials');
        if (settings[key] !== value.trim()) {
          settings[key] = value.trim();
          settings.googleAccessToken = '';
          settings.googleRefreshToken = '';
          settings.googleTokenExpiry = 0;
          this.resetFolderCache();
        }
        break;
      case 'driveFolderName':
        if (typeof value !== 'string' || !value.trim()) throw new Error('Enter a folder name');
        if (settings.driveFolderName !== value.trim()) {
          settings.driveFolderName = value.trim();
          this.resetFolderCache();
        }
        break;
      case 'autoSync':
        if (typeof value !== 'boolean') throw new Error('Invalid auto-sync preference');
        settings.autoSync = value;
        break;
      case 'syncIntervalMinutes':
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10080) {
          throw new Error('Sync interval must be a whole number between 1 and 10080 minutes');
        }
        settings.syncIntervalMinutes = value;
        break;
      default: throw new Error(`Unknown setting: ${key}`);
    }
    await this.plugin.saveSettings();
    if (key === 'autoSync' || key === 'syncIntervalMinutes') this.plugin.setupAutoSync();
    this.refreshDomState();
  }

  hide(): void {
    this.clearInputs();
  }

  private resetFolderCache(): void {
    this.plugin.settings.driveFolderId = '';
    this.plugin.settings.folderCache = {};
  }

  private passwordInput(
    name: string, field: PasswordField, visible?: () => boolean, desc?: string
  ): SettingDefinitionRender {
    return {
      name, desc, visible,
      render: setting => {
        setting.addText(text => text
          .setValue(this.inputs[field])
          .setDisabled(this.busy || this.plugin.syncEngine.isSyncing())
          .then(component => { component.inputEl.type = 'password'; })
          .onChange(value => { this.inputs[field] = value; }));
      },
    };
  }

  private actionSetting(
    name: string, action: () => Promise<void>, visible?: () => boolean,
    disabled?: () => boolean, desc?: string
  ): SettingDefinitionAction {
    return {
      name, desc, visible,
      disabled: () => this.busy || this.plugin.syncEngine.isSyncing() || !!disabled?.(),
      action: () => { void this.runAction(action, disabled); },
    };
  }

  private async runAction(action: () => Promise<void>, disabled?: () => boolean): Promise<void> {
    if (this.busy || this.plugin.syncEngine.isSyncing() || disabled?.()) return;
    this.busy = true;
    this.update();
    try {
      await action();
    } catch (error: unknown) {
      new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.update();
    }
  }

  private validatePassword(password: string, confirmation: string): void {
    if (password.length < 8) throw new Error('Password must be at least 8 characters');
    if (password !== confirmation) throw new Error('Passwords do not match');
  }

  private clearInputs(): void {
    this.inputs = { password: '', confirmation: '', oldPassword: '', newPassword: '', newConfirmation: '' };
  }
}
