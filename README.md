# Encrypted Google Drive Sync

Syncs your vault with Google Drive, encrypting all data with AES-256 before upload and storing keys exclusively on your device.

This plugin needs your own Google account and a Google Cloud OAuth client. It sends authorization and encrypted file data only to Google (`accounts.google.com`, `oauth2.googleapis.com`, and `www.googleapis.com`). It does not upload your vault to any other server.

## Features

- **End-to-end encryption** — AES-256-GCM via Web Crypto API. Files are encrypted before leaving your machine.
- **Two-layer key hierarchy** — A random master key encrypts your files; a password-derived key (PBKDF2, 600 000 iterations) protects the master key. Changing your password does not require re-encrypting the entire vault.
- **Bidirectional sync** — Uploads local changes, downloads remote changes, detects and resolves conflicts.
- **Folder structure preserved** — Your vault's directory tree is mirrored on Google Drive.
- **Auto-sync** — Optional periodic sync at a configurable interval.
- **Desktop only** — Uses Node.js for the OAuth loopback flow.

## How it works

```
Password
  │  PBKDF2 (SHA-256, 600K iterations, random salt)
  ▼
Password-Derived Key
  │  AES-256-GCM wrap/unwrap
  ▼
Master Encryption Key  ← stored wrapped in plugin data
  │  AES-256-GCM (unique 12-byte IV per file)
  ▼
Encrypted file: [version · 1B] [IV · 12B] [ciphertext + auth tag]
```

Each file is encrypted independently with a fresh IV. The master key never leaves your device in plaintext.

## Installation

### From Community Plugins (once published in the app catalog)

1. Open **Settings → Community plugins → Browse**.
2. Search for **Encrypted Google Drive Sync**.
3. Click **Install**, then **Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Explor3Universe/ObsidianE2EGDriveSync/releases/latest).
2. Create a folder: `<your-vault>/.obsidian/plugins/encrypted-gdrive-sync/` (use your vault's configured settings folder if it is not `.obsidian`).
3. Place the three files inside it.
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

### Upgrading a manually installed version 1.0.x

Versions 1.1.x use the directory-compliant ID `encrypted-gdrive-sync`, and version 1.1.1 adopts the name **Encrypted Google Drive Sync**. The encrypted file format is unchanged.

1. Disable the old plugin and close Obsidian.
2. Back up the old `e2e-gdrive-sync` plugin folder, including its `data.json`.
3. Install the new release in `encrypted-gdrive-sync` as described above.
4. Copy the existing `data.json` to the new plugin folder. It contains your wrapped encryption key, Google authorization, and sync state. **Keep the original key data** to decrypt the existing backup.
5. Reopen Obsidian and enable only the new installation. Unlock it using your existing password.

## Setup

### 1. Create a Google Cloud project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or use an existing one).
3. Navigate to **APIs & Services → Library** and enable **Google Drive API**.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
5. Select application type **Desktop app**.
6. Copy the **Client ID** and **Client Secret**.

> If your app is in "Testing" mode, add your Google account as a test user under **OAuth consent screen → Test users**.

### 2. Configure the plugin

Open **Settings → Encrypted Google Drive Sync**:

1. **Encryption** — Set a password (minimum 8 characters). This generates your master encryption key.
2. **Google Drive** — Paste the Client ID and Client Secret, then click **Connect Google Drive**. A browser window will open for authorization.
3. **Sync** — Click **Sync** or use the ribbon icon. Optionally enable auto-sync.

## Sync behavior

| Scenario | Action |
|---|---|
| New local file | Encrypt → upload |
| New remote file | Download → decrypt |
| Local file modified | Re-encrypt → upload |
| Remote file modified | Download → re-decrypt |
| File deleted locally | Restore from Google Drive (no automatic deletion) |
| File deleted remotely | Re-upload local copy (no automatic deletion) |
| Both sides modified or both exist without a previous sync record | Create a local conflict copy of the remote version, upload local version |

Default exclusions: `.obsidian/`, `.trash/`, `.git/`. Additional patterns can be configured in settings.

Deletion is intentionally not propagated: removing a file on one side restores it from the other. To remove a synced file permanently, delete it on every device and on Google Drive before syncing again. Back up your vault before the first sync. To decrypt an existing Drive backup on a second device, securely transfer the original plugin's key data (`keyData` in its `data.json`) and use the same Google Cloud OAuth client; a new password/key or an unrelated Google OAuth app cannot access the existing backup.

## Security

- Encryption uses the **Web Crypto API** (`crypto.subtle`), not a custom implementation.
- **AES-256-GCM** provides authenticated encryption — any tampering is detected.
- The master key is wrapped (encrypted) with a key derived from your password. The raw master key is never written to disk.
- By default the password is kept only for the current session. "Remember password" stores it in Obsidian's plugin data for auto-unlock; turn this on only if you accept that anyone with access to the vault configuration can read it.
- Google Drive scope is `drive.file` — the plugin can only access files it created.

## Building from source

```bash
npm install
npm run build      # production build
npm run dev        # watch mode
```

## License

[MIT](LICENSE)
