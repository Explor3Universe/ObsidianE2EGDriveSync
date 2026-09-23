const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const { Module } = require('node:module');
const esbuild = require('esbuild');

globalThis.crypto = webcrypto;
globalThis.btoa = (text) => Buffer.from(text, 'binary').toString('base64');
globalThis.atob = (text) => Buffer.from(text, 'base64').toString('binary');

class TFile {
  constructor(path, data) {
    this.path = path;
    this.name = path.split('/').pop();
    this.data = Buffer.from(data);
    this.stat = { mtime: Date.now() };
  }
}

let requestUrl;
function load(file) {
  const built = esbuild.buildSync({
    entryPoints: [`src/${file}.ts`], bundle: true, platform: 'node', format: 'cjs',
    external: ['obsidian'], write: false,
  });
  const mod = new Module(file, module);
  mod.require = (name) => name === 'obsidian'
    ? { TFile, Notice: class {}, requestUrl: (...args) => requestUrl(...args) }
    : require(name);
  mod._compile(built.outputFiles[0].text, `${file}.js`);
  return mod.exports;
}

const { SyncEngine } = load('sync');
const { GoogleDriveClient } = load('gdrive');
const { CryptoService } = load('crypto');

function fixture(local = {}, remote = {}) {
  const files = new Map(Object.entries(local).map(([path, data]) => [path, new TFile(path, data)]));
  const items = new Map(Object.entries(remote).map(([path, data], index) => [path, {
    id: `id-${index}`, name: `${path}.enc`, mimeType: 'application/octet-stream',
    bytes: Buffer.from(data), md5Checksum: createHash('md5').update(data).digest('hex'),
  }]));
  const vault = {
    configDir: '.obsidian',
    getFiles: () => Array.from(files.values()),
    getFileByPath: (path) => files.get(path) || null,
    getFolderByPath: () => true,
    readBinary: async (file) => Uint8Array.from(file.data).buffer,
    modifyBinary: async (file, data) => { file.data = Buffer.from(data); file.stat.mtime = Date.now(); },
    createBinary: async (path, data) => { files.set(path, new TFile(path, data)); },
    createFolder: async () => {},
  };
  const cryptoService = {
    isUnlocked: () => true,
    encrypt: async (data) => data,
    decrypt: async (data) => data,
    hashContent: async (data) => createHash('sha256').update(Buffer.from(data)).digest('hex'),
  };
  const writes = [];
  const drive = {
    isConfigured: () => true,
    findOrCreateFolder: async () => 'root',
    listFiles: async () => Array.from(items.values()),
    downloadFile: async (id) => Uint8Array.from([...items.values()].find((r) => r.id === id).bytes).buffer,
    uploadFile: async (name, data, folderId, id) => {
      const path = name.slice(0, -4);
      const bytes = Buffer.from(data);
      const item = { id: id || `new-${path}`, name, mimeType: 'application/octet-stream', bytes,
        md5Checksum: createHash('md5').update(bytes).digest('hex') };
      items.set(path, item);
      writes.push({ path, id });
      return item;
    },
    deleteFile: async () => { throw new Error('Must never delete remote data'); },
  };
  const settings = { driveFolderId: 'root', syncState: {}, folderCache: {}, excludePatterns: [] };
  let saved = 0;
  const engine = new SyncEngine(vault, cryptoService, drive, settings, async () => { saved++; });
  return { engine, files, items, writes, settings, get saved() { return saved; }, drive };
}

test('a local file missing from a previous sync is restored, never deleted remotely', async () => {
  const f = fixture({}, { 'note.md': 'original' });
  f.settings.syncState['note.md'] = { driveFileId: 'id-0', localMtime: 1, contentHash: '', remoteChecksum: '' };
  await f.engine.performSync();
  assert.equal(f.files.get('note.md').data.toString(), 'original');
  assert.equal(f.items.get('note.md').bytes.toString(), 'original');
});

test('new collision preserves the remote as conflict copy before updating the existing file', async () => {
  const f = fixture({ 'note.md': 'local' }, { 'note.md': 'remote' });
  await f.engine.performSync();
  const conflict = [...f.files.keys()].find((path) => path.startsWith('note (conflict '));
  assert.ok(conflict);
  assert.equal(f.files.get(conflict).data.toString(), 'remote');
  assert.equal(f.items.get('note.md').bytes.toString(), 'local');
  assert.equal(f.writes[0].id, 'id-0');
});

test('remote disappearance re-uploads local content without deleting it', async () => {
  const f = fixture({ 'note.md': 'local' });
  f.settings.syncState['note.md'] = { driveFileId: 'gone', localMtime: f.files.get('note.md').stat.mtime,
    contentHash: 'old', remoteChecksum: 'old' };
  await f.engine.performSync();
  assert.equal(f.items.get('note.md').bytes.toString(), 'local');
  assert.equal(f.writes[0].id, undefined);
});

test('same-time local edit and remote edit create a conflict copy', async () => {
  const f = fixture({ 'note.md': 'new local' }, { 'note.md': 'new remote' });
  const local = f.files.get('note.md');
  f.settings.syncState['note.md'] = {
    driveFileId: 'id-0', localMtime: local.stat.mtime,
    contentHash: 'hash-of-the-old-version', remoteChecksum: 'checksum-of-the-old-version',
  };
  await f.engine.performSync();
  assert.equal(f.items.get('note.md').bytes.toString(), 'new local');
  assert.ok([...f.files.values()].some((file) => file.path.includes('(conflict ') && file.data.toString() === 'new remote'));
});

