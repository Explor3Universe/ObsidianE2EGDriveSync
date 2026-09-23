import { requestUrl } from 'obsidian';
import { DriveFile, PluginSettings } from './types';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface DriveListResponse {
  files: DriveFile[];
  nextPageToken?: string;
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class GoogleDriveClient {
  private settings: PluginSettings;
  private onTokenUpdate: (updates: Partial<PluginSettings>) => Promise<void>;

  constructor(
    settings: PluginSettings,
    onTokenUpdate: (updates: Partial<PluginSettings>) => Promise<void>
  ) {
    this.settings = settings;
    this.onTokenUpdate = onTokenUpdate;
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  isConfigured(): boolean {
    return !!(this.settings.googleClientId && this.settings.googleRefreshToken);
  }

  // --- OAuth 2.0 with loopback redirect ---

  async authorize(): Promise<void> {
    const http = await import('http');
    const randomHex = (length: number) => Array.from(
      crypto.getRandomValues(new Uint8Array(length)),
      byte => byte.toString(16).padStart(2, '0')
    ).join('');
    const verifier = randomHex(32);
    const state = randomHex(16);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    return new Promise((resolve, reject) => {
      let finished = false;
      let exchanging = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (server.listening) server.close();
        if (error) reject(error);
        else resolve();
      };

      const server = http.createServer((req, res) => {
        if (finished || exchanging || !req.url) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Invalid request');
          return;
        }

        void (async () => {
          try {
            const url = new URL(req.url!, 'http://127.0.0.1');
            if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('Invalid OAuth state');
              return;
            }
            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.authPage(`Error: ${error}`, false));
              finish(new Error(`OAuth error: ${error}`));
              return;
            }

            if (!code) {
              res.writeHead(400, { 'Content-Type': 'text/plain' });
              res.end('Missing code parameter');
              return;
            }

            exchanging = true;
            const port = (server.address() as { port: number }).port;
            const tokens = await this.exchangeCode(code, `http://127.0.0.1:${port}`, verifier);
            if (finished) return;

            await this.onTokenUpdate({
              googleAccessToken: tokens.access_token,
              googleRefreshToken: tokens.refresh_token || this.settings.googleRefreshToken,
              googleTokenExpiry: Date.now() + tokens.expires_in * 1000,
            });

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.authPage('Authorization successful! You can close this tab.', true));
            finish();
          } catch (e: unknown) {
            if (!finished) {
              const message = e instanceof Error ? e.message : String(e);
              res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(this.authPage(`Error: ${message}`, false));
              finish(e instanceof Error ? e : new Error(message));
            }
          }
        })();
      });

      server.on('error', (error) => finish(error));
      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as { port: number }).port;
        const params = new URLSearchParams({
          client_id: this.settings.googleClientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: 'code',
          scope: SCOPE,
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        });
        try {
          window.open(`${GOOGLE_AUTH_URL}?${params}`);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });

      timer = setTimeout(() => finish(new Error('OAuth timeout — no response within 5 minutes')), 300000);
    });
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private authPage(message: string, success: boolean): string {
    const color = success ? '#4caf50' : '#f44336';
    const icon = success ? '&#10004;' : '&#10008;';
    const safeMessage = this.escapeHtml(message);
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;
      align-items:center;min-height:100vh;margin:0;background:#1e1e1e;color:#fff}
      .card{text-align:center;padding:3em;border-radius:12px;background:#2d2d2d}
      .icon{font-size:3em;color:${color}}</style></head>
      <body><div class="card"><div class="icon">${icon}</div>
      <h1>${safeMessage}</h1><p>Return to Obsidian.</p></div></body></html>`;
  }

  private readToken(value: unknown): TokenResponse {
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid token response');
    }
    const data = value as Record<string, unknown>;
    if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number') {
      throw new Error('Invalid token response');
    }
    return {
      access_token: data.access_token,
      expires_in: data.expires_in,
      refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    };
  }

  private readDriveList(value: unknown): DriveListResponse {
    if (!value || typeof value !== 'object') throw new Error('Invalid Google Drive file listing');
    const data = value as Record<string, unknown>;
    if (!Array.isArray(data.files)) throw new Error('Invalid Google Drive file listing');
    const files = data.files.map((item): DriveFile => {
      if (!item || typeof item !== 'object') throw new Error('Invalid Google Drive file listing');
      const file = item as Record<string, unknown>;
      if (typeof file.id !== 'string' || typeof file.name !== 'string' || typeof file.mimeType !== 'string') {
        throw new Error('Invalid Google Drive file listing');
      }
      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        modifiedTime: typeof file.modifiedTime === 'string' ? file.modifiedTime : undefined,
        md5Checksum: typeof file.md5Checksum === 'string' ? file.md5Checksum : undefined,
        size: typeof file.size === 'string' ? file.size : undefined,
      };
    });
    return {
      files,
      nextPageToken: typeof data.nextPageToken === 'string' ? data.nextPageToken : undefined,
    };
  }

  private readDriveFile(value: unknown): DriveFile {
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid Google Drive response');
    }
    const data = value as Record<string, unknown>;
    if (typeof data.id !== 'string' || typeof data.name !== 'string') {
      throw new Error('Invalid Google Drive response');
    }
    return {
      id: data.id,
      name: data.name,
      mimeType: typeof data.mimeType === 'string' ? data.mimeType : 'application/octet-stream',
      modifiedTime: typeof data.modifiedTime === 'string' ? data.modifiedTime : undefined,
      md5Checksum: typeof data.md5Checksum === 'string' ? data.md5Checksum : undefined,
      size: typeof data.size === 'string' ? data.size : undefined,
    };
  }

  private readDriveId(value: unknown): string {
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid Google Drive response');
    }
    const data = value as Record<string, unknown>;
    if (typeof data.id !== 'string') {
      throw new Error('Invalid Google Drive response');
    }
    return data.id;
  }

  private async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<TokenResponse> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.settings.googleClientId,
        client_secret: this.settings.googleClientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
    return this.readToken(response.json);
  }

  // --- Token management ---

  async ensureToken(): Promise<void> {
    if (!this.settings.googleRefreshToken) {
      throw new Error('Not authorized with Google Drive');
    }
    if (this.settings.googleAccessToken && Date.now() < this.settings.googleTokenExpiry - 60000) {
      return;
    }
    await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<void> {
    const response = await requestUrl({
      url: GOOGLE_TOKEN_URL,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.settings.googleClientId,
        client_secret: this.settings.googleClientSecret,
        refresh_token: this.settings.googleRefreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });

    const data = this.readToken(response.json);
    await this.onTokenUpdate({
      googleAccessToken: data.access_token,
      googleTokenExpiry: Date.now() + data.expires_in * 1000,
    });
  }

  private get authHeaders(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.settings.googleAccessToken}` };
  }

  // --- File operations ---

  async findOrCreateFolder(name: string, parentId?: string): Promise<string> {
    await this.ensureToken();

    const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `name = '${escapedName}' and mimeType = '${FOLDER_MIME}' ` +
      `and trashed = false and '${parentId || 'root'}' in parents`;

    const search = await requestUrl({
      url: `${DRIVE_API}/files?${new URLSearchParams({
        q, fields: 'files(id,name,mimeType)', pageSize: '2',
      })}`,
      headers: this.authHeaders,
    });

    const found = this.readDriveList(search.json).files;
    if (found.length > 1) {
      throw new Error(`Multiple Google Drive folders named "${name}"; rename the duplicate before syncing`);
    }
    if (found.length > 0) {
      return found[0].id;
    }

    const metadata: { name: string; mimeType: string; parents?: string[] } = { name, mimeType: FOLDER_MIME };
    if (parentId) metadata.parents = [parentId];

    const create = await requestUrl({
      url: `${DRIVE_API}/files`,
      method: 'POST',
      headers: { ...this.authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });

    return this.readDriveId(create.json);
  }

  async listFiles(folderId: string): Promise<DriveFile[]> {
    await this.ensureToken();

    const files: DriveFile[] = [];
    let pageToken = '';

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size)',
        pageSize: '1000',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const response = await requestUrl({
        url: `${DRIVE_API}/files?${params}`,
        headers: this.authHeaders,
      });

      const page = this.readDriveList(response.json);
      files.push(...page.files);
      pageToken = page.nextPageToken || '';
    } while (pageToken);

    return files;
  }

  async uploadFile(
    name: string,
    data: ArrayBuffer,
    folderId: string,
    existingFileId?: string
  ): Promise<DriveFile> {
    await this.ensureToken();

    const boundary = '----E2EGDriveSyncBoundary' + Date.now();
    const fields = 'id,name,md5Checksum,modifiedTime';

    if (existingFileId) {
      // Update existing file
      const body = this.buildMultipartBody(boundary, { name }, data);
      const response = await requestUrl({
        url: `${DRIVE_UPLOAD}/files/${existingFileId}?uploadType=multipart&fields=${fields}`,
        method: 'PATCH',
        headers: {
          ...this.authHeaders,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
      });
      return this.readDriveFile(response.json);
    } else {
      // Create new file
      const body = this.buildMultipartBody(boundary, { name, parents: [folderId] }, data);
      const response = await requestUrl({
        url: `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=${fields}`,
        method: 'POST',
        headers: {
          ...this.authHeaders,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: body,
      });
      return this.readDriveFile(response.json);
    }
  }

  async downloadFile(fileId: string): Promise<ArrayBuffer> {
    await this.ensureToken();

    const response = await requestUrl({
      url: `${DRIVE_API}/files/${fileId}?alt=media`,
      headers: this.authHeaders,
    });

    return response.arrayBuffer;
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.ensureToken();

    await requestUrl({
      url: `${DRIVE_API}/files/${fileId}`,
      method: 'DELETE',
      headers: this.authHeaders,
    });
  }

  // --- Helpers ---

  private buildMultipartBody(
    boundary: string,
    metadata: { name: string; parents?: string[] },
    fileData: ArrayBuffer
  ): ArrayBuffer {
    const metaJson = JSON.stringify(metadata);
    const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const footer = `\r\n--${boundary}--`;

    const headerBytes = new TextEncoder().encode(header);
    const footerBytes = new TextEncoder().encode(footer);
    const fileBytes = new Uint8Array(fileData);

    const result = new Uint8Array(headerBytes.length + fileBytes.length + footerBytes.length);
    result.set(headerBytes, 0);
    result.set(fileBytes, headerBytes.length);
    result.set(footerBytes, headerBytes.length + fileBytes.length);

    return result.buffer;
  }
}
