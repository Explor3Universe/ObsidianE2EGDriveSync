# E2E Google Drive Sync

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

### From Community Plugins (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **E2E Google Drive Sync**.
3. Click **Install**, then **Enable**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/Explor3Universe/ObsidianE2EGDriveSync/releases/latest).
2. Create a folder: `<your-vault>/.obsidian/plugins/e2e-gdrive-sync/`
3. Place the three files inside it.
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

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

Open **Settings → E2E Google Drive Sync**:

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
| File deleted locally | Delete from Google Drive |
| File deleted remotely | Remove sync record |
| Both sides modified | Create a conflict copy, upload local version |

Default exclusions: `.obsidian/`, `.trash/`, `.git/`. Additional patterns can be configured in settings.

## Security

- Encryption uses the **Web Crypto API** (`crypto.subtle`), not a custom implementation.
- **AES-256-GCM** provides authenticated encryption — any tampering is detected.
- The master key is wrapped (encrypted) with a key derived from your password. The raw master key is never written to disk.
- The password can optionally be saved in plugin settings for auto-unlock. If you prefer, you can enter it manually each session.
- Google Drive scope is `drive.file` — the plugin can only access files it created.

## Building from source

```bash
npm install
npm run build      # production build
npm run dev        # watch mode
```

## License

[MIT](LICENSE)