test('a local edit during a download is not overwritten', async () => {
  const f = fixture({ 'note.md': 'old local' }, { 'note.md': 'new remote' });
  const local = f.files.get('note.md');
  f.settings.syncState['note.md'] = {
    driveFileId: 'id-0', localMtime: local.stat.mtime,
    contentHash: createHash('sha256').update(local.data).digest('hex'),
    remoteChecksum: 'checksum-of-the-old-version',
  };
  const originalDownload = f.drive.downloadFile;
  f.drive.downloadFile = async (id) => {
    local.data = Buffer.from('concurrent local edit');
    return originalDownload(id);
  };
  const previousError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(f.engine.performSync(), /Local file changed while downloading/);
  } finally {
    console.error = previousError;
  }
  assert.equal(local.data.toString(), 'concurrent local edit');
});

test('untrusted remote paths cannot write outside the vault', async () => {
  const f = fixture();
  f.drive.listFiles = async () => [{ id: 'bad', name: '..', mimeType: 'application/vnd.google-apps.folder' }];
  await assert.rejects(f.engine.performSync(), /Unsafe file name/);
  assert.equal(f.files.size, 0);
});

test('incomplete Drive listings fail instead of being treated as an empty folder', async () => {
  requestUrl = async () => ({ json: { nextPageToken: '' } });
  const settings = { googleClientId: 'test', googleRefreshToken: 'refresh',
    googleAccessToken: 'access', googleTokenExpiry: Date.now() + 3600000 };
  const client = new GoogleDriveClient(settings, async () => {});
  await assert.rejects(client.listFiles('root'), /Invalid Google Drive file listing/);
});

test('a failed transfer is reported instead of claiming a successful sync', async () => {
  const f = fixture({ 'note.md': 'local' });
  f.drive.uploadFile = async () => { throw new Error('network failed'); };
  const previousError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(f.engine.performSync(), /network failed/);
  } finally {
    console.error = previousError;
  }
  assert.equal(f.settings.syncState['note.md'], undefined);
});

test('folder lookup requests the fields it validates and searches within root', async () => {
  const calls = [];
  requestUrl = async (options) => {
    calls.push(options);
    return { json: { files: [{ id: 'existing-folder', name: 'Vault', mimeType: 'application/vnd.google-apps.folder' }] } };
  };
  const settings = { googleClientId: 'test', googleRefreshToken: 'refresh',
    googleAccessToken: 'access', googleTokenExpiry: Date.now() + 3600000 };
  const client = new GoogleDriveClient(settings, async () => {});
  assert.equal(await client.findOrCreateFolder('Vault'), 'existing-folder');
  assert.equal(calls.length, 1);
  const query = new URL(calls[0].url).searchParams.get('q');
  assert.match(query, /'root' in parents/);
  assert.equal(new URL(calls[0].url).searchParams.get('fields'), 'files(id,name,mimeType)');
});

test('OAuth loopback rejects wrong state and exchanges a PKCE-bound code', async () => {
  const settings = { googleClientId: 'client-id', googleClientSecret: 'client-secret',
    googleRefreshToken: '', googleAccessToken: '', googleTokenExpiry: 0 };
  let opened;
  let invalidStatus;
  globalThis.window = {
    setTimeout,
    clearTimeout,
    open: (url) => {
      opened = new URL(url);
      const redirect = new URL(opened.searchParams.get('redirect_uri'));
      void (async () => {
        const invalid = new URL(redirect);
        invalid.searchParams.set('state', 'wrong-state');
        invalid.searchParams.set('code', 'bad-code');
        invalidStatus = (await fetch(invalid)).status;
        redirect.searchParams.set('state', opened.searchParams.get('state'));
        redirect.searchParams.set('code', 'good-code');
        await fetch(redirect);
      })();
      return {};
    },
  };
  requestUrl = async (options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('code'), 'good-code');
    const hash = createHash('sha256').update(body.get('code_verifier')).digest('base64url');
    assert.equal(opened.searchParams.get('code_challenge'), hash);
    assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
    return { json: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 } };
  };
  const client = new GoogleDriveClient(settings, async (updates) => Object.assign(settings, updates));
  await client.authorize();
  assert.equal(invalidStatus, 400);
  assert.equal(settings.googleRefreshToken, 'new-refresh');
  delete globalThis.window;
});

test('encryption survives password change; old password no longer unlocks', async () => {
  const crypto = new CryptoService();
  const key = await crypto.initializeKeyFile('first-password');
  const text = new TextEncoder().encode('original notes').buffer;
  const ciphertext = await crypto.encrypt(text);
  const nextKey = await crypto.changePassword('first-password', 'second-password', key);
  crypto.lock();
  await assert.rejects(crypto.unlock('first-password', nextKey));
  await crypto.unlock('second-password', nextKey);
  assert.equal(Buffer.from(await crypto.decrypt(ciphertext)).toString(), 'original notes');
});
