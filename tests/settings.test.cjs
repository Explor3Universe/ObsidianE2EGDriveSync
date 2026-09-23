const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('node:module');
const esbuild = require('esbuild');

const built = esbuild.buildSync({
  entryPoints: ['src/settings.ts'], bundle: true, platform: 'node', format: 'cjs',
  external: ['obsidian'], write: false,
});
class PluginSettingTab {
  update() {}
  refreshDomState() {}
}
const mod = new Module('settings', module);
mod.require = (name) => name === 'obsidian' ? { PluginSettingTab, Notice: class {} } : require(name);
mod._compile(built.outputFiles[0].text, 'settings.js');
const { E2EGDriveSyncSettingTab } = mod.exports;

function fixture() {
  let syncing = false;
  const calls = { saves: 0, timers: 0 };
  const plugin = {
    settings: {
      encryptionPassword: '', keyData: {}, googleClientId: '', googleClientSecret: '',
      googleAccessToken: 'old-access', googleRefreshToken: 'old-refresh', googleTokenExpiry: 123,
      driveFolderName: 'Backup', driveFolderId: 'old-folder', folderCache: { sub: 'old-sub' },
      syncState: {}, excludePatterns: [], autoSync: false, syncIntervalMinutes: 30,
    },
    cryptoService: { isUnlocked: () => true },
    driveClient: { isConfigured: () => true },
    syncEngine: { isSyncing: () => syncing },
    getSessionPassword: () => 'session-only-password',
    saveSettings: async () => { calls.saves++; },
    setupAutoSync: () => { calls.timers++; },
  };
  const tab = new E2EGDriveSyncSettingTab({}, plugin);
  return { tab, plugin, calls, beginSync: () => { syncing = true; } };
}

function definitions(items) {
  return items.flatMap(item => [item, ...definitions(item.items || [])]);
}

test('declarative settings expose named searchable controls without doing I/O', () => {
  const f = fixture();
  const items = definitions(f.tab.getSettingDefinitions());
  for (const name of ['Client ID', 'Client secret', 'Remember password', 'Auto-sync', 'Sync interval (minutes)', 'Exclude patterns']) {
    assert.ok(items.some(item => item.name === name), name);
  }
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.timers, 0);
});

test('password persistence is opt-in and can be disabled', async () => {
  const f = fixture();
  assert.equal(f.tab.getControlValue('rememberPassword'), false);
  await f.tab.setControlValue('rememberPassword', true);
  assert.equal(f.plugin.settings.encryptionPassword, 'session-only-password');
  await f.tab.setControlValue('rememberPassword', false);
  assert.equal(f.plugin.settings.encryptionPassword, '');
});

test('changing interval persists and updates the timer; invalid values do neither', async () => {
  const f = fixture();
  await f.tab.setControlValue('syncIntervalMinutes', 10);
  assert.equal(f.plugin.settings.syncIntervalMinutes, 10);
  assert.deepEqual(f.calls, { saves: 1, timers: 1 });
  for (const value of [0, -1, 2.5, NaN, Infinity, '5']) {
    await assert.rejects(f.tab.setControlValue('syncIntervalMinutes', value));
  }
  assert.deepEqual(f.calls, { saves: 1, timers: 1 });
});

test('connecting after entering credentials becomes possible without reopening settings', async () => {
  const f = fixture();
  const connect = definitions(f.tab.getSettingDefinitions()).find(item => item.name === 'Connect Google Drive');
  assert.equal(connect.disabled(), true);
  await f.tab.setControlValue('googleClientId', 'new-client');
  await f.tab.setControlValue('googleClientSecret', 'new-secret');
  assert.equal(connect.disabled(), false);
  assert.equal(f.plugin.settings.googleRefreshToken, '');
  assert.equal(f.plugin.settings.driveFolderId, '');
  assert.deepEqual(f.plugin.settings.folderCache, {});
});

test('connection and exclusions cannot change during a running sync', async () => {
  const f = fixture();
  f.beginSync();
  for (const key of ['googleClientId', 'googleClientSecret', 'driveFolderName', 'excludePatterns']) {
    await assert.rejects(f.tab.setControlValue(key, 'changed'), /current sync/);
  }
  assert.equal(f.calls.saves, 0);
  assert.equal(f.plugin.settings.googleAccessToken, 'old-access');
});

test('exclude patterns round-trip between settings UI and stored array', async () => {
  const f = fixture();
  await f.tab.setControlValue('excludePatterns', ' *.tmp \n\n private/ ');
  assert.deepEqual(f.plugin.settings.excludePatterns, ['*.tmp', 'private/']);
  assert.equal(f.tab.getControlValue('excludePatterns'), '*.tmp\nprivate/');
});
