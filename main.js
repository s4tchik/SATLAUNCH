'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage, session, screen } = require('electron');

// Electron single-instance lock: repeated launches focus the existing window instead
// of creating duplicate launchers. Keep the lock before app.whenReady().
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
        mainWindow.moveTop();
      } else if (app.isReady()) {
        createWindow();
      }
    } catch (error) {
      try { log(`Не удалось активировать существующее окно: ${error.message}`, 'warn'); } catch {}
    }
  });
}

// This is a desktop launcher, so persistent background audio is an intentional app feature.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const { detectWorldArchiveRoot, getWorldRelativePath } = require('./src/core/world-archive');
const { normalizeModrinthProjectType, selectModrinthVersion } = require('./src/core/modrinth-version');
const { getRequiredModrinthDependencies, isRequiredDependencyInstalled, selectLegacyMixinBooterRelease, IRIS_PROJECT_ID, SODIUM_PROJECT_ID, normalizeModVersion, isVersionInSeries, getKnownModrinthDependencyConstraint, getSodiumSeriesRequiredByInstalledIris } = require('./src/core/modrinth-dependencies');
const { LEGACY_MIXINBOOTER_CLASS, inspectLegacyMixinBooterDependency } = require('./src/core/legacy-mod-dependencies');
const { normalizeLoaderProfile } = require('./src/core/loader-profile');
const { parseYandexDownloadInfoXml, buildYandexDirectMp3Url } = require('./src/core/yandex-stream');
const { isMinecraftVersionInstalled, assertMinecraftVersionInstalled } = require('./src/core/minecraft-version-installed');
const { seedInstalledMinecraftVersion } = require('./src/core/instance-version-bootstrap');
const { ensureSharedSaves } = require('./src/core/shared-saves');
const { withLocalSkinProvider } = require('./src/core/local-skin-config');
const { isSourceRepositoryUrl } = require('./src/core/repository-link-guard');
const { isNoPublishedReleaseError } = require('./src/core/update-error');
const { resolveMemoryBudget } = require('./src/core/memory-budget');
const { javaCompatibility } = require('./src/core/java-version');
const { shouldAutoTryVulkan, shouldRollbackAutoVulkan, inspectLatestLaunchForInstance } = require('./src/core/graphics-backend-fallback');
const { listInstanceContent, removeInstanceContentFiles } = require('./src/core/instance-content');
const { normalizeResourcePackArchive, normalizeResourcePackDirectory, walkFiles } = require('./src/core/resourcepack-normalizer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable, Transform } = require('stream');

const APP_DIR = path.join(app.getPath('userData'), 'sat-launcher');
const INITIAL_VERSION_MIGRATION_FLAG = path.join(APP_DIR, '.update-v1.0.0-migration-complete');
const INSTANCES_DIR = path.join(APP_DIR, 'instances');
const SHARED_SAVES_DIR = path.join(APP_DIR, 'shared-saves');
const RUNTIMES_DIR = path.join(APP_DIR, 'runtimes');
const CACHE_DIR = path.join(APP_DIR, 'cache');
const MINECRAFT_ASSETS_DIR = path.join(APP_DIR, 'assets', 'minecraft');
const SKINS_DIR = path.join(APP_DIR, 'skins');
const SETTINGS_FILE = path.join(APP_DIR, 'settings.json');
const INSTANCES_FILE = path.join(APP_DIR, 'instances.json');
const PROFILE_FILE = path.join(APP_DIR, 'profile.json');
const PROFILES_FILE = path.join(APP_DIR, 'profiles.json');
const AUTH_FILE = path.join(APP_DIR, 'auth.bin');
const YANDEX_MUSIC_TOKEN_FILE = path.join(APP_DIR, 'yandex-music-token.bin');
const LOG_FILE = path.join(APP_DIR, 'launcher.log');
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const RUNTIME_INDEX = 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
const MODRINTH_API = 'https://api.modrinth.com/v2';
const INSIDE_BASE = 'https://minecraft-inside.ru';
const APP_USER_AGENT = 'SATLAUN/1.0.0 (SAT LAUNCHER)';
const TEXTURE_CACHE_SCHEMA = 8;
const textureDataUrlCache = new Map();
let assetLoadPromise = null;
let assetLoadResult = null;
const loaderVersionsCache = new Map();
const modrinthTranslationCache = new Map();
const modrinthProjectDetailsCache = new Map();
const labyClothingTextureCache = new Map();
const labySkinTextureCache = new Map();
const labySkinCatalogCache = new Map();
const offlineSkinLookupCache = new Map();
const mapSearchCache = new Map();
const mapSearchPending = new Map();
let labyTrendingClothingCache = { expiresAt: 0, items: [] };
let yandexMusicAuthWindow = null;
let craftyTrendingSkinCache = { expiresAt: 0, items: [] };
let discordRpcClient = null;
let discordRpcAppId = null;
let discordPresenceKey = '';
let discordPresenceStartedAt = 0;
let discordLastFailureMessage = '';
let discordLastFailureLoggedAt = 0;
let discordReconnectTimer = null;

const MINECRAFT_UI_TEXTURES = [
  'textures/block/grass_block_top.png', 'textures/block/grass_block_side.png',
  'textures/block/stone.png', 'textures/block/gold_block.png',
  'textures/block/diamond_block.png', 'textures/block/emerald_block.png',
  'textures/block/crafting_table_front.png', 'textures/block/crafting_table_side.png',
  'textures/block/crafting_table_top.png', 'textures/item/diamond.png',
  'textures/item/diamond_sword.png', 'textures/item/iron_pickaxe.png',
  'textures/item/book.png', 'textures/item/ender_pearl.png',
  'textures/item/compass_16.png', 'textures/item/map.png', 'textures/item/writable_book.png',
  'textures/item/totem_of_undying.png', 'textures/item/armor_stand.png',
  'textures/item/blaze_powder.png', 'textures/item/music_disc_cat.png',
  'textures/item/shears.png', 'textures/item/water_bucket.png', 'textures/item/emerald.png',
  'textures/item/iron_axe.png', 'textures/item/paper.png', 'textures/block/redstone_torch.png',
  'textures/item/enchanted_book.png', 'textures/item/nether_star.png',
  'textures/item/coal.png', 'textures/item/iron_ingot.png',
  'textures/item/amethyst_shard.png', 'textures/item/clock_00.png',
  'textures/entity/player/wide/steve.png', 'textures/entity/player/slim/alex.png'
];

let mainWindow = null;
let logs = [];
const LAUNCHER_SESSION_STARTED_AT = Date.now();
let activeMinecraftAuthorization = null;
let activeMsmc = null;
// Guard launch requests while auth/download/loader setup is awaiting.
let runningGames = new Map();
let launchingGames = new Set();
let operationLocks = new Set();

const DEFAULT_SETTINGS = {
  memoryMin: '2G',
  memoryMax: '6G',
  autoJava: true,
  javaPath: '',
  customGameDirectory: '',
  // Built-in Discord app ID: Rich Presence starts automatically on launch.
  discordApplicationId: '1562927125600931941',
  discordImageKey: 'sat_launcher',
  discordPresenceEnabled: true,
  closeAfterLaunch: false,
  selectedInstanceId: null,
  theme: 'sunset',
  language: 'ru',
  uiScale: 1.1,
  rightRailCollapsed: false,
};

function ensureDirectories() {
  for (const dir of [APP_DIR, INSTANCES_DIR, RUNTIMES_DIR, CACHE_DIR, MINECRAFT_ASSETS_DIR, SKINS_DIR]) fs.mkdirSync(dir, { recursive: true });
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}
function getSettings() {
  const saved = readJson(SETTINGS_FILE, {});
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  // Upgrade existing installations whose old settings stored an empty Application ID.
  // Only an explicit user action (discordPresenceEnabled=false) disables auto-presence.
  settings.discordPresenceEnabled = saved.discordPresenceEnabled !== false;
  if (!settings.discordPresenceEnabled) {
    settings.discordApplicationId = '';
  } else if (!String(saved.discordApplicationId || '').trim()) {
    settings.discordApplicationId = DEFAULT_SETTINGS.discordApplicationId;
  }
  if (!String(settings.discordImageKey || '').trim()) settings.discordImageKey = DEFAULT_SETTINGS.discordImageKey;
  return settings;
}
function getInstances() {
  const rows = readJson(INSTANCES_FILE, []);
  if (!Array.isArray(rows)) return [];
  return rows.map(instance => {
    if (!Array.isArray(instance.installedContent)) return instance;
    const installedContent = instance.installedContent.filter(entry => entry?.path && fs.existsSync(entry.path));
    return installedContent.length === instance.installedContent.length ? instance : { ...instance, installedContent };
  });
}
function getInstancesForRenderer() {
  return getInstances().map(instance => ({ ...instance, contentCounts: listInstanceContent(instance.root).counts }));
}
function saveInstances(instances) { writeJson(INSTANCES_FILE, instances); }
function getProfile() { return readJson(PROFILE_FILE, { username: '', type: 'guest' }); }
function profileStorageKey(profile) {
  const type = profile?.type === 'microsoft' ? 'microsoft' : profile?.type === 'offline' ? 'offline' : 'guest';
  const identity = type === 'microsoft' ? String(profile?.uuid || profile?.username || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase() : String(profile?.username || '').trim().toLowerCase();
  return `${type}:${identity}`;
}
function profileAuthFile(profile) {
  const identity = String(profile?.uuid || profile?.username || '').replace(/[^a-zA-Z0-9_-]/g, '').toLowerCase();
  if (!identity) throw new Error('У официального профиля отсутствует идентификатор.');
  return path.join(APP_DIR, `auth-${identity}.bin`);
}
function getSavedProfiles() {
  const stored = readJson(PROFILES_FILE, []);
  const profiles = Array.isArray(stored) ? stored.filter(profile => ['microsoft', 'offline'].includes(profile?.type) && profile?.username) : [];
  const active = getProfile();
  if (['microsoft', 'offline'].includes(active?.type) && active.username) {
    const key = profileStorageKey(active);
    if (!profiles.some(profile => profileStorageKey(profile) === key)) profiles.unshift(active);
  }
  const latestByKey = new Map();
  for (const profile of profiles) latestByKey.set(profileStorageKey(profile), { ...profile, key: profileStorageKey(profile) });
  return [...latestByKey.values()].sort((a, b) => String(b.lastUsedAt || b.loggedInAt || '').localeCompare(String(a.lastUsedAt || a.loggedInAt || '')));
}
function saveProfile(profile) {
  const savedProfile = { ...profile };
  writeJson(PROFILE_FILE, savedProfile);
  if (!['microsoft', 'offline'].includes(savedProfile.type) || !savedProfile.username) return;
  const profiles = getSavedProfiles().map(({ key, ...entry }) => entry);
  const key = profileStorageKey(savedProfile);
  const entry = { ...savedProfile, lastUsedAt: new Date().toISOString() };
  const index = profiles.findIndex(item => profileStorageKey(item) === key);
  if (index >= 0) profiles[index] = { ...profiles[index], ...entry };
  else profiles.unshift(entry);
  writeJson(PROFILES_FILE, profiles.slice(0, 32));
}
function currentInstance() {
  const settings = getSettings();
  const items = getInstances();
  return items.find(i => i.id === settings.selectedInstanceId) || items[0] || null;
}
function ensureSharedSavesDirectory(instance) {
  if (!instance?.root) throw new Error('Не удалось определить папку выбранной сборки.');
  ensureDirectories();
  const result = ensureSharedSaves(instance.root, SHARED_SAVES_DIR);
  if (result.migratedWorlds > 0) {
    log(`В общую библиотеку миров перенесено сохранений: ${result.migratedWorlds} (${instance.name || instance.id}).`);
  }
  return result.savesPath;
}

function standardMinecraftRoots(instance) {
  const roots = [];
  const add = value => { if (value && !roots.includes(path.resolve(value))) roots.push(path.resolve(value)); };
  if (process.platform === 'win32') add(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft'));
  else if (process.platform === 'darwin') add(path.join(os.homedir(), 'Library', 'Application Support', 'minecraft'));
  else add(path.join(os.homedir(), '.minecraft'));
  // Older SAT releases and user-defined directories may already contain the base version.
  const customRoot = getSettings().customGameDirectory;
  const inspectContainer = container => {
    if (!container) return;
    add(container);
    try { for (const name of fs.readdirSync(container)) { const candidate = path.join(container, name); if (fs.existsSync(path.join(candidate, 'versions'))) add(candidate); } } catch {}
  };
  inspectContainer(customRoot);
  // SAT stores instances in sibling folders. Reuse a base version already downloaded by another instance.
  inspectContainer(INSTANCES_DIR);
  if (instance?.root) add(instance.root);
  return roots;
}
function prepareInstanceVersion(instance) {
  if (!instance) return false;
  const candidates = standardMinecraftRoots(instance);
  const result = seedInstalledMinecraftVersion(instance, candidates);
  if (result.ready && result.copiedFrom) log(`Базовая версия Minecraft ${instance.minecraftVersion} скопирована из существующей установки (${result.copiedFrom}) в профиль ${instance.name}.`);
  return result.ready;
}
function assertInstanceVersionReady(instance) {
  if (prepareInstanceVersion(instance)) return true;
  return assertMinecraftVersionInstalled(instance);
}
function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
function rotateLauncherLogIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE) || fs.statSync(LOG_FILE).size < MAX_LOG_FILE_BYTES) return;
    try { fs.rmSync(`${LOG_FILE}.3`, { force: true }); } catch {}
    for (let index = 2; index >= 1; index--) {
      const oldPath = `${LOG_FILE}.${index}`;
      if (fs.existsSync(oldPath)) fs.renameSync(oldPath, `${LOG_FILE}.${index + 1}`);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {}
}
function log(message, type = 'info') {
  rotateLauncherLogIfNeeded();
  const entry = { time: new Date().toISOString(), type, message: String(message).slice(0, 2500) };
  logs.push(entry);
  if (logs.length > 1200) logs = logs.slice(-1000);
  try { fs.appendFileSync(LOG_FILE, `[${entry.time}] [${type.toUpperCase()}] ${entry.message}\n`, 'utf8'); } catch {}
  emit('launcher:log', entry);
}
function progress(stage, percent, detail = '') {
  emit('launcher:progress', { stage, percent: Math.max(0, Math.min(100, Number(percent) || 0)), detail });
}
function makeId(value = 'instance') {
  const slug = String(value).toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'instance';
  return `${slug}-${Date.now().toString(36)}`;
}
function safeFileName(value) {
  return String(value || 'download').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 120) || 'download';
}
function toAbsoluteInside(root, relative) {
  const resolved = path.resolve(root, relative);
  const rootResolved = path.resolve(root) + path.sep;
  if (resolved !== path.resolve(root) && !resolved.startsWith(rootResolved)) throw new Error('Архив содержит небезопасный путь. Распаковка отменена.');
  return resolved;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': APP_USER_AGENT, ...(options.headers || {}) }
  });
}
async function fetchJson(url, options = {}, timeoutMs = 40000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) throw new Error(`Сервер ответил ${response.status}: ${new URL(url).hostname}`);
  return response.json();
}
async function downloadToFile(url, destination, expectedSha1 = null, onProgress = null, timeoutMs = 600000, allowHtmlIntermediate = false, requestHeaders = {}) {
  const controller = new AbortController();
  let headerTimeout = false, totalTimeout = false, idleTimeout = false;
  const headerTimer = setTimeout(() => { headerTimeout = true; controller.abort(); }, Math.min(45000, timeoutMs));
  const totalTimer = setTimeout(() => { totalTimeout = true; controller.abort(); }, timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': APP_USER_AGENT, ...requestHeaders }
    });
    clearTimeout(headerTimer);
  } catch (error) {
    clearTimeout(headerTimer); clearTimeout(totalTimer);
    if (headerTimeout) throw new Error('Сервер не ответил на запрос загрузки за 45 секунд. Проверь ссылку или повтори попытку позже.');
    if (controller.signal.aborted) throw new Error('Загрузка прервана по тайм-ауту.');
    throw error;
  }
  if (!response.ok) { clearTimeout(totalTimer); throw new Error(`Не удалось скачать файл (HTTP ${response.status})`); }
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (!allowHtmlIntermediate && contentType.includes('text/html') && !/\.(html?|php)(\?|$)/i.test(new URL(response.url).pathname)) {
    clearTimeout(totalTimer);
    throw new Error('Источник вернул HTML-страницу вместо файла. Возможно, требуется подтверждение на сайте.');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const tempPath = `${destination}.part-${process.pid}-${Date.now()}`;
  const hash = expectedSha1 ? crypto.createHash(String(expectedSha1).length === 128 ? 'sha512' : 'sha1') : null;
  let received = 0, lastChunkAt = Date.now();
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length; lastChunkAt = Date.now();
      if (hash) hash.update(chunk);
      if (onProgress) onProgress(contentLength ? Math.round(received / contentLength * 100) : 0, received, contentLength);
      callback(null, chunk);
    }
  });
  const idleTimer = setInterval(() => {
    if (Date.now() - lastChunkAt > 90000) { idleTimeout = true; controller.abort(); }
  }, 5000);
  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(tempPath));
    if (hash) {
      const actual = hash.digest('hex');
      if (actual.toLowerCase() !== expectedSha1.toLowerCase()) throw new Error(`Проверка контрольной суммы не пройдена: ${path.basename(destination)}`);
    }
    fs.rmSync(destination, { force: true });
    fs.renameSync(tempPath, destination);
    return { path: destination, size: received, url: response.url, contentType };
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (idleTimeout) throw new Error('Источник перестал передавать данные на 90 секунд. Загрузка остановлена, чтобы лаунчер не зависал бесконечно. Попробуй ещё раз или используй другую ссылку.');
    if (totalTimeout) throw new Error('Загрузка превысила допустимое время. Проверь соединение и повтори попытку.');
    throw error;
  } finally {
    clearTimeout(totalTimer); clearInterval(idleTimer);
  }
}

async function downloadBuffer(url, timeoutMs = 60000) {
  const response = await fetchWithTimeout(url, { redirect: 'follow' }, timeoutMs);
  if (!response.ok) throw new Error(`Скачивание завершилось с HTTP ${response.status}`);
  const buf = Buffer.from(await response.arrayBuffer());
  return { buffer: buf, url: response.url, contentType: response.headers.get('content-type') || '' };
}

function applyMinecraftWindowIcon(pid) {
  if (process.platform !== 'win32' || !Number.isInteger(Number(pid)) || !fs.existsSync(path.join(__dirname, 'src', 'assets', 'icons', 'sat-app.ico'))) return;
  const scriptPath = path.join(os.tmpdir(), `sat-window-icon-${Number(pid)}.ps1`);
  const iconPath = path.join(__dirname, 'src', 'assets', 'icons', 'sat-app.ico');
  const ps = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$targetPid = ${Number(pid)}
$iconFile = '${iconPath.replace(/'/g, "''")}'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SatWindowIconNative {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extra);
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="LoadImageW")] public static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SetWindowTextW")] public static extern bool SetWindowText(IntPtr hwnd, string text);
  [DllImport("user32.dll", EntryPoint="SetClassLongPtrW", SetLastError=true)] public static extern IntPtr SetClassLongPtr(IntPtr hwnd, int index, IntPtr value);
  public static int ApplyIconForProcess(int target, IntPtr icon) {
    int changed = 0;
    EnumWindows((h, x) => { uint p; GetWindowThreadProcessId(h, out p); if ((int)p == target && IsWindowVisible(h)) {
      SendMessage(h, 0x80, IntPtr.Zero, icon);
      SendMessage(h, 0x80, new IntPtr(1), icon);
      SetClassLongPtr(h, -14, icon); SetClassLongPtr(h, -34, icon);
      SetWindowText(h, "SATLAUN"); changed++;
    } return true; }, IntPtr.Zero);
    return changed;
  }
}
'@
$icon = [SatWindowIconNative]::LoadImage([IntPtr]::Zero, $iconFile, 1, 0, 0, 0x10 -bor 0x40)
if ($icon -eq [IntPtr]::Zero) { exit }
$deadline = [DateTime]::UtcNow.AddMinutes(2)
try {
  while ([DateTime]::UtcNow -lt $deadline) {
    $proc = Get-Process -Id $targetPid
    if (-not $proc) { break }
    $changed = [SatWindowIconNative]::ApplyIconForProcess($targetPid, $icon)
    if ($changed -gt 0) { Start-Sleep -Milliseconds 100 }
    Start-Sleep -Milliseconds 800
  }
} finally {
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
`;
  try {
    fs.writeFileSync(scriptPath, ps, 'utf8');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
  } catch (e) { log(`Не удалось применить иконку SAT к окну Minecraft: ${e.message}`, 'debug'); }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.max(760, Math.min(1536, workArea.width - 24));
  const windowHeight = Math.max(600, Math.min(960, workArea.height - 24));
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.min(1024, windowWidth),
    minHeight: Math.min(650, windowHeight),
    backgroundColor: '#150e05',
    icon: path.join(__dirname, 'src', 'assets', 'icons', 'sat-app.ico'),
    title: 'SAT LAUNCHER',
    frame: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.on('did-finish-load', () => { try { mainWindow?.webContents.setZoomFactor(Math.max(0.85, Math.min(1.3, Number(getSettings().uiScale) || 1.1))); } catch {} });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function runtimePlatformKey() {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'windows-arm64' : process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}
function javaExecutableIn(dir) {
  const names = process.platform === 'win32' ? ['bin/javaw.exe', 'bin/java.exe', 'javaw.exe', 'java.exe'] : ['bin/java', 'java'];
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function runtimeComponentForMajor(major) {
  if (major <= 8) return 'jre-legacy';
  if (major <= 16) return 'java-runtime-alpha';
  if (major <= 17) return 'java-runtime-gamma';
  if (major <= 21) return 'java-runtime-delta';
  return 'java-runtime-epsilon';
}
function guessJavaMajor(versionId) {
  const m = String(versionId).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!m) return 21;
  const major = Number(m[1]), minor = Number(m[2]), patch = Number(m[3] || 0);
  if (major === 26 || major >= 26) return 25;
  if (major === 1) {
    if (minor <= 16) return 8;
    if (minor === 17) return 16;
    if (minor <= 20 && (minor < 20 || patch <= 4)) return 17;
    return 21;
  }
  return major >= 25 ? major : 21;
}
async function getRequiredJavaComponent(mcVersion) {
  try {
    const manifest = await fetchJson(MOJANG_MANIFEST);
    const versionInfo = manifest.versions.find(v => v.id === mcVersion);
    if (versionInfo && versionInfo.url) {
      const data = await fetchJson(versionInfo.url);
      if (data.javaVersion && data.javaVersion.component) return { component: data.javaVersion.component, major: data.javaVersion.majorVersion || guessJavaMajor(mcVersion) };
    }
  } catch (e) { log(`Не удалось получить javaVersion для ${mcVersion}: ${e.message}`, 'warn'); }
  const major = guessJavaMajor(mcVersion);
  return { component: runtimeComponentForMajor(major), major };
}
async function detectJavaMajorVersion(javaPath) {
  let executable = javaPath;
  // javaw.exe often suppresses console output on Windows. Probe the sibling java.exe when available.
  if (process.platform === 'win32' && /javaw\.exe$/i.test(executable)) {
    const consoleJava = path.join(path.dirname(executable), 'java.exe');
    if (fs.existsSync(consoleJava)) executable = consoleJava;
  }
  return await new Promise(resolve => {
    let child;
    let output = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let timer = setTimeout(() => {
      try { child?.kill(); } catch {}
      finish(null);
    }, 5000);
    timer.unref?.();
    try {
      child = spawn(executable, ['-version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.on('data', data => { output += String(data); });
      child.stderr?.on('data', data => { output += String(data); });
      child.once('error', () => finish(null));
      child.once('close', () => {
        const result = javaCompatibility(output, 1);
        finish(result.detectedMajor);
      });
    } catch {
      finish(null);
    }
  });
}
async function assertJavaRuntimeCompatible(javaPath, mcVersion, requiredMajor) {
  const actualMajor = await detectJavaMajorVersion(javaPath);
  if (actualMajor === null) {
    log(`Не удалось определить версию Java по ${javaPath}; запуск будет продолжен, если JVM сама примет версию Minecraft.`, 'warn');
    return;
  }
  log(`Проверка Java: версия ${actualMajor}, для Minecraft ${mcVersion} требуется ${requiredMajor}+.`);
  const compatibility = javaCompatibility(`java version \"${actualMajor}\"`, requiredMajor);
  if (compatibility.compatible === false) {
    throw new Error(`Для Minecraft ${mcVersion} требуется Java ${requiredMajor} или новее, но выбранная Java имеет версию ${actualMajor}. Включи «Автоматически подбирать Java» в настройках или укажи совместимый java.exe. Для Minecraft 26.1–26.3 нужна Java 25; Java 21 не подходит.`);
  }
}
async function getJavaPath(mcVersion) {
  const settings = getSettings();
  const required = await getRequiredJavaComponent(mcVersion);
  if (settings.autoJava === false && settings.javaPath && fs.existsSync(settings.javaPath)) {
    await assertJavaRuntimeCompatible(settings.javaPath, mcVersion, required.major);
    return settings.javaPath;
  }
  const { component } = required;
  const root = path.join(RUNTIMES_DIR, component, runtimePlatformKey());
  const exe = javaExecutableIn(root);
  if (exe) {
    await assertJavaRuntimeCompatible(exe, mcVersion, required.major);
    return exe;
  }
  log(`Подготавливается Java (${component}) для Minecraft ${mcVersion}…`);
  progress('java', 0, `Подготовка Java: ${component}`);
  const index = await fetchJson(RUNTIME_INDEX);
  const key = runtimePlatformKey();
  const targets = index[key] && index[key][component];
  if (!Array.isArray(targets) || !targets.length) throw new Error(`На официальном сервере Mojang не найден Java runtime ${component} для ${key}. Укажи путь к java.exe в настройках.`);
  const target = targets[0];
  const manifest = await fetchJson(target.manifest.url);
  const entries = Object.entries(manifest.files || {});
  let completed = 0;
  const files = entries.filter(([, f]) => f.type === 'file');
  const dirs = entries.filter(([, f]) => f.type === 'directory');
  for (const [relative] of dirs) fs.mkdirSync(toAbsoluteInside(root, relative), { recursive: true });
  const queue = [...files];
  const worker = async () => {
    while (queue.length) {
      const [relative, info] = queue.shift();
      const destination = toAbsoluteInside(root, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const raw = info.downloads && info.downloads.raw;
      if (raw && (!fs.existsSync(destination) || (fs.statSync(destination).size !== raw.size))) {
        await downloadToFile(raw.url, destination, raw.sha1, (p, received, total) => {
          const withinFile = Number.isFinite(p) ? p / 100 : 0;
          const current = completed + withinFile;
          const percent = Math.min(96, Math.round(current / Math.max(files.length, 1) * 96));
          progress('java', percent, `Загрузка Java: ${completed}/${files.length} файлов · ${formatBytes(received)}${total ? ` из ${formatBytes(total)}` : ' получено'}`);
        }, 15 * 60 * 1000);
        if (info.executable && process.platform !== 'win32') fs.chmodSync(destination, 0o755);
      }
      completed++;
      if (completed % 4 === 0 || completed === files.length) progress('java', Math.round(completed / Math.max(files.length, 1) * 100), `${completed} / ${files.length} файлов Java`);
    }
  };
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  const java = javaExecutableIn(root);
  if (!java) throw new Error('Java была загружена, но исполняемый файл не найден. Проверь журнал.');
  writeJson(path.join(root, 'runtime-version.json'), { component, version: target.version, installedAt: new Date().toISOString() });
  await assertJavaRuntimeCompatible(java, mcVersion, required.major);
  log(`Java готова: ${java}`);
  progress('java', 100, 'Java готова');
  return java;
}

async function listMinecraftVersions() {
  ensureDirectories();
  const cacheFile = path.join(CACHE_DIR, 'metadata', 'minecraft-versions.json');
  const cached = readJson(cacheFile, null);
  const ttlMs = 6 * 60 * 60 * 1000;
  if (cached?.at && Array.isArray(cached.versions) && Date.now() - cached.at < ttlMs) {
    return cached.versions.map(v => ({ ...v }));
  }
  try {
    const manifest = await fetchJson(MOJANG_MANIFEST, {}, 25000);
    const versions = (manifest.versions || []).map(v => ({ id: v.id, type: v.type, releaseTime: v.releaseTime, url: v.url, complianceLevel: v.complianceLevel || 0 }));
    if (!versions.length) throw new Error('Официальный манифест Mojang не содержит версий Minecraft.');
    writeJson(cacheFile, { at: Date.now(), latest: manifest.latest || {}, versions });
    return versions;
  } catch (error) {
    // A stale official manifest is safer and more useful than an empty selector when the network is temporarily down.
    if (cached?.versions?.length) {
      log(`Не удалось обновить манифест версий Mojang; используется кэш от ${new Date(cached.at || 0).toLocaleString()}: ${error.message}`, 'warn');
      return cached.versions.map(v => ({ ...v }));
    }
    throw error;
  }
}

function validateOfflineName(username) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник должен содержать 3–16 символов: латинские буквы, цифры или подчёркивание.');
  return name;
}

async function loginMicrosoft() {
  log('Открывается окно безопасного входа Microsoft…');
  const { Auth } = require('msmc');
  const auth = new Auth('select_account');
  activeMsmc = auth;
  const xbox = await auth.launch('electron', { width: 520, height: 720, resizable: true, icon: path.join(__dirname, 'src', 'assets', 'icons', 'sat-app.ico') });
  const minecraft = await xbox.getMinecraft();
  const authorization = minecraft.mclc(true);
  activeMinecraftAuthorization = authorization;
  const username = minecraft.profile.name;
  const profile = { username, uuid: minecraft.profile.id, type: 'microsoft', loggedInAt: new Date().toISOString() };
  saveProfile(profile);
  try { await getProfileSkin(); } catch (e) { log(`Скин профиля будет загружен позже: ${e.message}`, 'warn'); }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      const protectedToken = safeStorage.encryptString(JSON.stringify(authorization)).toString('base64');
      fs.writeFileSync(profileAuthFile(profile), protectedToken, { encoding: 'utf8', mode: 0o600 });
    } catch (e) { log(`Не удалось безопасно сохранить токен. Потребуется повторный вход: ${e.message}`, 'warn'); }
  } else {
    log('Системное защищённое хранилище недоступно — токен не сохранён на диск.', 'warn');
  }
  log(`Вход выполнен: ${username}`);
  return profile;
}
async function probeMinecraftAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string') throw new Error('Microsoft не выдал Minecraft access token. Войди в аккаунт заново.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch('https://api.minecraftservices.com/player/attributes', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': APP_USER_AGENT },
      signal: controller.signal
    });
    if (response.status === 401) {
      const error = new Error('Minecraft Services отклонил токен (HTTP 401). Сессия Microsoft обновлена, но сервер её не принял. Войди в Microsoft заново и проверь, что на этом аккаунте есть Minecraft Java Edition.');
      error.code = 'MINECRAFT_TOKEN_401';
      throw error;
    }
    if (response.status === 403) {
      const error = new Error('Minecraft Services вернул HTTP 403. Проверь, что этот Microsoft-аккаунт имеет доступ к Minecraft Java Edition и завершил настройку профиля Xbox.');
      error.code = 'MINECRAFT_TOKEN_403';
      throw error;
    }
    if (!response.ok && response.status < 500) {
      const error = new Error(`Не удалось проверить Minecraft-сессию (HTTP ${response.status}). Войди через Microsoft заново.`);
      error.code = 'MINECRAFT_TOKEN_CHECK_FAILED';
      throw error;
    }
    if (!response.ok) log(`Проверка Minecraft Services временно вернула HTTP ${response.status}; токен уже обновлён через Microsoft.`, 'warn');
    return { ok: response.ok, status: response.status };
  } catch (error) {
    if (error?.code) throw error;
    // A transient network failure after a successful forced refresh should be logged, not misreported as bad credentials.
    log(`Не удалось выполнить предварительный запрос к Minecraft Services: ${error?.message || error}`, 'warn');
    return { ok: false, networkUnavailable: true };
  } finally {
    clearTimeout(timeout);
  }
}

async function createOfflineAuthorization(username) {
  const { Authenticator } = require('minecraft-launcher-core');
  const name = validateOfflineName(username || 'Player');
  const generated = await Authenticator.getAuth(name) || {};
  // Modern Minecraft Authlib attempts to parse the offline access token as a JWT for Realms.
  // MCLC versions that put the offline UUID into access_token trigger a noisy SignedJWT parse
  // error. Offline accounts have no bearer token, so keep the offline UUID/name but use the
  // conventional zero token. This does not grant online/Realms access.
  return { ...generated, access_token: '0', name, uuid: String(generated.uuid || ''), user_properties: generated.user_properties || '{}', meta: { ...(generated.meta || {}), type: 'mojang' } };
}

async function resolveAuthorization() {
  const profile = getProfile();
  if (profile.type !== 'microsoft') {
    return createOfflineAuthorization(profile.username || 'Player');
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище недоступно. Войди через Microsoft ещё раз.');

  // Do not return the in-memory MCLC object without refreshing it. It can outlive the
  // 24-hour Minecraft access token and causes authlib to receive HTTP 401 at /player/attributes.
  let saved = activeMinecraftAuthorization;
  if (!saved) {
    let tokenPath = profileAuthFile(profile);
    if (!fs.existsSync(tokenPath) && fs.existsSync(AUTH_FILE)) tokenPath = AUTH_FILE; // migration from older launcher releases
    if (!fs.existsSync(tokenPath)) throw new Error('Для этого официального профиля нужно повторно войти через Microsoft.');
    try {
      const encrypted = fs.readFileSync(tokenPath, 'utf8');
      saved = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    } catch (error) {
      activeMinecraftAuthorization = null;
      throw new Error(`Не удалось прочитать защищённую сессию Microsoft. Выйди из аккаунта и войди снова. ${error.message || ''}`.trim());
    }
  }

  const { Auth, tokenUtils } = require('msmc');
  const auth = new Auth('select_account');
  let refreshed;
  try {
    const minecraft = tokenUtils.fromMclcToken(auth, saved);
    refreshed = await minecraft.refresh(true);
  } catch (error) {
    activeMinecraftAuthorization = null;
    const message = String(error?.message || error || 'ошибка обновления токена');
    log(`Не удалось обновить Microsoft/Minecraft-сессию: ${message}`, 'error');
    throw new Error('Сессия Microsoft истекла или была отозвана. Minecraft не запущен со старым токеном. Открой профиль SAT LAUNCHER, выйди из Microsoft и войди заново.');
  }

  if (!refreshed || !refreshed.mcToken || !refreshed.profile?.id || !refreshed.profile?.name) {
    activeMinecraftAuthorization = null;
    throw new Error('Microsoft не вернул действительный профиль Minecraft. Войди в аккаунт заново.');
  }
  const refreshedUuid = String(refreshed.profile.id).replace(/-/g, '').toLowerCase();
  const savedUuid = String(profile.uuid || '').replace(/-/g, '').toLowerCase();
  if (savedUuid && refreshedUuid && savedUuid !== refreshedUuid) {
    activeMinecraftAuthorization = null;
    throw new Error('Microsoft вернул другой профиль Minecraft, чем выбран в SAT LAUNCHER. Переключи профиль и войди заново.');
  }
  if (typeof refreshed.validate === 'function' && !refreshed.validate()) {
    activeMinecraftAuthorization = null;
    throw new Error('Minecraft access token не прошёл проверку после обновления. Войди через Microsoft заново.');
  }

  const authorization = refreshed.mclc(true);
  // Verify the exact endpoint that appeared in the user's 401 log before spawning Java.
  try { await probeMinecraftAccessToken(refreshed.mcToken); }
  catch (error) { activeMinecraftAuthorization = null; throw error; }
  activeMinecraftAuthorization = authorization;
  try {
    fs.writeFileSync(profileAuthFile(profile), safeStorage.encryptString(JSON.stringify(authorization)).toString('base64'), { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    log(`Не удалось сохранить обновлённую Microsoft-сессию: ${error.message}`, 'warn');
  }
  return authorization;
}

function getInstance(instanceId) {
  return getInstances().find(i => i.id === instanceId) || null;
}
function saveInstance(instance) {
  const all = getInstances();
  const idx = all.findIndex(i => i.id === instance.id);
  if (idx >= 0) all[idx] = instance; else all.unshift(instance);
  saveInstances(all);
  return instance;
}
function normalizeMapSourceUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    // Source tracking parameters differ between catalog cards and download pages.
    for (const key of [...url.searchParams.keys()]) if (/^(utm_.+|ref|source|campaign)$/i.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    return url.toString().replace(/\/$/, '');
  } catch { return ''; }
}
function recordInstalledMap(instance, sourceUrl, installed) {
  if (!instance || !installed?.path) return;
  const source = normalizeMapSourceUrl(sourceUrl);
  const record = { url: source || String(sourceUrl || ''), name: installed.mapName, path: installed.path, installedAt: new Date().toISOString() };
  const rows = getInstances();
  let changed = false;
  for (const row of rows) {
    if (!Array.isArray(row.installedMaps)) row.installedMaps = [];
    const existing = row.installedMaps.findIndex(item => (source && normalizeMapSourceUrl(item.url) === source) || (item.path && path.resolve(item.path) === path.resolve(installed.path)));
    if (existing >= 0) row.installedMaps[existing] = { ...row.installedMaps[existing], ...record };
    else row.installedMaps.push({ ...record });
    changed = true;
  }
  if (!rows.some(row => row.id === instance.id)) {
    if (!Array.isArray(instance.installedMaps)) instance.installedMaps = [];
    instance.installedMaps.push(record);
    rows.unshift(instance);
    changed = true;
  }
  if (changed) saveInstances(rows);
}
function ensureLauncherProfileFile(gameRoot, minecraftVersion) {
  fs.mkdirSync(gameRoot, { recursive: true });
  const file = path.join(gameRoot, 'launcher_profiles.json');
  let data = readJson(file, {});
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (!data.profiles || typeof data.profiles !== 'object' || Array.isArray(data.profiles)) data.profiles = {};
  if (!data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) data.settings = {};
  const profileName = `SAT LAUNCHER ${minecraftVersion}`;
  data.profiles[profileName] = {
    ...(data.profiles[profileName] || {}),
    name: profileName,
    type: 'custom',
    lastVersionId: String(minecraftVersion),
    gameDir: gameRoot
  };
  data.selectedProfile = profileName;
  data.version = Number.isInteger(data.version) ? Math.max(data.version, 3) : 3;
  writeJson(file, data);
  return file;
}

function writeLoaderProfile(instance, loader, loaderVersion, profile) {
  profile = normalizeLoaderProfile(profile, {
    minecraftVersion: instance.minecraftVersion,
    loader: loaderNameForLog(loader),
    loaderVersion
  });
  const profileId = profile.id;
  const versionDir = path.join(instance.root, 'versions', profileId);
  fs.mkdirSync(versionDir, { recursive: true });
  const destination = path.join(versionDir, `${profileId}.json`);
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(profile, null, 2), 'utf8');
  fs.renameSync(temporary, destination);
  instance.loader = loader;
  instance.loaderVersion = loaderVersion;
  instance.versionId = profileId;
  instance.installed = true;
  instance.installedAt = new Date().toISOString();
  saveInstance(instance);
  log(`${loaderNameForLog(loader)} профиль получен из официального Meta API: ${profileId}`);
  return instance;
}

function createInstance({ name, minecraftVersion, versionType = 'release', loader = 'vanilla', loaderVersion = '', source = 'manual', icon = '' }) {
  const id = makeId(name || `${loader}-${minecraftVersion}`);
  const configuredRoot = getSettings().customGameDirectory;
  const root = path.join(configuredRoot || INSTANCES_DIR, id);
  fs.mkdirSync(root, { recursive: true });
  const instance = {
    id, name: name || `${loader === 'vanilla' ? 'Vanilla' : loader} ${minecraftVersion}`,
    minecraftVersion, versionType, loader, loaderVersion, versionId: loader === 'vanilla' ? minecraftVersion : '',
    root, source, icon, installed: loader === 'vanilla' ? false : false,
    createdAt: new Date().toISOString(), lastPlayedAt: null, installedContent: []
  };
  saveInstance(instance);
  const settings = getSettings(); settings.selectedInstanceId = id; writeJson(SETTINGS_FILE, settings);
  log(`Добавлен профиль: ${instance.name}`);
  return instance;
}

function execJar(java, jar, args, cwd, onLine, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    log(`Запуск установщика: ${path.basename(jar)} ${args.join(' ')}`);
    const child = spawn(java, ['-jar', jar, ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '', settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000).unref?.();
      reject(new Error(`Установщик ${path.basename(jar)} не завершился за ${Math.round(timeoutMs / 60000)} минут. Процесс остановлен; открой журнал для последнего сообщения.`));
    }, timeoutMs);
    child.stdout.on('data', b => { const text = b.toString(); if (onLine) onLine(text); if (text.trim()) log(text.trim()); });
    child.stderr.on('data', b => { const text = b.toString(); stderr = (stderr + text).slice(-12000); if (onLine) onLine(text); if (text.trim()) log(text.trim(), 'warn'); });
    child.on('error', error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); });
    child.on('close', code => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Установщик завершился с кодом ${code}. ${stderr.slice(-800)}`));
    });
  });
}
async function discoverInstalledLoaderProfile(root, mcVersion, loader) {
  const versionsDir = path.join(root, 'versions');
  if (!fs.existsSync(versionsDir)) return null;
  const candidates = [];
  for (const dirName of fs.readdirSync(versionsDir)) {
    const file = path.join(versionsDir, dirName, `${dirName}.json`);
    if (!fs.existsSync(file)) continue;
    try {
      const json = readJson(file, {});
      const text = `${dirName} ${json.id || ''} ${JSON.stringify(json.libraries || [])}`.toLowerCase();
      const inheritMatches = json.inheritsFrom === mcVersion || dirName.includes(mcVersion);
      const loaderMatches = loader === 'fabric' ? /fabric-loader|net\.fabricmc/.test(text)
        : loader === 'quilt' ? /quilt-loader|org\.quiltmc/.test(text)
        : loader === 'forge' ? (!text.includes('neoforge') && /forge|net\.minecraftforge/.test(text))
        : loader === 'neoforge' ? /neoforge|net\.neoforged/.test(text) : false;
      if (inheritMatches && loaderMatches) candidates.push({ id: dirName, mtime: fs.statSync(file).mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.id || null;
}
async function fetchLoaderVersions(loader, mcVersion) {
  if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(loader)) return [];
  if (loader === 'fabric') {
    const rows = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}`);
    return rows.map(row => ({ version: row.loader.version, stable: Boolean(row.loader.stable), label: row.loader.version }));
  }
  if (loader === 'quilt') {
    const rows = await fetchJson(`https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}`);
    return rows.map(row => ({ version: row.loader.version, stable: Boolean(row.loader.stable), label: row.loader.version }));
  }
  if (loader === 'forge') {
    const [metadata, promotions] = await Promise.all([
      fetchWithTimeout('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml', {}, 40000).then(async r => { if (!r.ok) throw new Error(`Forge Maven ответил HTTP ${r.status}`); return r.text(); }),
      fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json').catch(() => ({ promos: {} }))
    ]);
    const prefix = `${mcVersion}-`;
    const all = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]).filter(v => v.startsWith(prefix)).map(v => v.slice(prefix.length));
    const unique = [...new Set(all)].sort((a,b) => compareVersion(b,a));
    const recommended = promotions.promos?.[`${mcVersion}-recommended`];
    const latest = promotions.promos?.[`${mcVersion}-latest`];
    if (recommended && !unique.includes(recommended)) unique.unshift(recommended);
    if (latest && !unique.includes(latest)) unique.unshift(latest);
    return unique.map(version => ({ version, stable: version === recommended, label: `${version}${version === recommended ? ' · рекомендуемая' : version === latest ? ' · последняя' : ''}` }));
  }
  if (loader === 'neoforge') {
    const res = await fetchWithTimeout('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml', {}, 40000);
    if (!res.ok) throw new Error(`NeoForge Maven ответил HTTP ${res.status}`);
    const xml = await res.text();
    const all = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
    const pieces = String(mcVersion).split('.');
    const prefixes = [];
    if (pieces[0] === '1' && pieces.length >= 3) {
      const modern = `${pieces[1]}.${pieces[2]}.`;
      prefixes.push(modern);
      // NeoForge 1.20.1 shares the historical Forge-style coordinate scheme.
      if (mcVersion === '1.20.1') prefixes.push('1.20.1-');
      if (pieces[1] === '20' && Number(pieces[2]) <= 1) prefixes.push(`1.${pieces[1]}.${pieces[2]}-`);
    } else {
      prefixes.push(`${mcVersion}-`, `${mcVersion}.`);
      if (pieces.length >= 2) prefixes.push(`${pieces[0]}.${pieces[1]}.`);
    }
    const versions = all.filter(v => prefixes.some(prefix => v.startsWith(prefix)));
    const unique = [...new Set(versions)].sort((a,b) => compareVersion(b,a));
    return unique.map(version => ({ version, stable: true, label: version }));
  }
  return [];
}


async function getLoaderVersions(loader, mcVersion) {
  const key = `${loader}:${mcVersion}`;
  const inMemory = loaderVersionsCache.get(key);
  if (inMemory && Date.now() - inMemory.at < 6 * 60 * 60 * 1000) return inMemory.versions.map(v => ({ ...v }));
  const file = path.join(CACHE_DIR, 'metadata', 'loader-versions.json');
  const stored = readJson(file, {});
  if (stored[key]?.at && Date.now() - stored[key].at < 6 * 60 * 60 * 1000 && Array.isArray(stored[key].versions)) {
    loaderVersionsCache.set(key, stored[key]);
    return stored[key].versions.map(v => ({ ...v }));
  }
  try {
    const versions = await fetchLoaderVersions(loader, mcVersion);
    loaderVersionsCache.set(key, { at: Date.now(), versions });
    stored[key] = { at: Date.now(), versions };
    writeJson(file, stored);
    return versions.map(v => ({ ...v }));
  } catch (error) {
    if (Array.isArray(stored[key]?.versions) && stored[key].versions.length) {
      log(`Каталог ${loaderNameForLog(loader)} временно недоступен; показан сохранённый список версий Minecraft ${mcVersion}. ${error.message}`, 'warn');
      return stored[key].versions.map(v => ({ ...v }));
    }
    throw error;
  }
}

async function getSupportedLoaderGames(loader) {
  if (!['fabric','quilt','forge','neoforge'].includes(loader)) return [];
  const key = `supported:${loader}`;
  const memory = loaderVersionsCache.get(key);
  const ttlMs = 6 * 60 * 60 * 1000;
  if (memory && Date.now() - memory.at < ttlMs) return [...memory.versions];
  const file = path.join(CACHE_DIR, 'metadata', 'loader-games.json');
  const stored = readJson(file, {});
  const staleVersions = Array.isArray(stored[loader]?.versions) ? stored[loader].versions : [];
  if (stored[loader]?.at && Date.now() - stored[loader].at < ttlMs && staleVersions.length) {
    loaderVersionsCache.set(key, stored[loader]);
    return [...staleVersions];
  }
  try {
    let supported = [];
    if (loader === 'fabric' || loader === 'quilt') {
      const base = loader === 'fabric' ? 'https://meta.fabricmc.net/v2/versions/game' : 'https://meta.quiltmc.org/v3/versions/game';
      const rows = await fetchJson(base, {}, 25000);
      supported = rows.map(row => typeof row === 'string' ? row : row.version).filter(Boolean);
    } else {
      const metaUrl = loader === 'forge'
        ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
        : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml';
      const response = await fetchWithTimeout(metaUrl, {}, 35000);
      if (!response.ok) throw new Error(`${loaderNameForLog(loader)} metadata HTTP ${response.status}`);
      const all = [...(await response.text()).matchAll(/<version>([^<]+)<\/version>/g)].map(m => m[1]);
      const versions = await listMinecraftVersions();
      supported = versions.filter(v => v.type === 'release').map(v => v.id).filter(mc => {
        if (loader === 'forge') return all.some(x => x.startsWith(`${mc}-`));
        const legacy = mc.match(/^1\.(\d+)\.(\d+)$/);
        let prefixes;
        if (legacy) {
          const minor = legacy[1], patch = legacy[2];
          prefixes = [`${minor}.${patch}.`, `${mc}-`, `${minor}.${patch}-`];
        } else if (/^\d+\.\d+(?:\.\d+)?$/.test(mc)) {
          prefixes = [`${mc}.`, `${mc}-`];
          if (mc.split('.').length === 2) prefixes.push(`${mc}.0.`);
        } else return false;
        return all.some(x => prefixes.some(prefix => x.startsWith(prefix)));
      });
    }
    const manifestVersions = await listMinecraftVersions();
    const official = new Set(manifestVersions.map(v => v.id));
    supported = [...new Set(supported)].filter(v => official.has(v));
    const versionRank = new Map(manifestVersions.map((v, i) => [v.id, i]));
    supported.sort((a,b) => (versionRank.get(a) ?? 1e9) - (versionRank.get(b) ?? 1e9));
    if (!supported.length) throw new Error(`Не найдено совместимых версий Minecraft для ${loaderNameForLog(loader)}.`);
    const record = { at: Date.now(), versions: supported };
    loaderVersionsCache.set(key, record);
    stored[loader] = record;
    writeJson(file, stored);
    return [...supported];
  } catch (error) {
    if (staleVersions.length) {
      log(`Каталог совместимых версий ${loaderNameForLog(loader)} временно недоступен; используется сохранённый список (${staleVersions.length}). ${error.message}`, 'warn');
      return [...staleVersions];
    }
    throw error;
  }
}

function mavenCoordinateToJarUrl(coordinate, repositoryBase) {
  const parts = String(coordinate || '').trim().split(':');
  if (parts.length < 3 || parts.some(part => !part)) return '';
  const [group, artifact, version, classifier] = parts;
  const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`;
  return `${repositoryBase.replace(/\/+$/, '')}/${group.replace(/\./g, '/')}/${artifact}/${version}/${fileName}`;
}

async function loaderInstallerInfo(loader, mcVersion, requestedVersion = '') {
  const versions = await getLoaderVersions(loader, mcVersion);
  if (!versions.length) throw new Error(`${loaderNameForLog(loader)} не опубликовал совместимую версию для Minecraft ${mcVersion}. Выбери другой загрузчик или версию игры.`);
  const loaderVersion = requestedVersion || versions[0].version;
  if (!versions.some(v => v.version === loaderVersion)) throw new Error(`Версия ${loaderVersion} загрузчика ${loader} несовместима или больше не доступна для Minecraft ${mcVersion}. Обнови список версий.`);
  if (loader === 'fabric') {
    return { loaderVersion, profileUrl: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`, profilePattern: `fabric-loader-${loaderVersion}-${mcVersion}` };
  }
  if (loader === 'quilt') {
    return { loaderVersion, profileUrl: `https://meta.quiltmc.org/v3/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`, profilePattern: `quilt-loader-${loaderVersion}-${mcVersion}` };
  }
  if (loader === 'forge') {
    const combined = `${mcVersion}-${loaderVersion}`;
    return { loaderVersion, installerUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${combined}/forge-${combined}-installer.jar`, args: ['--installClient', null], profilePattern: `${mcVersion}-forge-${loaderVersion}` };
  }
  if (loader === 'neoforge') {
    return { loaderVersion, installerUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`, args: ['--installClient', null], profilePattern: `${mcVersion}-neoforge-${loaderVersion}` };
  }
  throw new Error(`Неизвестный загрузчик: ${loader}`);
}
function loaderNameForLog(loader) {
  return ({ fabric:'Fabric', quilt:'Quilt', forge:'Forge', neoforge:'NeoForge' })[loader] || String(loader);
}
function compareVersion(a, b) {
  const aa = String(a).split(/[.+-]/).map(x => Number(x) || 0), bb = String(b).split(/[.+-]/).map(x => Number(x) || 0);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0);
  return 0;
}
async function installLoaderForInstance(instance, loader, requestedVersion = '') {
  if (operationLocks.has(instance.id)) throw new Error('Для этой сборки уже выполняется операция.');
  operationLocks.add(instance.id);
  try {
    progress('loader', 4, `Подготовка ${loader}…`);
    const info = await loaderInstallerInfo(loader, instance.minecraftVersion, requestedVersion);
    log(`${loader}: выбрана версия ${info.loaderVersion} для Minecraft ${instance.minecraftVersion}`);
    if (info.profileUrl && ['fabric', 'quilt'].includes(loader)) {
      progress('loader', 28, `Получаем официальный профиль ${loaderNameForLog(loader)}…`);
      const profile = await fetchJson(info.profileUrl, {}, 45000);
      progress('loader', 78, 'Проверка профиля загрузчика…');
      const installed = writeLoaderProfile(instance, loader, info.loaderVersion, profile);
      progress('loader', 100, `${loaderNameForLog(loader)} установлен`);
      return installed;
    }
    // Forge-family installers reject custom instance folders which have no launcher_profiles.json.
    // Keep each profile isolated, but create a valid minimal launcher profile before invoking the official installer.
    if (loader === 'forge' || loader === 'neoforge') ensureLauncherProfileFile(instance.root, instance.minecraftVersion);
    const jarPath = path.join(CACHE_DIR, 'installers', `${loader}-${safeFileName(instance.minecraftVersion)}-${safeFileName(info.loaderVersion)}.jar`);
    if (!isZipFile(jarPath)) fs.rmSync(jarPath, { force: true });
    if (!fs.existsSync(jarPath)) await downloadToFile(info.installerUrl, jarPath, null, (p) => progress('loader', Math.max(5, Math.round(p * 0.25)), `Загрузка установщика ${loader}`), 15 * 60 * 1000);
    if (!isZipFile(jarPath)) { fs.rmSync(jarPath, { force: true }); throw new Error(`Официальный каталог ${loaderNameForLog(loader)} вернул не JAR-установщик. Повреждённый файл удалён; повтори попытку или выбери другую совместимую версию.`); }
    const java = await getJavaPath(instance.minecraftVersion);
    let args = info.args.slice();
    if (loader === 'fabric') args = ['client', '-dir', instance.root, '-mcversion', instance.minecraftVersion, '-loader', info.loaderVersion];
    else if (loader === 'quilt') args = ['install', 'client', instance.minecraftVersion, info.loaderVersion, `--install-dir=${instance.root}`];
    else if (loader === 'forge' || loader === 'neoforge') args = ['--installClient', instance.root];
    await execJar(java, jarPath, args, instance.root, (line) => emit('launcher:installerLine', line));
    progress('loader', 82, 'Проверка установленного профиля…');
    let profileId = await discoverInstalledLoaderProfile(instance.root, instance.minecraftVersion, loader);
    if (!profileId) {
      const folder = path.join(instance.root, 'versions');
      if (fs.existsSync(folder)) {
        const possibles = fs.readdirSync(folder).filter(n => n.toLowerCase().includes(loader) && n.includes(instance.minecraftVersion) && !(loader === 'forge' && n.toLowerCase().includes('neoforge')));
        profileId = possibles[0] || '';
      }
    }
    if (!profileId) throw new Error(`Установщик ${loader} завершился, но профиль версии не найден. Открой журнал и проверь, создалась ли папка versions.`);
    instance.loader = loader;
    instance.loaderVersion = info.loaderVersion;
    instance.versionId = profileId;
    instance.installed = true;
    instance.installedAt = new Date().toISOString();
    saveInstance(instance);
    progress('loader', 100, `${loader} установлен`);
    log(`${loader} установлен: ${profileId}`);
    return instance;
  } finally { operationLocks.delete(instance.id); }
}

async function applyOfflineSkinToInstance(instance) {
  const profile = getProfile();
  if (!instance) return { applied: false, reason: 'no-instance' };
  // Official Microsoft profiles keep the official Mojang skin/auth path unchanged.
  if (profile.type === 'microsoft') return { applied: false, reason: 'official-profile' };

  const source = skinFileForProfile(profile);
  const hasLocalSkin = Boolean(source && fs.existsSync(source));
  // Community skins require a client-side skin provider even when the user has not uploaded
  // a local PNG. A fresh SAT config previously contained only LocalSkin, which disabled all
  // non-premium/community providers, and this early return prevented CSL from being installed.
  if (instance.loader === 'vanilla') {
    let selectedLoader = '';
    let selectedVersions = [];
    for (const candidate of ['fabric', 'forge', 'neoforge', 'quilt']) {
      try {
        const supported = await getSupportedLoaderGames(candidate);
        if (!supported.includes(instance.minecraftVersion)) continue;
        const versions = await getLoaderVersions(candidate, instance.minecraftVersion);
        if (versions.length) { selectedLoader = candidate; selectedVersions = versions; break; }
      } catch (error) { log(`Проверка загрузчика ${candidate} для офлайн-скинов: ${error.message}`, 'debug'); }
    }
    if (!selectedLoader) throw new Error(`Для офлайн-скинов не найден совместимый Fabric/Forge/NeoForge/Quilt для Minecraft ${instance.minecraftVersion}. Скин не требует лицензии, но для его отображения в игре нужен клиентский загрузчик с поддержкой скинов.`);
    instance = await installLoaderForInstance(instance, selectedLoader, selectedVersions[0].version);
  }
  if (!['fabric', 'forge', 'neoforge', 'quilt'].includes(instance.loader)) throw new Error(`Загрузка офлайн-скинов не поддерживает загрузчик ${instance.loader}.`);
  const installed = (instance.installedContent || []).some(row => row.projectId === 'idMHQ4n2' && row.projectType === 'mod' && row.path && fs.existsSync(row.path));
  if (!installed) {
    await installModrinthProject({ projectId: 'idMHQ4n2', instanceId: instance.id, projectType: 'mod', allowUninstalledVersion: true });
    instance = getInstance(instance.id) || instance;
  }

  const username = String(profile.username || 'Player').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || 'Player';
  const localSkinDir = path.join(instance.root, 'CustomSkinLoader', 'LocalSkin', 'skins');
  fs.mkdirSync(localSkinDir, { recursive: true });
  const skinDestination = path.join(localSkinDir, `${username}.png`);
  if (hasLocalSkin) fs.copyFileSync(source, skinDestination);

  // LocalSkin is a local override; remote community providers remain enabled behind it.
  const configDir = path.join(instance.root, 'CustomSkinLoader');
  const configPath = path.join(configDir, 'CustomSkinLoader.json');
  const config = withLocalSkinProvider(readJson(configPath, {}));
  writeJson(configPath, config);

  if (hasLocalSkin && (!fs.existsSync(skinDestination) || fs.statSync(skinDestination).size < 24)) {
    throw new Error('Файл локального скина не найден после копирования в CustomSkinLoader/LocalSkin/skins.');
  }
  const modFiles = (instance.installedContent || []).filter(row => row.projectId === 'idMHQ4n2' && row.projectType === 'mod' && row.path && fs.existsSync(row.path));
  if (!modFiles.length) throw new Error('CustomSkinLoader не найден в папке mods выбранной сборки. Повтори подготовку поддержки скинов.');
  log(hasLocalSkin
    ? `Офлайн-скин подготовлен для ${username}; включены совместимые community-провайдеры CustomSkinLoader (${modFiles.length} файл), плащи отключены в сборке ${instance.name}.`
    : `Для офлайн-профиля ${username} включены community-провайдеры скинов CustomSkinLoader (${modFiles.length} файл), плащи отключены в сборке ${instance.name}; локальный PNG не задан.`);
  return { applied: true, mode: hasLocalSkin ? 'local-and-community' : 'community-only', instanceId: instance.id, username, loader: instance.loader, skinPath: hasLocalSkin ? skinDestination : '', modPath: modFiles[0].path };
}

function getMinecraftFailureDiagnostics(instance, exitCode = null) {
  const readTail = file => {
    try { if (!fs.existsSync(file)) return ''; return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-180).join('\n'); } catch { return ''; }
  };
  const readHead = file => {
    try { if (!fs.existsSync(file)) return ''; return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(0, 140).join('\n'); } catch { return ''; }
  };
  const readNativeReport = file => {
    try {
      if (!fs.existsSync(file)) return '';
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      // Keep the header (VM, problematic frame, thread) plus the tail where additional native frames may appear.
      return [...lines.slice(0, 150), ...lines.slice(-100)].join('\n');
    } catch { return ''; }
  };
  const root = instance?.root || '';
  const crashDir = path.join(root, 'crash-reports');
  let crashFile = '';
  try { crashFile = fs.readdirSync(crashDir).filter(name => name.endsWith('.txt')).map(name => ({ name, mtime: fs.statSync(path.join(crashDir, name)).mtimeMs })).sort((a,b)=>b.mtime-a.mtime)[0]?.name || ''; } catch {}
  const crash = crashFile ? [readHead(path.join(crashDir, crashFile)), readTail(path.join(crashDir, crashFile))].filter(Boolean).join('\n') : '';
  const latestLog = readTail(path.join(root, 'logs', 'latest.log'));
  let nativeCrashFile = '';
  try { nativeCrashFile = fs.readdirSync(root).filter(name => /^hs_err_pid.*\.log$/i.test(name)).map(name => ({ name, mtime: fs.statSync(path.join(root, name)).mtimeMs })).sort((a,b)=>b.mtime-a.mtime)[0]?.name || ''; } catch {}
  const nativeCrash = nativeCrashFile ? readNativeReport(path.join(root, nativeCrashFile)) : '';
  // Combine all sources: latest.log may contain useful context even when a report exists.
  const text = [nativeCrash, crash, latestLog].filter(Boolean).join('\n');
  const allEvidence = text;
  const offlineProfile = getProfile()?.type === 'offline';
  // Minecraft's client authlib still probes Mojang's user-properties endpoint for an offline
  // session. That request cannot be authenticated by design, so HTTP 401 here is expected and
  // must never be presented by SAT as the reason an offline game crashed. Keep every other
  // exception/error line for real diagnostics.
  const usefulLines = text.split(/\r?\n/)
    // These are routine Fabric startup messages, not evidence of a crash.
    .filter(line => !/^\s*--\s*mixinextras\b/i.test(line))
    .filter(line => !/^\[[^\]]+\]\s*\[[^\]]+\/INFO\]:.*(?:SpongePowered MIXIN Subsystem|Applied \d+ reflected Fabric Mixin target|Initializing MixinExtras)/i.test(line))
    // An offline profile cannot query authenticated Mojang properties or Realms.
    .filter(line => !offlineProfile || !/Failed to fetch user properties|InvalidCredentialsException|status(?:=|:)\s*401|HTTP_ERROR.*401|HTTP 401|Could not authorize you against Realms server|Failed to fetch Realms feature flags|RealmsServiceException|Realms authentication error|Failed to parse into SignedJWT|^\s*at knot\/\/com\.mojang\.(?:realmsclient|authlib)\./i.test(line));
  const important = usefulLines
    .filter(line => /\bFATAL\b|\bERROR\b|\bWARN(?:ING)?\b|exception|caused by|unsupportedclassversion|could not|failed to|modloading|mixin apply failed|invalidinjectionexception|outofmemory|noClassDefFound|access violation/i.test(line))
    .slice(-14);
  const legacyMixinFailure = /(?:NoClassDefFoundError|ClassNotFoundException)[^\r\n]*(?:zone[\/.]rong[\/.]mixinbooter[\/.]EarlyMixinLoader)|zone[\/.]rong[\/.]mixinbooter[\/.]EarlyMixinLoader/i.test(text);
  const hint = legacyMixinFailure
    ? 'Диагностика SAT LAUNCHER: один из модов требует legacy-класс MixinBooter EarlyMixinLoader. Проверь папку mods: для Forge 1.12.2 должна быть совместимая версия MixinBooter, а не только самая новая версия библиотеки.\n'
    : '';
  const javaHint = /UnsupportedClassVersionError|class file version/i.test(text) ? 'Диагностика SAT LAUNCHER: похоже на несовместимую версию Java. Включи автоматический подбор Java в настройках.\n' : '';
  const memoryHint = /OutOfMemoryError|Java heap space/i.test(text) ? 'Диагностика SAT LAUNCHER: JVM исчерпала доступную память. Проверь максимальную память и свободную ОЗУ.\n' : '';
  const javaToolOptionsHint = process.env.JAVA_TOOL_OPTIONS?.trim()
    ? `Обнаружена внешняя переменная JAVA_TOOL_OPTIONS: ${process.env.JAVA_TOOL_OPTIONS}. Она добавляет JVM-флаги вне настроек SAT LAUNCHER. Для контрольного теста отключи её и повтори запуск.\n`
    : '';
  const mixinHint = /Mixin apply failed|InvalidInjectionException|MixinApplyError/i.test(text) ? 'Диагностика SAT LAUNCHER: найден признак конфликта Mixin/модов. Проверь последние добавленные моды и их версии.\n' : '';
  const offlineAuthNote = offlineProfile && /Failed to fetch user properties|InvalidCredentialsException|HTTP_ERROR.*401|HTTP 401/i.test(text)
    ? 'Офлайн-профиль: HTTP 401 от Mojang при получении официальных свойств ожидаем без онлайн-сессии и сам по себе не объясняет вылет.\n'
    : '';
  const offlineRealmsNote = offlineProfile && /Realms authentication error.*Failed to parse into SignedJWT|Failed to parse into SignedJWT/i.test(text)
    ? 'Офлайн-профиль: отказ авторизации Realms ожидаем без Microsoft-токена; Realms недоступен в офлайн-режиме и это сообщение не доказывает причину нативного вылета.\n'
    : '';
  const unsignedExitCode = Number(exitCode) >>> 0;
  const exitCodeHex = `0x${unsignedExitCode.toString(16).toUpperCase().padStart(8, '0')}`;
  const nativeStatusDescription = {
    0xC0000005: 'нарушение доступа к памяти в нативном процессе Java/модуля',
    0xC0000409: 'аварийное завершение Windows через fast-fail (STATUS_STACK_BUFFER_OVERRUN)',
  }[unsignedExitCode] || '';
  const nativeCode = Boolean(nativeStatusDescription);
  const nativeFrameMatch = nativeCrash.match(/(?:Problematic frame:|Native frames:)[\s\S]{0,500}/i);
  const nativeFrame = nativeFrameMatch ? nativeFrameMatch[0].replace(/\n{2,}/g, '\n').trim() : '';
  const nativeCrashHint = nativeCode
    ? `Код выхода ${Number(exitCode)} (${exitCodeHex}) указывает на ${nativeStatusDescription}; это не обычная ошибка HTTP 401.\n${nativeCrashFile ? `Найден отчёт JVM: ${path.join(root, nativeCrashFile)}\n` : 'Файл hs_err_pid не найден в папке сборки. Лаунчер запрашивает -XX:ErrorFile; проверь строку «JVM native crash report argument» в launcher.log. Некоторые нативные падения драйвера могут завершиться без отчёта HotSpot.\n'}${nativeFrame ? `Фрагмент нативного отчёта:\n${nativeFrame}\n` : 'Один код выхода не определяет виновника. Возможны JVM, графический драйвер/LWJGL, переменная JAVA_TOOL_OPTIONS или нативная библиотека.\n'}`
    : '';
  const watchdogShutdownReport = /Watchdog \(Client shutdown from window close callback\)|Client shutdown from window close callback/i.test(allEvidence);
  const watchdogShutdownHint = watchdogShutdownReport
    ? 'В отчёте есть «Client shutdown from window close callback»: watchdog зафиксировал, что клиент не завершил закрытие окна вовремя. Это может быть вторичным отчётом о зависании при закрытии; сам стек watchdog не называет исходный виновный компонент. Ищи более раннюю ошибку и нативный отчёт.\n'
    : '';
  const missingEndOfFrameEffect = /Requested post effect does not exist:\s*minecraft:end_of_frame/i.test(allEvidence);
  const endOfFrameEffectHint = missingEndOfFrameEffect
    ? 'Предупреждение «Requested post effect does not exist: minecraft:end_of_frame» само по себе не доказывает причину падения: в Minecraft 26.3 это сообщение о ненайденном эффекте постобработки ресурспака и оно встречается также в логах работающих клиентов. Не считай его единственной причиной без нативного отчёта.\n'
    : '';
  const postRenderFailure = /Error section:\s*Post render|\bPost render\b/i.test(allEvidence);
  const renderFailureHint = postRenderFailure
    ? 'В журнале обнаружено «Error section: Post render»: сбой отмечен на этапе постобработки/отрисовки. Это не называет виновный мод, но делает графический стек главным направлением проверки. Для теста отключи шейдеры и ресурспаки, временно убери или обнови моды рендеринга (например, Iris/Sodium/OptiFine/Embeddium — только те, что установлены), выключи оверлеи записи/мониторинга и обнови драйвер видеокарты. Возвращай компоненты по одному, чтобы выделить источник.\n'
    : '';
  const fallbackTail = usefulLines.filter(line => !/^\s+at\s/.test(line)).slice(-24).join('\n').slice(-1400);
  const noCrashEvidence = 'Однозначная причина вылета не найдена. Отдельный crash-report пока не создан или не содержит причину. После повторного запуска проверь logs/latest.log, crash-reports и hs_err_pid*.log в папке сборки.';
  const summary = hint + javaHint + memoryHint + javaToolOptionsHint + mixinHint + offlineAuthNote + offlineRealmsNote + watchdogShutdownHint + endOfFrameEffectHint + renderFailureHint + nativeCrashHint + (important.join('\n').slice(-2600) || fallbackTail || noCrashEvidence);
  return { crashReport: crashFile ? path.join(crashDir, crashFile) : '', nativeCrashReport: nativeCrashFile ? path.join(root, nativeCrashFile) : '', latestLogPath: path.join(root, 'logs', 'latest.log'), summary: summary.slice(-3000), tail: text.slice(-3800), exitCode };
}

async function ensureLegacyMixinBooterDependency(instance) {
  if (!instance || instance.minecraftVersion !== '1.12.2' || instance.loader !== 'forge') return { changed: false };
  const modsDirectory = path.join(instance.root, 'mods');
  if (!fs.existsSync(modsDirectory)) return { changed: false };

  const AdmZip = require('adm-zip');
  const report = inspectLegacyMixinBooterDependency(modsDirectory, { AdmZip });
  if (!report.required || report.provided) return { changed: false, report };

  const params = new URLSearchParams({
    game_versions: JSON.stringify([instance.minecraftVersion]),
    loaders: JSON.stringify(['forge']),
    include_changelog: 'false'
  });
  let versions;
  try {
    versions = await fetchJson(`${MODRINTH_API}/project/mixinbooter/version?${params.toString()}`, {}, 45000);
  } catch (error) {
    throw new Error(`Обнаружен мод, которому нужен класс ${LEGACY_MIXINBOOTER_CLASS}, но он отсутствует в папке mods. Не удалось проверить совместимую библиотеку MixinBooter на Modrinth: ${error.message}`);
  }
  const candidates = (Array.isArray(versions) ? versions : [])
    .filter(version => version?.version_type === 'release'
      && Array.isArray(version.game_versions) && version.game_versions.includes(instance.minecraftVersion)
      && Array.isArray(version.loaders) && version.loaders.includes('forge')
      && Number(String(version.version_number || '').split('.')[0]) < 11
      && Array.isArray(version.files) && version.files.some(file => typeof file?.url === 'string' && file.url.startsWith('https://') && /\.jar$/i.test(file.filename || '')))
    .sort((a, b) => compareVersion(b.version_number, a.version_number));
  const preferred = selectLegacyMixinBooterRelease(candidates);
  const ordered = preferred ? [preferred, ...candidates.filter(row => row.id !== preferred.id)] : candidates;
  if (!ordered.length) throw new Error('Обнаружена ссылка на старый EarlyMixinLoader, но Modrinth не вернул стабильную версию MixinBooter для Forge 1.12.2. Проверка остановлена без изменения файлов сборки.');

  let verified = null;
  let cachedPath = '';
  let lastFailure = '';
  for (const candidate of ordered.slice(0, 8)) {
    const files = candidate.files.filter(file => typeof file?.url === 'string' && file.url.startsWith('https://') && /\.jar$/i.test(file.filename || ''));
    const file = files.find(entry => entry.primary) || files[0];
    if (!file) continue;
    const cachePath = path.join(CACHE_DIR, 'legacy-dependencies', `${safeFileName(candidate.id || candidate.version_number)}-${safeFileName(file.filename)}`);
    let validCache = false;
    try {
      if (fs.existsSync(cachePath)) {
        const zip = new AdmZip(cachePath);
        validCache = zip.getEntries().some(entry => String(entry.entryName || '').replace(/\\/g, '/') === `${LEGACY_MIXINBOOTER_CLASS}.class`);
      }
    } catch { validCache = false; }
    if (!validCache) {
      fs.rmSync(cachePath, { force: true });
      try {
        progress('launch', 7, `Подготовка обязательной библиотеки MixinBooter ${candidate.version_number}…`);
        await downloadToFile(file.url, cachePath, file.hashes?.sha1 || null, p => progress('launch', 7 + Math.round(p * 0.18), `Загрузка MixinBooter ${candidate.version_number}`));
        const zip = new AdmZip(cachePath);
        validCache = zip.getEntries().some(entry => String(entry.entryName || '').replace(/\\/g, '/') === `${LEGACY_MIXINBOOTER_CLASS}.class`);
      } catch (error) {
        lastFailure = `${candidate.version_number}: ${error.message}`;
        fs.rmSync(cachePath, { force: true });
        continue;
      }
    }
    if (validCache) { verified = { version: candidate, file }; cachedPath = cachePath; break; }
    lastFailure = `${candidate.version_number}: JAR не содержит ${LEGACY_MIXINBOOTER_CLASS}.class`;
    fs.rmSync(cachePath, { force: true });
  }
  if (!verified || !cachedPath) throw new Error(`Не удалось подобрать совместимую версию MixinBooter для одного из установленных модов. ${lastFailure || 'Подходящий JAR не найден.'} Файлы сборки не заменены.`);

  const modsPath = path.join(instance.root, 'mods');
  const destination = path.join(modsPath, safeFileName(verified.file.filename));
  const stagedPath = `${destination}.sat-new-${process.pid}`;
  fs.copyFileSync(cachedPath, stagedPath);
  let stagedHasRequiredClass = false;
  try {
    const stagedZip = new AdmZip(stagedPath);
    stagedHasRequiredClass = stagedZip.getEntries().some(entry => String(entry.entryName || '').replace(/\\/g, '/') === `${LEGACY_MIXINBOOTER_CLASS}.class`);
  } catch {}
  if (!stagedHasRequiredClass) {
    fs.rmSync(stagedPath, { force: true });
    throw new Error(`Проверка загруженной библиотеки MixinBooter не пройдена: отсутствует ${LEGACY_MIXINBOOTER_CLASS}.class. Старые файлы сборки сохранены.`);
  }

  // The verified candidate is staged first. Preserve any incompatible JAR outside mods,
  // then atomically place the replacement in the active folder.
  if (report.mixinBooterJars.length) {
    const backupDir = path.join(instance.root, '.sat-launcher-backup', 'mixinbooter');
    fs.mkdirSync(backupDir, { recursive: true });
    for (const entry of report.mixinBooterJars) {
      if (!fs.existsSync(entry.path)) continue;
      let backupPath = path.join(backupDir, entry.filename);
      if (fs.existsSync(backupPath)) backupPath = path.join(backupDir, `${Date.now()}-${entry.filename}`);
      fs.renameSync(entry.path, backupPath);
      log(`Сохранена резервная копия несовместимого MixinBooter: ${backupPath}`, 'warn');
    }
  }
  if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
  fs.renameSync(stagedPath, destination);

  instance = getInstance(instance.id) || instance;
  const installedContent = Array.isArray(instance.installedContent) ? instance.installedContent : [];
  const record = { projectId: 'mixinbooter', projectType: 'mod', versionId: verified.version.id, filename: verified.file.filename, path: destination, installedAt: new Date().toISOString(), autoDependency: true };
  const index = installedContent.findIndex(row => row.projectType === 'mod' && (row.projectId === 'mixinbooter' || /mixin[-_ ]?booter/i.test(row.filename || '')));
  if (index >= 0) installedContent[index] = { ...installedContent[index], ...record }; else installedContent.push(record);
  instance.installedContent = installedContent;
  saveInstance(instance);
  log(`Автоматически добавлена совместимая библиотека MixinBooter ${verified.version.version_number}: ${destination}. Причина: ${report.referencedBy.join(', ')} ссылается на ${LEGACY_MIXINBOOTER_CLASS}.`);
  emit('launcher:installerLine', `Добавлена необходимая зависимость MixinBooter ${verified.version.version_number}`);
  return { changed: true, version: verified.version.version_number, report };
}

async function ensureIrisSodiumCompatibility(instance) {
  if (!instance || String(instance.minecraftVersion) !== '1.21.1') return { changed: false };
  if (!['fabric', 'quilt', 'neoforge'].includes(String(instance.loader || '').toLowerCase())) return { changed: false };
  const iris = findInstalledModDescriptor(instance, 'iris');
  const sodium = findInstalledModDescriptor(instance, 'sodium');
  if (!iris || !sodium) return { changed: false };
  const requiredSeries = getSodiumSeriesRequiredByInstalledIris({ irisVersion: iris.version || iris.rawVersion, minecraftVersion: instance.minecraftVersion });
  if (!requiredSeries || isVersionInSeries(sodium.rawVersion || sodium.version, requiredSeries)) return { changed: false };

  const reason = `Найдена несовместимая пара: Iris ${iris.rawVersion || iris.version} требует Sodium ${requiredSeries}.x, но найден Sodium ${sodium.rawVersion || sodium.version}.`;
  log(`${reason} Автоматически подбирается совместимая версия Sodium перед запуском.`, 'warn');
  emit('launcher:installerLine', `${reason} Исправление перед запуском…`);
  let compatible;
  try {
    compatible = await getModrinthVersion(SODIUM_PROJECT_ID, instance, 'mod', { versionSeries: requiredSeries });
  } catch (error) {
    throw new Error(`${reason} Не удалось загрузить совместимую версию из Modrinth: ${error.message}`);
  }
  if (!compatible?.id) throw new Error(`${reason} Modrinth не вернул совместимую версию Sodium.`);
  const result = await installModrinthProjectInternal({
    projectId: SODIUM_PROJECT_ID,
    instanceId: instance.id,
    projectType: 'mod',
    allowUninstalledVersion: true
  }, { dependencyStack: [], pinnedVersionId: compatible.id, dependencyContext: { installed: [] } });
  instance = getInstance(instance.id) || instance;
  const finalSodium = findInstalledModDescriptor(instance, 'sodium');
  if (!finalSodium || !isVersionInSeries(finalSodium.rawVersion || finalSodium.version, requiredSeries)) {
    throw new Error(`${reason} Загрузка завершилась, но проверка папки mods не подтвердила замену Sodium. Проверь каталог ${path.join(instance.root, 'mods')}.`);
  }
  emit('launcher:installerLine', `Sodium автоматически заменён на ${compatible.version_number || finalSodium.version}, совместимый с Iris.`);
  log(`Совместимость Iris/Sodium восстановлена: Iris ${iris.rawVersion || iris.version}, Sodium ${compatible.version_number || finalSodium.version}.`);
  return { changed: true, instance };
}

function getResourcePackAssetPaths(absolutePath) {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return walkFiles(absolutePath).map(file => file.name).filter(name => /^assets\//i.test(name));
    if (!stat.isFile() || !/\.zip$/i.test(absolutePath)) return [];
    const AdmZip = require('adm-zip');
    return new AdmZip(absolutePath).getEntries().filter(entry => !entry.isDirectory)
      .map(entry => String(entry.entryName || '').replace(/\\/g, '/').replace(/^\/+/, ''))
      .filter(name => /^assets\//i.test(name) && !name.split('/').some(part => part === '..' || part === '.'));
  } catch { return []; }
}

/**
 * Repair common bad resource-pack layouts before the game starts and report pack
 * collisions. Minecraft intentionally resolves duplicate asset paths by pack priority,
 * so the launcher warns rather than rewriting texture contents or user ordering.
 */
function prepareResourcePacksForLaunch(instance) {
  const root = path.join(instance.root, 'resourcepacks');
  fs.mkdirSync(root, { recursive: true });
  let names = [];
  try { names = fs.readdirSync(root).filter(name => name && !name.startsWith('.')).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })); } catch { return { checked: 0, repaired: 0, warnings: 0, collisions: 0 }; }
  const owners = new Map();
  let checked = 0, repaired = 0, warningCount = 0;
  for (const name of names) {
    const full = path.join(root, name);
    let stat; try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (!stat.isDirectory() && !(stat.isFile() && /\.zip$/i.test(name))) continue;
    checked++;
    try {
      const report = stat.isDirectory()
        ? normalizeResourcePackDirectory(full)
        : normalizeResourcePackArchive(full);
      if (report.changed) {
        repaired++;
        log(`Ресурспак «${name}»: автоматически исправлена структура архива/папки${report.root ? ` (${report.root})` : ''}.`, 'info');
      }
      for (const warning of report.warnings || (report.warning ? [report.warning] : [])) {
        warningCount++;
        log(`Ресурспак «${name}»: ${warning}`, report.valid ? 'warn' : 'error');
      }
      if (!report.valid) continue;
      const assetPaths = getResourcePackAssetPaths(full);
      for (const assetPath of assetPaths) {
        const key = assetPath.toLocaleLowerCase('en-US');
        const list = owners.get(key) || [];
        list.push(name);
        owners.set(key, list);
      }
    } catch (error) {
      warningCount++;
      log(`Не удалось проверить ресурспак «${name}»: ${error.message}`, 'error');
    }
  }
  const conflicts = [...owners.entries()].filter(([, packNames]) => new Set(packNames).size > 1);
  if (conflicts.length) {
    const examples = conflicts.slice(0, 5).map(([asset, packNames]) => `${asset} (${[...new Set(packNames)].join(' ↔ ')})`);
    warningCount++;
    log(`Ресурспаки содержат ${conflicts.length} совпадающих путей ресурсов. Minecraft применяет версию ресурса из пака, который стоит выше в списке активных ресурспаков. Примеры: ${examples.join('; ')}${conflicts.length > 5 ? '; …' : ''}`, 'warn');
  }
  return { checked, repaired, warnings: warningCount, collisions: conflicts.length };
}

function maybePrepareVulkanFallback(instance) {
  if (!instance || String(instance.minecraftVersion) !== '26.3' || instance.graphicsBackend || instance.graphicsBackendFallbackFailed) return;
  let latestAttempt = null;
  for (const file of [LOG_FILE, `${LOG_FILE}.1`, `${LOG_FILE}.2`, `${LOG_FILE}.3`]) {
    try {
      if (!fs.existsSync(file)) continue;
      // launcher.log is rotated at 2 MiB; old releases can exceed that, so bound each read.
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      let text;
      try {
        const buffer = Buffer.alloc(stat.size - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        text = buffer.toString('utf8');
      } finally { fs.closeSync(fd); }
      const inspected = inspectLatestLaunchForInstance(text, instance.name, instance.minecraftVersion);
      if (inspected.found) { latestAttempt = inspected; break; }
    } catch (error) { log(`Не удалось проверить историю графического запуска: ${error.message}`, 'debug'); }
  }
  if (!latestAttempt) return;
  if (!shouldAutoTryVulkan({ version: instance.minecraftVersion, backend: latestAttempt.backend, exitCode: latestAttempt.exitCode, evidence: latestAttempt.evidence })) return;
  instance.graphicsBackend = 'vulkan';
  instance.graphicsBackendAutoFallback = true;
  saveInstance(instance);
  log(`Для сборки «${instance.name}» обнаружен прошлый нативный вылет на OpenGL в Minecraft 26.3. Следующий запуск один раз попробует Vulkan как альтернативный графический backend.`, 'warn');
}

function updateGraphicsBackendAfterClose(instance, code, diagnostics) {
  if (!instance || String(instance.minecraftVersion) !== '26.3' || !code) return;
  let latest = '';
  try {
    const file = path.join(instance.root, 'logs', 'latest.log');
    if (fs.existsSync(file)) {
      const stat = fs.statSync(file);
      const start = Math.max(0, stat.size - 500 * 1024);
      const fd = fs.openSync(file, 'r');
      try { const buffer = Buffer.alloc(stat.size - start); fs.readSync(fd, buffer, 0, buffer.length, start); latest = buffer.toString('utf8'); }
      finally { fs.closeSync(fd); }
    }
  } catch {}
  const backend = latest.match(/Using graphics backend\s+(OpenGL|Vulkan)/i)?.[1] || (instance.graphicsBackend === 'vulkan' ? 'Vulkan' : 'OpenGL');
  const evidence = `${diagnostics?.summary || ''}\n${latest}`;
  if (shouldAutoTryVulkan({ version: instance.minecraftVersion, backend, exitCode: code, evidence })) {
    if (instance.graphicsBackend !== 'vulkan' && !instance.graphicsBackendFallbackFailed) {
      instance.graphicsBackend = 'vulkan';
      instance.graphicsBackendAutoFallback = true;
      saveInstance(instance);
      log(`Обнаружен нативный вылет Minecraft 26.3 на OpenGL в сборке «${instance.name}». Следующий запуск попробует Vulkan; это диагностический обходной путь, а не доказательство причины.`, 'warn');
    }
    return;
  }
  if (shouldRollbackAutoVulkan({ version: instance.minecraftVersion, backend, exitCode: code, automaticFallback: instance.graphicsBackendAutoFallback })) {
    instance.graphicsBackend = '';
    instance.graphicsBackendAutoFallback = false;
    instance.graphicsBackendFallbackFailed = true;
    saveInstance(instance);
    log(`Запуск через Vulkan тоже завершился с ошибкой в сборке «${instance.name}». Автопереключение отключено, возвращён backend по умолчанию. Сохрани новый latest.log для диагностики.`, 'warn');
  }
}

async function launchInstance(instanceId) {
  let instance = getInstance(instanceId);
  if (!instance) throw new Error('Сборка не найдена. Добавь версию или импортируй сборку.');
  const launchKey = String(instance.id);
  if (runningGames.has(launchKey)) throw new Error('Эта сборка уже запущена.');
  if (launchingGames.has(launchKey)) {
    log(`Повторный запрос запуска сборки «${instance.name}» отклонён: подготовка уже выполняется.`, 'warn');
    throw new Error('Эта сборка уже подготавливается к запуску. Дождись завершения текущей попытки.');
  }
  // Lock before the first await. runningGames is filled only after MCLC finishes setup.
  launchingGames.add(launchKey);
  try {
  maybePrepareVulkanFallback(instance);
  fs.mkdirSync(instance.root, { recursive: true });
  for (const folder of ['logs', 'crash-reports', 'reports']) fs.mkdirSync(path.join(instance.root, folder), { recursive: true });
  const profile = getProfile();
  if (!profile.username) throw new Error('Сначала войди через Microsoft или добавь офлайн-профиль.');
  // Refresh and validate Microsoft credentials before touching game files or creating a Java process.
  const authorization = await resolveAuthorization();
  // Only after credentials are refreshed, repair resource packs and the shared world folder.
  prepareResourcePacksForLaunch(instance);
  ensureSharedSavesDirectory(instance);
  // A SAT instance may have its base game version in the standard .minecraft directory
  // or a sibling instance. Seed it before the launcher's install checks so an existing
  // version is not mistakenly treated as missing just because the profile has an isolated root.
  if (prepareInstanceVersion(instance)) {
    instance = getInstance(instance.id) || instance;
  } else {
    log(`Базовая версия Minecraft ${instance.minecraftVersion} не найдена в локальных каталогах профилей; механизм запуска проверит и загрузит недостающие файлы.`, 'warn');
  }
  if (instance.loader !== 'vanilla' && !instance.versionId) {
    instance = await installLoaderForInstance(instance, instance.loader, instance.loaderVersion || '');
  }
  // Repair the specific Iris/Sodium version-range mismatch before Fabric Loader checks mods.
  // This also repairs already-existing instances upgraded from older SAT LAUNCHER versions.
  try {
    const pairCheck = await ensureIrisSodiumCompatibility(instance);
    if (pairCheck.changed) instance = getInstance(instance.id) || pairCheck.instance || instance;
  } catch (dependencyError) {
    log(`Проверка совместимости Iris/Sodium завершилась ошибкой: ${dependencyError.message}`, 'error');
    throw new Error(`Сборка «${instance.name}» содержит несовместимые версии Iris/Sodium. ${dependencyError.message}`);
  }
  // Some older Forge 1.12.2 mods reference MixinBooter's legacy EarlyMixinLoader class.
  // Detect and repair the missing legacy dependency before Minecraft starts and exits with code 1.
  try {
    const dependencyCheck = await ensureLegacyMixinBooterDependency(instance);
    if (dependencyCheck.changed) instance = getInstance(instance.id) || instance;
  } catch (dependencyError) {
    log(`Проверка зависимостей Forge завершилась ошибкой: ${dependencyError.message}`, 'error');
    throw new Error(`Сборка «${instance.name}» содержит мод с отсутствующей зависимостью MixinBooter. ${dependencyError.message}`);
  }
  try {
    const skinResult = await applyOfflineSkinToInstance(instance);
    if (skinResult.applied) instance = getInstance(instance.id) || instance;
  } catch (skinError) {
    log(`Локальный скин не применён к этой сборке: ${skinError.message}`, 'error');
    emit('launcher:installerLine', `Скин не применён: ${skinError.message}`);
    if (profile.type !== 'microsoft') {
      throw new Error(`Не удалось подготовить поддержку community-скинов для Minecraft ${instance.minecraftVersion}. Игра не запущена без явного предупреждения. ${skinError.message}`);
    }
  }
  const java = await getJavaPath(instance.minecraftVersion);
  const settings = getSettings();
  const { Client } = require('minecraft-launcher-core');
  const launcher = new Client();
  const versionOptions = { number: instance.minecraftVersion, type: instance.versionType || 'release' };
  if (instance.loader !== 'vanilla' && instance.versionId) versionOptions.custom = instance.versionId;
  const memoryBudget = resolveMemoryBudget(settings.memoryMin || '2G', settings.memoryMax || '6G', os.totalmem());
  if (memoryBudget.adjusted) {
    log(`Память Java ограничена безопасным пределом для этой системы: запрошено ${memoryBudget.requestedMin}–${memoryBudget.requestedMax}, применено ${memoryBudget.min}–${memoryBudget.max}; физическая ОЗУ ≈ ${memoryBudget.totalGiB} ГБ.`, 'warn');
    emit('launcher:installerLine', `Память Minecraft скорректирована для стабильности: ${memoryBudget.min}–${memoryBudget.max} (ОЗУ системы ≈ ${memoryBudget.totalGiB} ГБ).`);
  } else {
    log(`Память Java: min=${memoryBudget.min}, max=${memoryBudget.max}; физическая ОЗУ ≈ ${memoryBudget.totalGiB} ГБ.`);
  }
  const options = {
    clientPackage: null,
    authorization,
    root: instance.root,
    cache: CACHE_DIR,
    version: versionOptions,
    memory: { min: memoryBudget.min, max: memoryBudget.max },
    javaPath: java,
    timeout: 60000,
    window: { width: '1280', height: '720', fullscreen: false },
    // Force HotSpot to put native JVM crash details into the selected instance folder.
    // Exit 0xC0000005 often happens outside Java bytecode, so latest.log alone may not explain it.
    customArgs: [`-XX:ErrorFile=${path.join(instance.root, 'hs_err_pid%p.log')}`],
    customLaunchArgs: instance.minecraftVersion === '26.3' && instance.graphicsBackend === 'vulkan' ? ['--graphicsBackend', 'vulkan'] : [],
    overrides: { maxSockets: 12 }
  };
  log(`Запуск ${instance.name} / Minecraft ${instance.minecraftVersion} / ${instance.loader}`);
  log(`Java для запуска: ${java}`);
  progress('launch', 0, 'Подготовка Minecraft');
  launcher.on('debug', msg => log(String(msg), 'debug'));
  launcher.on('data', msg => log(String(msg).trim(), 'game'));
  launcher.on('download', msg => log(`Загружен файл: ${msg}`, 'download'));
  launcher.on('download-status', status => {
    const p = status && (status.percentage ?? status.percent ?? status.progress);
    progress('download', typeof p === 'number' ? p : 0, status && status.type ? String(status.type) : 'Загрузка файлов Minecraft');
  });
  launcher.on('progress', state => {
    const p = state && typeof state.task === 'number' && typeof state.total === 'number' && state.total ? Math.floor(state.task / state.total * 100) : 0;
    progress('download', p, state?.type || 'Подготовка игровых файлов');
  });
  const nativeReportArg = `-XX:ErrorFile=${path.join(instance.root, 'hs_err_pid%p.log')}`;
  // Verify MCLC's final arguments and inject ErrorFile before -cp if customArgs wasn't preserved.
  launcher.on('arguments', args => {
    if (!Array.isArray(args)) {
      log('Не удалось проверить итоговые JVM-аргументы minecraft-launcher-core; отчёт hs_err_pid может не записаться.', 'warn');
      return;
    }
    if (!args.some(arg => String(arg).startsWith('-XX:ErrorFile='))) {
      const classpathIndex = args.findIndex(arg => arg === '-cp' || arg === '-classpath');
      args.splice(classpathIndex >= 0 ? classpathIndex : 0, 0, nativeReportArg);
    }
    const effectiveErrorFile = args.find(arg => String(arg).startsWith('-XX:ErrorFile='));
    log(`JVM native crash report argument: ${effectiveErrorFile || 'NOT PRESENT'}`, effectiveErrorFile ? 'info' : 'error');
  });
  if (process.env.JAVA_TOOL_OPTIONS?.trim()) {
    log(`В окружении Windows задана JAVA_TOOL_OPTIONS, JVM применит эти дополнительные флаги: ${process.env.JAVA_TOOL_OPTIONS}. Для контрольного теста запусти лаунчер без этой переменной.`, 'warn');
  }
  const child = await launcher.launch(options);
  if (!child || typeof child.on !== 'function') throw new Error('minecraft-launcher-core не вернул процесс Java. Проверь последние строки журнала подготовки.');
  if (child?.pid) applyMinecraftWindowIcon(Number(child.pid));
  runningGames.set(instance.id, child);
  instance.lastPlayedAt = new Date().toISOString();
  saveInstance(instance);
  progress('launch', 100, 'Minecraft запущен');
  log(`Процесс Minecraft запущен (PID ${child?.pid || 'unknown'})`);
  emit('launcher:gameStarted', { instanceId: instance.id, name: instance.name });
  if (settings.closeAfterLaunch && mainWindow) mainWindow.minimize();
  syncDiscordPresence('game').catch(() => {});
  if (child && child.on) {
    child.on('close', code => {
      runningGames.delete(instance.id);
      log(`Minecraft завершил работу. Код выхода: ${code}`);
      const diagnostics = code && code !== 0 ? getMinecraftFailureDiagnostics(instance, code) : null;
      if (diagnostics?.summary) log(`Диагностика завершения Minecraft:\n${diagnostics.summary}`, 'error');
      updateGraphicsBackendAfterClose(instance, code, diagnostics);
      progress('idle', 0, 'Готово к запуску');
      emit('launcher:gameClosed', { instanceId: instance.id, code, diagnostics });
      syncDiscordPresence(runningGames.size ? 'game' : 'launcher').catch(() => {});
    });
    child.on('error', err => {
      runningGames.delete(instance.id);
      log(`Ошибка процесса Minecraft: ${err.message}`, 'error');
      emit('launcher:gameClosed', { instanceId: instance.id, error: err.message });
      syncDiscordPresence(runningGames.size ? 'game' : 'launcher').catch(() => {});
    });
  }
  return { ok: true, pid: child?.pid || null };
  } finally {
    // Release only after MCLC returned a child and runningGames was populated, or on error.
    launchingGames.delete(launchKey);
  }
}

function hasRussianText(value) {
  return /[А-Яа-яЁё]/.test(String(value || ''));
}
function looksLikeEnglishDescription(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) || []).length;
  return latin > 12 && latin > cyrillic * 2;
}
async function translateModrinthDescriptionToRussian(value) {
  const original = String(value || '').trim();
  if (!original || !looksLikeEnglishDescription(original)) return original;
  if (modrinthTranslationCache.has(original)) return modrinthTranslationCache.get(original);
  // Trim very long markdown descriptions so catalog search remains responsive.
  const source = original.slice(0, 900);
  let result = '';
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=${encodeURIComponent(source)}`;
    const payload = await fetchJson(url, {}, 2600);
    const translated = Array.isArray(payload?.[0]) ? payload[0].map(part => Array.isArray(part) ? String(part[0] || '') : '').join('').trim() : '';
    if (translated && hasRussianText(translated)) result = translated;
  } catch {}
  if (!result) {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(source)}&langpair=en%7Cru`;
      const payload = await fetchJson(url, {}, 2200);
      const translated = String(payload?.responseData?.translatedText || '').trim();
      if (translated && hasRussianText(translated) && !/MYMEMORY WARNING|PLEASE SELECT TWO DISTINCT LANGUAGES/i.test(translated)) result = translated;
    } catch {}
  }
  if (result && original.length > source.length) result += '…';
  modrinthTranslationCache.set(original, result);
  return result;
}
async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { output[index] = await worker(items[index], index); }
      catch { output[index] = items[index]; }
    }
  });
  await Promise.all(runners);
  return output;
}
async function searchModrinth({ query = '', type = 'modpack', limit = 24, offset = 0, gameVersion = '', loader = '', genre = '', sort = 'downloads' } = {}) {
  const allowedSorts = new Set(['downloads', 'follows', 'updated', 'newest']);
  const params = new URLSearchParams({ query: String(query), limit: String(Math.max(1, Math.min(100, limit))), offset: String(Math.max(0, offset)), index: allowedSorts.has(sort) ? sort : 'downloads' });
  const facets = [];
  const projectType = normalizeModrinthProjectType(type);
  facets.push([`project_type:${projectType}`]);
  if (gameVersion && ['mod', 'modpack', 'shader', 'resourcepack', 'datapack'].includes(projectType)) facets.push([`versions:${gameVersion}`]);
  if (loader && loader !== 'vanilla' && projectType === 'mod') facets.push([`categories:${loader}`]);
  const allowedGenres = new Set(['adventure','technology','magic','optimization','decoration','combat','worldgen','challenging','multiplayer']);
  if (genre && allowedGenres.has(genre)) facets.push([`categories:${genre}`]);
  params.set('facets', JSON.stringify(facets));
  const data = await fetchJson(`${MODRINTH_API}/search?${params}`);
  const hits = await mapWithConcurrency(data.hits || [], 12, async item => {
    // Modrinth search results usually contain a square icon but omit the project gallery.
    let details = null;
    const projectCache = modrinthProjectDetailsCache.get(item.project_id);
    if (projectCache && projectCache.expiresAt > Date.now()) details = projectCache.value;
    else {
      try {
        details = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(item.project_id)}`, {}, 3600);
        modrinthProjectDetailsCache.set(item.project_id, { value: details, expiresAt: Date.now() + 30 * 60 * 1000 });
        if (modrinthProjectDetailsCache.size > 400) modrinthProjectDetailsCache.delete(modrinthProjectDetailsCache.keys().next().value);
      } catch {}
    }
    const sourceGallery = Array.isArray(details?.gallery) ? details.gallery : (Array.isArray(item.gallery) ? item.gallery : []);
    const gallery = sourceGallery.map(entry => typeof entry === 'string' ? entry : String(entry?.url || '')).filter(url => /^https?:\/\//i.test(url));
    const icon = details?.icon_url || item.icon_url || '';
    return {
      id: item.project_id, title: item.title, description: details?.description || item.description || '', descriptionRu: '', author: item.author || 'Modrinth',
      icon, gallery, headerImage: gallery.find(Boolean) || icon || '',
      downloads: item.downloads || 0, follows: item.follows || 0, projectType: item.project_type,
      versions: item.versions || [], categories: item.display_categories || item.categories || [],
      url: `https://modrinth.com/${item.project_type}/${item.slug || item.project_id}`,
      source: 'Modrinth', slug: item.slug || item.project_id
    };
  });
  // Translate English blurbs automatically, with a small concurrency limit to avoid hammering the free endpoint.
  return mapWithConcurrency(hits, 12, async item => {
    item.descriptionRu = await translateModrinthDescriptionToRussian(item.description);
    return item;
  });
}

function collectPackFiles(directory, type, relative = '', output = []) {
  if (!fs.existsSync(directory)) return output;
  let entries = [];
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name), rel = relative ? path.join(relative, entry.name) : entry.name;
    let stat; try { stat = fs.lstatSync(full); } catch { continue; }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) collectPackFiles(full, type, rel, output);
    else if (stat.isFile()) output.push({ full, folder: type, relativePath: rel.replace(/\\/g, '/'), size: stat.size });
    if (output.length > 2500) throw new Error('В сборке больше 2500 файлов контента. Удали лишние файлы или передай их отдельно.');
  }
  return output;
}
async function importInstancePackFromPath(packPath) {
  // Reuse the exact same validator for a preselected SAT archive.
  const AdmZip = require('adm-zip');
  let zip; try { zip = new AdmZip(packPath); } catch (error) { throw new Error(`Не удалось открыть архив сборки: ${error.message}`); }
  if (!zip.getEntry('sat-launcher-pack.json')) throw new Error('В архиве отсутствует sat-launcher-pack.json.');
  // Temporarily route through a small shared path importer below.
  return importSatPackArchive(packPath, zip);
}
async function importSatPackArchive(packPath, preparedZip = null) {
  const AdmZip = require('adm-zip');
  const zip = preparedZip || new AdmZip(packPath);
  const manifestEntry = zip.getEntry('sat-launcher-pack.json');
  if (!manifestEntry) throw new Error('В архиве отсутствует sat-launcher-pack.json.');
  let manifest; try { manifest = JSON.parse(manifestEntry.getData().toString('utf8')); } catch { throw new Error('Манифест SAT LAUNCHER повреждён.'); }
  if (manifest?.format !== 1 || !/^[0-9A-Za-z._-]{1,32}$/.test(String(manifest.minecraftVersion || '')) || !Array.isArray(manifest.content) || manifest.content.length > 2500) throw new Error('Манифест сборки содержит некорректные данные.');
  if (!['vanilla','fabric','forge','neoforge','quilt'].includes(manifest.loader)) throw new Error('В манифесте указан неизвестный загрузчик.');
  let sizeTotal = 0;
  for (const row of manifest.content) {
    if (!['mods','resourcepacks','shaderpacks'].includes(row?.folder) || !['mod','resourcepack','shader'].includes(row?.type)) throw new Error('В архиве указан неподдерживаемый тип контента.');
    const relative = String(row.relativePath || '').replace(/\\/g, '/');
    if (!relative || relative.startsWith('/') || relative.split('/').some(part => !part || part === '.' || part === '..') || /^[a-z]:/i.test(relative)) throw new Error('Архив содержит небезопасный путь; импорт отменён.');
    const entry = zip.getEntry(`payload/${row.folder}/${relative}`); if (!entry || entry.isDirectory) throw new Error(`В архиве отсутствует файл ${relative}.`);
    const data = entry.getData(); sizeTotal += data.length;
    if (sizeTotal > 2 * 1024 * 1024 * 1024) throw new Error('Архив контента превышает лимит 2 ГБ.');
    if (Number(row.size) !== data.length || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || '')) || crypto.createHash('sha256').update(data).digest('hex') !== String(row.sha256).toLowerCase()) throw new Error(`Контрольная сумма не совпадает у файла ${relative}. Архив повреждён или изменён.`);
  }
  const instance = createInstance({ name: `${String(manifest.name || 'Сборка друга').slice(0,54)} (импорт)`, minecraftVersion: manifest.minecraftVersion, versionType: ['release','snapshot','old_beta','old_alpha'].includes(manifest.versionType) ? manifest.versionType : 'release', loader: manifest.loader, loaderVersion: String(manifest.loaderVersion || ''), source: 'SAT Pack' });
  const warnings = [];
  if (instance.loader !== 'vanilla') { try { await installLoaderForInstance(instance, instance.loader, instance.loaderVersion); } catch (error) { warnings.push(`Загрузчик не завершил установку: ${error.message}`); log(`Импорт SAT Pack: загрузчик не установлен полностью: ${error.message}`, 'warn'); } }
  let copied = 0;
  for (const row of manifest.content) {
    const relative = String(row.relativePath).replace(/\\/g, '/'); const entry = zip.getEntry(`payload/${row.folder}/${relative}`); const destination = toAbsoluteInside(instance.root, path.join(row.folder, relative));
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, entry.getData());
    if (row.type === 'resourcepack' && /\.zip$/i.test(destination)) { try { const normalized = normalizeResourcePackArchive(destination); if (normalized.warning) warnings.push(`${path.basename(destination)}: ${normalized.warning}`); } catch (error) { warnings.push(`${path.basename(destination)}: не удалось проверить структуру ресурспака (${error.message})`); } }
    if (row.projectId) { instance.installedContent = Array.isArray(instance.installedContent) ? instance.installedContent : []; instance.installedContent.push({ projectId: String(row.projectId), source: row.source || 'SAT Pack', projectType: row.type, versionId: String(row.versionId || ''), filename: path.basename(destination), path: destination, installedAt: new Date().toISOString() }); }
    copied++;
  }
  saveInstance(instance); log(`Импортирована SAT-сборка ${instance.name}: ${copied} файлов; замечаний ${warnings.length}.`);
  return { ok: true, instance: getInstance(instance.id) || instance, files: copied, warnings };
}

async function importInstancePack() {
  const result = await dialog.showOpenDialog(mainWindow, { title: 'Импортировать сборку SAT LAUNCHER', properties: ['openFile'], filters: [{ name: 'SAT LAUNCHER Pack', extensions: ['satpack'] }, { name: 'Modrinth / ZIP', extensions: ['mrpack','zip'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const packPath = result.filePaths[0];
  if (/\.mrpack$/i.test(packPath)) return installMrpack(packPath);
  const AdmZip = require('adm-zip');
  let zip;
  try { zip = new AdmZip(packPath); } catch (error) { throw new Error(`Не удалось открыть архив сборки: ${error.message}`); }
  if (!zip.getEntry('sat-launcher-pack.json')) throw new Error('Неизвестный ZIP: нет sat-launcher-pack.json. Для локального обмена выбери .satpack, для Modrinth — .mrpack.');
  return importSatPackArchive(packPath, zip);
  /* Importer above validates paths, hashes, size and loader before writing any files. */
}
async function inspectAndRepairInstance(instanceId, { repair = false } = {}) {
  let instance = getInstance(String(instanceId || ''));
  if (!instance) throw new Error('Сборка не найдена.');
  // Minecraft and minecraft-launcher-core expect these directories to be writable.
  // Create them before launch so an otherwise healthy instance never fails because a report directory is absent.
  for (const folder of ['logs','crash-reports','reports','mods','resourcepacks','shaderpacks','config','saves']) { try { fs.mkdirSync(path.join(instance.root, folder), { recursive: true }); } catch (error) { throw new Error(`Не удалось подготовить каталог ${folder}: ${error.message}`); } }
  if (runningGames.has(instance.id) || launchingGames.has(String(instance.id))) throw new Error('Закрой Minecraft и дождись завершения запуска этой сборки перед проверкой и восстановлением.');
  const directories = ['mods','resourcepacks','shaderpacks','config','logs','crash-reports'];
  const report = { instanceId: instance.id, name: instance.name, checked: 0, repaired: [], warnings: [], conflicts: [], suggestions: [], diagnostics: null };
  for (const folder of directories) {
    const dir = path.join(instance.root, folder);
    if (!fs.existsSync(dir)) {
      if (repair) { fs.mkdirSync(dir, { recursive: true }); report.repaired.push(`Создан каталог ${folder}/`); }
      else report.suggestions.push(`Отсутствует каталог ${folder}/.`);
    }
  }
  const modDir = path.join(instance.root, 'mods');
  const seenModIds = new Map();
  const badJars = [];
  const duplicateJars = [];
  if (fs.existsSync(modDir)) {
    for (const name of fs.readdirSync(modDir)) {
      const full = path.join(modDir, name);
      let stat; try { stat = fs.lstatSync(full); } catch { continue; }
      if (!stat.isFile() || !/\.jar$/i.test(name)) continue;
      report.checked++;
      try {
        const AdmZip = require('adm-zip');
        const jar = new AdmZip(full);
        if (!jar.getEntries().length) throw new Error('JAR не содержит файлов');
        const descriptor = readModDescriptorFromJar(full);
        if (descriptor?.id) {
          const key = String(descriptor.id).toLowerCase();
          if (seenModIds.has(key)) { report.conflicts.push({ kind: 'duplicate-mod-id', modId: key, files: [path.basename(seenModIds.get(key)), name], message: `Два файла объявляют один ID мода «${key}».` }); duplicateJars.push({ path: full, filename: name, modId: key }); }
          else seenModIds.set(key, full);
        }
      } catch (error) {
        badJars.push({ path: full, filename: name, error: error.message });
        report.conflicts.push({ kind: 'corrupt-jar', filename: name, message: `Повреждённый JAR: ${error.message}` });
      }
    }
  }
  // Detect case-insensitive filename duplicates in resource packs and shader packs.
  for (const folder of ['resourcepacks','shaderpacks']) {
    const dir = path.join(instance.root, folder); if (!fs.existsSync(dir)) continue;
    const seen = new Set();
    for (const name of fs.readdirSync(dir)) {
      const key = name.toLowerCase();
      if (seen.has(key)) report.conflicts.push({ kind: 'duplicate-file', filename: name, message: `Повторяющееся имя файла в ${folder}/: ${name}` });
      seen.add(key);
      const full = path.join(dir, name);
      try { if (folder === 'resourcepacks' && fs.lstatSync(full).isFile() && /\.zip$/i.test(name)) {
        report.checked++;
        if (repair) { const result = normalizeResourcePackArchive(full); if (result.warning) report.warnings.push(`${name}: ${result.warning}`); if (result.changed) report.repaired.push(`Нормализована структура ресурспака ${name}`); }
        else { const AdmZip = require('adm-zip'); const archive = new AdmZip(full); const hasMetaAtRoot = Boolean(archive.getEntry('pack.mcmeta')); if (!hasMetaAtRoot) report.warnings.push(`${name}: pack.mcmeta отсутствует в корне ZIP; вероятно, ресурспак вложен в папку или повреждён. Нажми «Автоматически исправить», чтобы нормализовать архив.`); }
      } } catch (error) { report.warnings.push(`${name}: ${error.message}`); }
    }
  }
  const now = Date.now();
  for (const folder of ['mods','resourcepacks','shaderpacks']) {
    const dir = path.join(instance.root, folder); if (!fs.existsSync(dir)) continue;
    let names=[]; try { names = fs.readdirSync(dir); } catch {}
    for (const name of names) if (/\.part-[^-]+-\d+$/i.test(name)) {
      const full = path.join(dir,name); try { const stat=fs.statSync(full); if (now-stat.mtimeMs > 24*60*60*1000) { if (repair) { fs.rmSync(full,{force:true}); report.repaired.push(`Удалён устаревший незавершённый файл ${folder}/${name}`); } else report.suggestions.push(`Устаревший незавершённый файл: ${folder}/${name}`); } } catch {}
    }
  }
  if (repair && (badJars.length || duplicateJars.length)) {
    const backupDir = path.join(instance.root, 'sat-repair-backup', new Date().toISOString().replace(/[:.]/g,'-'));
    for (const row of badJars) {
      try {
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(row.path, path.join(backupDir, row.filename));
        const record = (instance.installedContent || []).find(item => item.path && path.resolve(item.path) === path.resolve(row.path) && item.projectId);
        if (record) {
          fs.rmSync(row.path, { force: true });
          instance.installedContent = (instance.installedContent || []).filter(item => !item.path || path.resolve(item.path) !== path.resolve(row.path));
          saveInstance(instance);
          instance = getInstance(instance.id) || instance;
          await installModrinthProjectInternal({ projectId: record.projectId, instanceId: instance.id, projectType: record.projectType || 'mod', allowUninstalledVersion: true }, { pinnedVersionId: record.versionId || '' });
          instance = getInstance(instance.id) || instance;
          report.repaired.push(`Повторно скачан повреждённый компонент ${row.filename}; копия сохранена в sat-repair-backup/`);
        } else {
          fs.rmSync(row.path, { force: true });
          instance.installedContent = (instance.installedContent || []).filter(item => !item.path || path.resolve(item.path) !== path.resolve(row.path));
          saveInstance(instance);
          report.repaired.push(`Повреждённый локальный JAR ${row.filename} перенесён в резервную копию (оригинал сохранён).`);
        }
      } catch (error) { report.warnings.push(`Не удалось восстановить ${row.filename}: ${error.message}. Резервная копия сохранена, если успела создаться.`); }
    }
  }
  if (repair && duplicateJars.length) {
    const backupDir = path.join(instance.root, 'sat-repair-backup', new Date().toISOString().replace(/[:.]/g,'-'));
    for (const row of duplicateJars) {
      try {
        if (!fs.existsSync(row.path)) continue;
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(row.path, path.join(backupDir, row.filename));
        fs.rmSync(row.path, { force: true });
        instance = getInstance(instance.id) || instance;
        instance.installedContent = (instance.installedContent || []).filter(item => !item.path || path.resolve(item.path) !== path.resolve(row.path));
        saveInstance(instance);
        report.repaired.push(`Убран дубликат мода ${row.modId}: ${row.filename}; копия сохранена в sat-repair-backup/`);
      } catch (error) { report.warnings.push(`Не удалось убрать дубликат ${row.filename}: ${error.message}`); }
    }
  }
  const diagnostics = getMinecraftFailureDiagnostics(instance);
  report.diagnostics = diagnostics;
  // Ignore stale persistent log errors; only the current launcher session can flag the installer panel.
  let installerErrorLines = [];
  try {
    installerErrorLines = (Array.isArray(logs) ? logs : [])
      .filter(row => Number(row?.time || 0) >= LAUNCHER_SESSION_STARTED_AT && /\b(error|failed|exception|fatal|timeout)\b|не удалось|ошибка|сбой|HTTP [45]\d{2}/i.test(String(row?.message || '')))
      .slice(-8)
      .map(row => String(row.message || '').slice(0, 700));
  } catch {}
  report.installerDiagnostics = { path: LOG_FILE, lines: installerErrorLines };
  if (installerErrorLines.length) report.suggestions.push(`В текущем сеансе лаунчера найдены сообщения об ошибках: ${installerErrorLines[installerErrorLines.length - 1].slice(0, 260)}`);
  const text = String(diagnostics.tail || diagnostics.summary || '');
  if (/OutOfMemoryError|Java heap space/i.test(text)) report.suggestions.push('Вероятна нехватка памяти Java. Увеличь максимальную память в настройках, но не выделяй больше доступной ОЗУ.');
  if (/UnsupportedClassVersionError|class file version/i.test(text)) report.suggestions.push('Вероятно, выбран неподходящий Java Runtime для этой версии Minecraft или мода. Включи автоматический подбор Java.');
  if (/Mixin apply failed|InvalidInjectionException|MixinApplyError/i.test(text)) report.suggestions.push('Похоже на конфликт Mixin или несовместимые версии модов. Сравни последние добавленные моды и версии загрузчика.');
  if (/NoSuchMethodError|NoClassDefFoundError|ClassNotFoundException/i.test(text)) report.suggestions.push('Вероятна отсутствующая зависимость или несовместимая версия библиотеки. Проверь обязательные зависимости модов.');
  if (/GL_OUT_OF_MEMORY|OpenGL|Shader compilation|shader compile/i.test(text)) report.suggestions.push('Ошибка графики или шейдера. Временно отключи шейдеры и обнови драйвер видеокарты.');
  if (!repair && !report.conflicts.length && !report.warnings.length && !report.suggestions.length) report.suggestions.push('Явных повреждений не обнаружено. Это не гарантирует отсутствие всех конфликтов модов.');
  if (repair) {
    const after = await inspectAndRepairInstance(instance.id, { repair: false });
    return { ...after, repaired: report.repaired, warnings: [...report.warnings, ...(after.warnings || [])] };
  }
  return report;
}

function readModDescriptorFromJar(jarPath) {
  if (!jarPath || !fs.existsSync(jarPath) || !/\.jar$/i.test(jarPath)) return null;
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(jarPath);
    const readJsonEntry = names => {
      for (const name of names) {
        const entry = zip.getEntry(name);
        if (!entry) continue;
        try { return JSON.parse(entry.getData().toString('utf8')); } catch {}
      }
      return null;
    };
    const fabric = readJsonEntry(['fabric.mod.json']);
    if (fabric?.id) return { id: String(fabric.id).toLowerCase(), version: normalizeModVersion(fabric.version || ''), rawVersion: String(fabric.version || ''), path: jarPath };
    const quilt = readJsonEntry(['quilt.mod.json']);
    const quiltLoader = quilt?.quilt_loader || quilt?.quiltLoader;
    if (quiltLoader?.id) return { id: String(quiltLoader.id).toLowerCase(), version: normalizeModVersion(quiltLoader.version || ''), rawVersion: String(quiltLoader.version || ''), path: jarPath };
    for (const entryName of ['META-INF/neoforge.mods.toml', 'META-INF/mods.toml']) {
      const entry = zip.getEntry(entryName);
      if (!entry) continue;
      const text = entry.getData().toString('utf8');
      const sections = text.split(/(?=\[\[mods\]\])/i);
      for (const section of sections) {
        const id = section.match(/\bmodId\s*=\s*["']([^"']+)["']/i)?.[1];
        if (id) {
          const version = section.match(/\bversion\s*=\s*["']([^"']+)["']/i)?.[1] || '';
          return { id: String(id).toLowerCase(), version: normalizeModVersion(version), rawVersion: version, path: jarPath };
        }
      }
    }
    const mcmod = readJsonEntry(['mcmod.info']);
    const oldMods = Array.isArray(mcmod) ? mcmod : (Array.isArray(mcmod?.modList) ? mcmod.modList : []);
    const oldMod = oldMods.find(item => item?.modid || item?.modId);
    if (oldMod) return { id: String(oldMod.modid || oldMod.modId).toLowerCase(), version: normalizeModVersion(oldMod.version || ''), rawVersion: String(oldMod.version || ''), path: jarPath };
  } catch (error) {
    log(`Не удалось прочитать метаданные мода ${path.basename(jarPath)}: ${error.message}`, 'debug');
  }
  return null;
}

function findInstalledModDescriptor(instance, modId) {
  const target = String(modId || '').trim().toLowerCase();
  if (!target || !instance?.root) return null;
  const modsDir = path.join(instance.root, 'mods');
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!/\.jar$/i.test(name)) continue;
      const filePath = path.join(modsDir, name);
      const descriptor = readModDescriptorFromJar(filePath);
      if (descriptor?.id === target) return descriptor;
    }
  } catch {}
  // Older launcher builds did not store version_number in the local content index.
  // Try the filename as a fallback for the common Modrinth naming convention.
  const row = (instance.installedContent || []).find(item => item?.projectType === 'mod' && (String(item.projectId || '') === (target === 'iris' ? IRIS_PROJECT_ID : SODIUM_PROJECT_ID) || String(item.filename || '').toLowerCase().includes(`${target}-`)) && item.path && fs.existsSync(item.path));
  if (!row) return null;
  const rawVersion = row.versionNumber || String(row.filename || '').match(/(?:^|[-_])((?:\d+\.){2}\d+(?:\+[^.]*)?)/)?.[1] || '';
  return { id: target, version: normalizeModVersion(rawVersion), rawVersion, path: row.path };
}

function backupDuplicateSodiumJars(instance, selectedPath) {
  const modsDir = path.resolve(path.join(instance.root, 'mods'));
  const desired = path.resolve(selectedPath);
  const backupDir = path.join(CACHE_DIR, 'compatibility-backups', safeFileName(instance.id || 'instance'), 'sodium');
  let moved = [];
  try { fs.mkdirSync(backupDir, { recursive: true }); } catch { return moved; }
  try {
    for (const name of fs.readdirSync(modsDir)) {
      if (!/\.jar$/i.test(name)) continue;
      const oldPath = path.resolve(path.join(modsDir, name));
      if (oldPath === desired) continue;
      const descriptor = readModDescriptorFromJar(oldPath);
      if (descriptor?.id !== 'sodium') continue;
      let backupPath = path.join(backupDir, `${Date.now()}-${safeFileName(name)}`);
      try {
        fs.renameSync(oldPath, backupPath);
        moved.push({ oldPath, backupPath });
        log(`Сохранена резервная копия несовместимой/дублирующей Sodium: ${name} → ${backupPath}`, 'warn');
      } catch (error) {
        log(`Не удалось убрать дублирующий Sodium ${name}: ${error.message}`, 'warn');
      }
    }
  } catch {}
  if (moved.length) {
    const latest = getInstance(instance.id) || instance;
    latest.installedContent = (latest.installedContent || []).filter(row => !moved.some(item => path.resolve(String(row.path || '')) === item.oldPath));
    saveInstance(latest);
  }
  return moved;
}


const EXTERNAL_SOURCE_CONFIG = {
  github: { name: 'GitHub Releases', api: 'https://api.github.com' },
  hangar: { name: 'Hangar', api: 'https://hangar.papermc.io/api/v1' },
  spiget: { name: 'Spiget', api: 'https://api.spiget.org/v2' }
};
function externalTypeKeywords(type) { return ({ mod:'minecraft mod', modpack:'minecraft modpack', shader:'minecraft shader', resourcepack:'minecraft resource pack', datapack:'minecraft datapack' })[type] || 'minecraft'; }
function normalizeExternalItem({ id,title,description='',author='Community',icon='',gallery=[],versions=[],latestVersion='',minecraftVersions=[],url,source,projectType,downloads=0 }) { return { id:String(id), title:String(title||id), description:String(description||''), descriptionRu:'', author:String(author||'Community'), icon:String(icon||''), gallery:Array.isArray(gallery)?gallery.filter(Boolean):[], headerImage:String(gallery?.[0]||icon||''), downloads:Number(downloads)||0, follows:0, projectType, versions:Array.isArray(versions)?versions.map(String):[], latestVersion:String(latestVersion||''), minecraftVersions:Array.isArray(minecraftVersions)?minecraftVersions.map(String):[], categories:[], url:String(url||''), source, slug:String(id) }; }
async function searchGitHubContent({ query='', type='modpack', limit=12, gameVersion='' }={}) {
  const q=[String(query||'').trim(),externalTypeKeywords(type),gameVersion?`Minecraft ${gameVersion}`:''].filter(Boolean).join(' ');
  const url=`${EXTERNAL_SOURCE_CONFIG.github.api}/search/repositories?${new URLSearchParams({q,per_page:String(Math.min(30,Math.max(1,limit))),page:'1',sort:'stars',order:'desc'})}`;
  const data=await fetchJson(url,{headers:{Accept:'application/vnd.github+json','User-Agent':APP_USER_AGENT}},18000);
  const repos=Array.isArray(data.items)?data.items:[];
  const enriched=await Promise.allSettled(repos.map(async item => {
    let versions=[]; let minecraftVersions=[]; let latestVersion='';
    try {
      const releases=await fetchJson(`https://api.github.com/repos/${encodeURIComponent(item.owner?.login||'')}/${encodeURIComponent(item.name||'')}/releases?per_page=12`,{headers:{Accept:'application/vnd.github+json','User-Agent':APP_USER_AGENT}},12000);
      const rows=(Array.isArray(releases)?releases:[]).filter(r=>!r.draft);
      for(const r of rows){
        const v=String(r.tag_name||r.name||'').trim();
        if(v && !versions.includes(v)) versions.push(v);
        const text=[r.tag_name,r.name,...(r.body?[r.body]:[])].filter(Boolean).join(' ');
        const found=[...text.matchAll(/(?:Minecraft|MC|mc)[ _-]?(\d+\.\d+(?:\.\d+)?)/gi)].map(m=>m[1]);
        for(const v of found) if(!minecraftVersions.includes(v)) minecraftVersions.push(v);
      }
      latestVersion=versions[0]||'';
    } catch {}
    return normalizeExternalItem({id:`github-${item.id}`,title:item.full_name,description:item.description||'GitHub-проект Minecraft.',author:item.owner?.login||'GitHub',icon:item.owner?.avatar_url||'',url:item.html_url,source:'GitHub',projectType:type,downloads:item.stargazers_count||0,versions:versions.slice(0,12),latestVersion,minecraftVersions:minecraftVersions.slice(0,12)});
  }));
  return enriched.filter(x=>x.status==='fulfilled').map(x=>x.value);
}
async function searchHangarContent({ query='', type='mod', limit=12, gameVersion='' }={}) {
  if(type!=='mod') return [];
  const url=`${EXTERNAL_SOURCE_CONFIG.hangar.api}/projects?${new URLSearchParams({query:String(query||''),limit:String(Math.min(20,Math.max(1,limit)))})}`;
  const data=await fetchJson(url,{headers:{Accept:'application/json','User-Agent':APP_USER_AGENT}},18000);
  const rows=Array.isArray(data)?data:(data.result||data.items||[]);
  const enriched=await Promise.allSettled(rows.map(async item=>{
    const owner=item.namespace?.owner||item.owner||''; const slug=item.namespace?.slug||item.name||item.slug||item.id; let versions=[]; let minecraftVersions=[];
    try { const d=await fetchJson(`${EXTERNAL_SOURCE_CONFIG.hangar.api}/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions?limit=12`,{headers:{Accept:'application/json','User-Agent':APP_USER_AGENT}},12000); const vr=Array.isArray(d?.result)?d.result:[]; versions=vr.map(v=>String(v?.name||'')).filter(Boolean); minecraftVersions=[...new Set(vr.flatMap(v=>[String(v?.platformDependenciesFormatted||''),String(v?.platformDependencies||'')].flatMap(t=>[...t.matchAll(/\b(1\.\d+(?:\.\d+)?)\b/g)].map(m=>m[1]))))]; } catch {}
    return normalizeExternalItem({id:`hangar-${owner}-${slug}`,title:item.name||slug,description:item.description||'',author:owner||'Hangar',icon:item.avatar||item.icon||'',url:item.url||`https://hangar.papermc.io/${owner}/${slug}`,source:'Hangar',projectType:'mod',downloads:item.stats?.downloads||item.downloads||0,versions,latestVersion:versions[0]||'',minecraftVersions});
  }));
  return enriched.filter(x=>x.status==='fulfilled').map(x=>x.value);
}
async function searchSpigetContent({ query='', type='mod', limit=12 }={}) {
  if(type!=='mod') return [];
  const url=`${EXTERNAL_SOURCE_CONFIG.spiget.api}/search/resources/${encodeURIComponent(String(query||'minecraft'))}/1/${Math.min(20,Math.max(1,limit))}`;
  const data=await fetchJson(url,{headers:{Accept:'application/json','User-Agent':APP_USER_AGENT}},18000);
  const rows=Array.isArray(data)?data:[];
  return rows.map(item=>normalizeExternalItem({id:`spiget-${item.id}`,title:item.name,description:item.tag||item.description||'Spigot/Paper resource.',author:item.author?.name||'Spigot',icon:item.icon?.url||'',url:`https://www.spigotmc.org/resources/${item.id}/`,source:'Spiget',projectType:'mod',downloads:item.downloads||0,versions:[String(item.version||'')].filter(Boolean),latestVersion:String(item.version||'')}));
}

function parseGitHubRepoUrl(url) {
  try { const u = new URL(url); if (u.hostname !== 'github.com') return null; const parts = u.pathname.split('/').filter(Boolean); if (parts.length < 2) return null; return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }; } catch { return null; }
}
function externalAssetScore(name, projectType, gameVersion = '') {
  const n = String(name || '').toLowerCase(); const v = String(gameVersion || '').toLowerCase(); let score = 0;
  if (v && n.includes(v)) score += 120;
  if (projectType === 'mod' && /\.(jar)$/i.test(n)) score += 80;
  if (projectType === 'modpack' && /\.(mrpack|zip)$/i.test(n)) score += 80;
  if (projectType === 'shader' && /\.(zip)$/i.test(n)) score += 70;
  if (projectType === 'resourcepack' && /\.(zip)$/i.test(n)) score += 70;
  if (projectType === 'datapack' && /\.(zip)$/i.test(n)) score += 70;
  if (/source|sources|src|debug|javadoc|api/i.test(n)) score -= 40;
  return score;
}
async function resolveExternalDownload({ source, url, projectType, gameVersion = '' }) {
  if (source === 'GitHub') {
    const repo = parseGitHubRepoUrl(url); if (!repo) throw new Error('Не удалось определить GitHub-репозиторий.');
    const releases = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases?per_page=20`, { headers: { Accept:'application/vnd.github+json', 'User-Agent':APP_USER_AGENT } }, 18000);
    const rows = Array.isArray(releases) ? releases.filter(r => !r.draft) : [];
    const assets = rows.flatMap(r => (r.assets || []).map(a => ({...a, release:r})));
    let candidates = assets.filter(a => /\.(jar|mrpack|zip)$/i.test(a.name || ''));
    if (candidates.length) {
      candidates.sort((a,b) => externalAssetScore(b.name, projectType, gameVersion) - externalAssetScore(a.name, projectType, gameVersion) || new Date(b.release?.published_at || 0) - new Date(a.release?.published_at || 0));
      const a = candidates[0];
      return { url:a.browser_download_url, fileName:safeFileName(a.name), version:a.release?.tag_name || a.release?.name || 'latest', source:'GitHub' };
    }
    // Some Minecraft projects publish their built JAR/ZIP directly in the repository and have no Releases.
    const repoInfo = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, { headers:{Accept:'application/vnd.github+json','User-Agent':APP_USER_AGENT} }, 12000);
    const branch = repoInfo.default_branch || 'main';
    const tree = await fetchJson(`https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/git/trees/${encodeURIComponent(branch)}?recursive=1`, { headers:{Accept:'application/vnd.github+json','User-Agent':APP_USER_AGENT} }, 18000);
    const files = (tree.tree||[]).filter(x=>x.type==='blob' && /\.(jar|mrpack|zip)$/i.test(x.path||''));
    if (!files.length) throw new Error('В GitHub-проекте нет опубликованного JAR/ZIP/mrpack для скачивания. Выбери релиз с готовым файлом.');
    files.sort((a,b)=>externalAssetScore(b.path,projectType,gameVersion)-externalAssetScore(a.path,projectType,gameVersion) || a.path.length-b.path.length);
    const f=files[0];
    return { url:`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${encodeURIComponent(branch)}/${f.path.split('/').map(encodeURIComponent).join('/')}`, fileName:safeFileName(path.basename(f.path)), version:branch, source:'GitHub' };
  }
  if (source === 'Spiget') {
    const match = String(url).match(/resources\/(\d+)/i); if (!match) throw new Error('Не удалось определить ID ресурса Spiget.');
    const id = match[1];
    let version = null; try { version = await fetchJson(`https://api.spiget.org/v2/resources/${id}/versions/latest`, { headers:{'User-Agent':APP_USER_AGENT} }, 12000); } catch {}
    const downloadUrl = `https://api.spiget.org/v2/resources/${id}/versions/latest/download`;
    return { url:downloadUrl, fileName:safeFileName(`${String(version?.name || 'spiget')}-${id}.jar`), version:String(version?.name || 'latest'), source:'Spiget' };
  }
  if (source === 'Hangar') {
    const match = String(url).match(/hangar\.papermc\.io\/([^/]+)\/([^/?#]+)/i); if (!match) throw new Error('Не удалось определить проект Hangar.');
    const owner = match[1], slug = match[2];
    const data = await fetchJson(`https://hangar.papermc.io/api/v1/projects/${encodeURIComponent(owner)}/${encodeURIComponent(slug)}/versions?limit=20`, { headers:{Accept:'application/json','User-Agent':APP_USER_AGENT} }, 18000);
    const rows = Array.isArray(data?.result) ? data.result : [];
    const chosen = rows.find(v => String(v?.platformDependenciesFormatted || v?.platformDependencies || '').includes(String(gameVersion))) || rows[0];
    const dl = chosen?.downloads?.PAPER;
    const downloadUrl = dl?.downloadUrl || (Array.isArray(dl) ? dl[0]?.downloadUrl : '');
    if (!downloadUrl) throw new Error('У выбранной версии Hangar нет прямого файла для скачивания.');
    return { url:downloadUrl, fileName:safeFileName(dl?.fileInfo?.name || `${slug}-${chosen?.name || 'latest'}.jar`), version:String(chosen?.name || 'latest'), source:'Hangar' };
  }
  throw new Error(`Источник ${source || 'неизвестен'} не поддерживает прямую загрузку.`);
}
async function installExternalContent({ source, url, projectType, instanceId, gameVersion = '', targetWorld = '' } = {}) {
  const instance = getInstance(String(instanceId || '')); if (!instance) throw new Error('Сборка не найдена.');
  if (!['GitHub','Spiget','Hangar'].includes(source)) throw new Error('Для этого источника прямая установка пока недоступна.');
  const resolved = await resolveExternalDownload({ source, url, projectType, gameVersion });
  const ext = path.extname(resolved.fileName).toLowerCase();
  const cacheDir = path.join(CACHE_DIR, 'external'); fs.mkdirSync(cacheDir, { recursive:true });
  const temp = path.join(cacheDir, `${Date.now()}-${safeFileName(resolved.fileName)}`);
  await downloadToFile(resolved.url, temp, null, (percent) => progress('content', Math.max(2, Math.min(92, percent)), `Скачивание ${resolved.fileName}: ${percent}%`));
  try {
    if (projectType === 'modpack' || ext === '.mrpack') {
      const result = await installMrpack(temp, instance.id);
      return { ok:true, message:`Сборка ${resolved.version} установлена.` , result };
    }
    const folder = projectType === 'shader' ? 'shaderpacks' : projectType === 'resourcepack' ? 'resourcepacks' : 'mods';
    if (projectType === 'datapack') {
      if (ext !== '.zip') throw new Error('Для датапака нужен ZIP-архив.');
      const worldName=safeFileName(String(targetWorld||'')); if(!worldName) throw new Error('Не выбран мир для датапака.');
      const worldDir=path.join(SHARED_SAVES_DIR,worldName); if(!fs.existsSync(path.join(worldDir,'level.dat'))) throw new Error(`Мир «${worldName}» не найден в общей папке saves.`);
      const AdmZip=require('adm-zip'); const zip=new AdmZip(temp); const datapackDir=path.join(worldDir,'datapacks'); fs.mkdirSync(datapackDir,{recursive:true}); let copied=0;
      for(const entry of zip.getEntries()){ if(entry.isDirectory) continue; const rel=String(entry.entryName||'').replace(/\\/g,'/'); if(!rel || rel.startsWith('/') || rel.split('/').some(part=>!part||part==='.'||part==='..') || /^[a-z]:/i.test(rel)) continue; const dest=toAbsoluteInside(datapackDir,rel); fs.mkdirSync(path.dirname(dest),{recursive:true}); fs.writeFileSync(dest,entry.getData()); copied++; if(copied>5000) throw new Error('Датапак содержит слишком много файлов.'); }
      progress('content',100,'Датапак установлен'); return {ok:true,message:`${path.basename(resolved.fileName)} · версия ${resolved.version} · установлено файлов: ${copied}`};
    }
    if (!['.jar','.zip'].includes(ext)) throw new Error(`Источник вернул неподдерживаемый файл ${ext || 'без расширения'}.`);
    if (projectType === 'mod' && ext !== '.jar') throw new Error('Для мода нужен JAR-файл, а источник отдал ZIP.');
    if (projectType === 'resourcepack') {
      if (ext !== '.zip') throw new Error('Для ресурспака нужен ZIP-архив с pack.mcmeta и assets/.');
      const checkedPack = normalizeResourcePackArchive(temp);
      if (!checkedPack.valid) throw new Error(`Ресурспак не установлен: ${checkedPack.warning || 'повреждённая структура ZIP'}`);
    }
    const targetDir = path.join(instance.root, folder); fs.mkdirSync(targetDir, { recursive:true });
    const target = path.join(targetDir, safeFileName(resolved.fileName));
    fs.copyFileSync(temp, target);
    const latest = getInstance(instance.id) || instance;
    latest.installedContent = Array.isArray(latest.installedContent) ? latest.installedContent : [];
    latest.installedContent.push({ projectId:`external:${source}:${url}`, versionId:resolved.version, projectType, source, path:target, filename:path.basename(target), installedAt:new Date().toISOString() });
    saveInstance(latest);
    progress('content', 100, 'Файл установлен');
    return { ok:true, message:`${path.basename(target)} установлен в ${folder}.` };
  } finally { try { fs.unlinkSync(temp); } catch {} }
}
async function searchCatalogSources({ source='all', ...query }={}) {
  const normalized=String(source||'all').toLowerCase(); const jobs=[];
  if(normalized==='all'||normalized==='modrinth') jobs.push(searchModrinth(query));
  if(normalized==='all'||normalized==='github') jobs.push(searchGitHubContent(query));
  if(normalized==='all'||normalized==='hangar') jobs.push(searchHangarContent(query));
  if(normalized==='all'||normalized==='spiget') jobs.push(searchSpigetContent(query));
  const settled=await Promise.allSettled(jobs); const rows=settled.flatMap(x=>x.status==='fulfilled'?x.value:[]);
  if(!rows.length&&settled.every(x=>x.status==='rejected')) throw new Error('Все выбранные источники временно недоступны.');
  const unique=new Map(); for(const row of rows){const key=`${row.source}:${row.id}`;if(!unique.has(key))unique.set(key,row);} return [...unique.values()];
}

async function getModrinthVersion(projectId, instance, projectType = 'mod', { versionSeries = '', inferInstalledIrisConstraint = true } = {}) {
  projectType = normalizeModrinthProjectType(projectType);
  if (projectType === 'mod' && (!instance.loader || instance.loader === 'vanilla')) {
    throw new Error('Этот проект является модом, а не шейдером или ресурспаком. Для установки модов сначала создай профиль с Fabric, Forge, NeoForge или Quilt.');
  }
  // If an older Iris is already present in the instance, do not select a Sodium
  // release outside Iris' declared range just because it is the newest Modrinth file.
  if (!versionSeries && inferInstalledIrisConstraint && projectType === 'mod' && String(projectId) === SODIUM_PROJECT_ID && String(instance.minecraftVersion) === '1.21.1') {
    const iris = findInstalledModDescriptor(instance, 'iris');
    versionSeries = getSodiumSeriesRequiredByInstalledIris({ irisVersion: iris?.version || '', minecraftVersion: instance.minecraftVersion }) || '';
  }
  const params = new URLSearchParams({ game_versions: JSON.stringify([instance.minecraftVersion]), include_changelog: 'false' });
  if (projectType === 'mod' && instance.loader && instance.loader !== 'vanilla') params.set('loaders', JSON.stringify([instance.loader]));
  const endpoint = `${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`;
  const versions = await fetchJson(`${endpoint}?${params}`);
  const candidates = versionSeries ? versions.filter(v => isVersionInSeries(v?.version_number, versionSeries)) : versions;
  const compatible = selectModrinthVersion(candidates);
  if (compatible) return compatible;
  if (versionSeries) {
    throw new Error(`Не найдена стабильная версия ${projectId}, совместимая с ограничением ${versionSeries}.x для Minecraft ${instance.minecraftVersion} / ${instance.loader}. Установка остановлена, чтобы не создать конфликт модов.`);
  }
  if (projectType === 'shader' || projectType === 'resourcepack' || projectType === 'datapack') {
    // Legacy MC releases are often omitted from compatibility metadata; download a published file with an explicit warning.
    const allVersions = await fetchJson(`${endpoint}?include_changelog=false`);
    const fallback = selectModrinthVersion(allVersions, { allowUnspecifiedCompatibility: true });
    if (fallback) {
      log(`Modrinth ${projectType} ${projectId}: для Minecraft ${instance.minecraftVersion} не найдено явно совместимого файла; выбран ${fallback.version_number}. Совместимость необходимо проверить.`, 'warn');
      return fallback;
    }
  }
  throw new Error(`Modrinth не опубликовал загружаемый файл для Minecraft ${instance.minecraftVersion}${projectType === 'mod' ? ` / ${instance.loader}` : ''}. Для модов выбери совместимый загрузчик и версию игры; для шейдеров или ресурспаков проверь, что проект содержит опубликованный файл.`);
}
function listSharedWorlds() {
  ensureDirectories();
  let names = [];
  try { names = fs.readdirSync(SHARED_SAVES_DIR); } catch { return []; }
  return names.filter(name => {
    if (!name || name.startsWith('.')) return false;
    const root = path.resolve(SHARED_SAVES_DIR, name);
    try { return root.startsWith(path.resolve(SHARED_SAVES_DIR) + path.sep) && fs.statSync(root).isDirectory() && fs.existsSync(path.join(root, 'level.dat')); }
    catch { return false; }
  }).map(name => ({ name, path: path.join(SHARED_SAVES_DIR, name) })).sort((a,b)=>a.name.localeCompare(b.name, 'ru'));
}

async function analyzeModrinthCompatibility({ projectId, instanceId, projectType = 'mod' } = {}) {
  const id = String(projectId || '').trim();
  const instance = getInstance(String(instanceId || ''));
  if (!id || !instance) throw new Error('Выбери мод и сборку, чтобы проверить совместимость.');
  const params = new URLSearchParams({ game_versions: JSON.stringify([instance.minecraftVersion]), include_changelog: 'false' });
  if (instance.loader && instance.loader !== 'vanilla') params.set('loaders', JSON.stringify([instance.loader]));
  let versions = [];
  try { versions = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}/version?${params}`); } catch {}
  if (!versions.length) versions = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}/version?include_changelog=false`);
  let preferredSeries = '';
  if (id === SODIUM_PROJECT_ID && String(instance.minecraftVersion) === '1.21.1') {
    const installedIris = findInstalledModDescriptor(instance, 'iris');
    preferredSeries = getSodiumSeriesRequiredByInstalledIris({ irisVersion: installedIris?.version || installedIris?.rawVersion || '', minecraftVersion: instance.minecraftVersion }) || '';
  }
  const candidateVersions = preferredSeries ? versions.filter(v => isVersionInSeries(v?.version_number, preferredSeries)) : versions;
  const candidate = selectModrinthVersion(candidateVersions, { allowUnspecifiedCompatibility: true });
  if (!candidate) throw new Error(preferredSeries
    ? `Не найден доступный файл ${id} в совместимой серии ${preferredSeries}.x для Minecraft ${instance.minecraftVersion}.`
    : 'Не найден доступный файл проекта для анализа.');
  const installed = (instance.installedContent || []).filter(row => row.projectType === 'mod' && row.projectId && row.path && fs.existsSync(row.path));
  const installedIds = new Set(installed.map(row => row.projectId));
  const dependencies = await Promise.all((candidate.dependencies || []).map(async dep => {
    let projectId = String(dep.project_id || '');
    const versionId = String(dep.version_id || '');
    if (!projectId && versionId) {
      try { const pinned = await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`); projectId = String(pinned.project_id || ''); } catch {}
    }
    return { projectId, versionId, type: String(dep.dependency_type || 'required').toLowerCase() };
  }));
  const missingRequired = dependencies.filter(dep => dep.type === 'required' && dep.projectId && !installedIds.has(dep.projectId) && dep.projectId !== id);
  const conflicts = dependencies.filter(dep => dep.type === 'incompatible' && dep.projectId && installedIds.has(dep.projectId));
  // Fabric's runtime metadata can express version ranges that Modrinth's project-level
  // dependency edge doesn't pin. Surface this real Iris/Sodium mismatch and tell the UI
  // the launcher can repair it automatically before starting Minecraft.
  const irisConstraint = getKnownModrinthDependencyConstraint({
    parentProjectId: id,
    parentVersionNumber: candidate.version_number,
    dependencyProjectId: SODIUM_PROJECT_ID,
    minecraftVersion: instance.minecraftVersion
  });
  if (irisConstraint) {
    const installedSodium = findInstalledModDescriptor(instance, 'sodium');
    const sodiumVersion = installedSodium?.rawVersion || installedSodium?.version || '';
    if (installedSodium && !isVersionInSeries(sodiumVersion, irisConstraint.versionSeries)) {
      conflicts.push({ projectId: SODIUM_PROJECT_ID, type: 'incompatible-version-range', filename: path.basename(installedSodium.path || 'Sodium'), autoFixable: true, reason: `${irisConstraint.reason} Версия будет автоматически заменена при установке/запуске.` });
    }
  }
  const optional = dependencies.filter(dep => dep.type === 'optional' && dep.projectId && !installedIds.has(dep.projectId));
  const installedVersions = await Promise.all(installed.map(async row => {
    try {
      const list = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(row.projectId)}/version?game_versions=${encodeURIComponent(JSON.stringify([instance.minecraftVersion]))}&loaders=${encodeURIComponent(JSON.stringify([instance.loader]))}`);
      const v = selectModrinthVersion(list, { allowUnspecifiedCompatibility: true });
      return { projectId: row.projectId, filename: row.filename, dependencies: (v?.dependencies || []).map(dep => ({ projectId: dep.project_id || '', type: dep.dependency_type || 'required' })) };
    } catch { return { projectId: row.projectId, filename: row.filename, dependencies: [] }; }
  }));
  for (const row of installedVersions) if (row.dependencies.some(dep => dep.type === 'incompatible' && dep.projectId === id)) conflicts.push({ projectId: row.projectId, type: 'incompatible', filename: row.filename });
  return {
    projectId: id, version: candidate.version_number, gameVersion: instance.minecraftVersion, loader: instance.loader,
    compatible: (candidate.game_versions || []).includes(instance.minecraftVersion) && (!candidate.loaders?.length || candidate.loaders.includes(instance.loader)),
    conflicts, missingRequired, optional, dependencies,
    installedMods: installed.map(row => ({ projectId: row.projectId, filename: row.filename }))
  };
}

async function getModpackContents({ projectId = '', versionId = '' } = {}) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('Не указан идентификатор сборки.');
  let version;
  if (versionId) version = await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(versionId)}`);
  else {
    const versions = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(id)}/version`);
    version = versions.find(v => v.version_type === 'release') || versions[0];
  }
  if (!version?.files?.length) throw new Error(`У сборки ${id} не найден опубликованный файл для версии ${version?.version_number || version?.id || 'неизвестна'}.`);
  const file = version.files.find(item => item.primary && /\.(mrpack|zip)$/i.test(item.filename || '')) || version.files.find(item => /\.(mrpack|zip)$/i.test(item.filename || '')) || version.files[0];
  if (!file?.url) throw new Error(`У версии сборки ${version?.version_number || version?.id || 'неизвестна'} отсутствует ссылка на архив.`);
  const cacheDir = path.join(CACHE_DIR, 'catalog-modpacks');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${safeFileName(id)}-${safeFileName(version.id || 'latest')}.mrpack`);
  const metaPath = `${cachePath}.json`;
  const meta = readJson(metaPath, null);
  const fresh = meta?.url === file.url && meta?.size && fs.existsSync(cachePath) && (Date.now() - Number(meta.savedAt || 0) < 30 * 60 * 1000);
  if (!fresh) {
    await downloadToFile(file.url, cachePath, file.hashes?.sha1 || null, () => {});
    if (!isZipFile(cachePath)) { fs.rmSync(cachePath,{force:true}); throw new Error(`Modrinth вернул не архив для версии ${version?.version_number || version?.id || 'неизвестна'}.`); }
    writeJson(metaPath, { url: file.url, size: fs.statSync(cachePath).size, savedAt: Date.now(), versionId: version.id });
  }
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(cachePath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Архив сборки не содержит modrinth.index.json.');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  const rows = [];
  for (const item of Array.isArray(index.files) ? index.files : []) {
    const relative = String(item.path || '').replace(/\\/g, '/');
    if (!/^mods\//i.test(relative)) continue;
    const filename = path.posix.basename(relative);
    if (!filename || !/\.(?:jar)$/i.test(filename)) continue;
    let projectId = '';
    for (const rawUrl of Array.isArray(item.downloads) ? item.downloads : []) {
      const match = String(rawUrl).match(/cdn\.modrinth\.com\/data\/([A-Za-z0-9_-]+)\/versions\/([A-Za-z0-9_-]+)\//i);
      if (match) { projectId = match[1]; break; }
    }
    rows.push({ filename, projectId, path: relative, downloads: item.downloads || [] });
  }
  rows.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' }));
  return { projectId: id, versionId: String(version.id || ''), versionNumber: String(version.version_number || ''), minecraftVersion: String(index.dependencies?.minecraft || ''), loader: Object.keys(index.dependencies || {}).find(key => /loader|forge|neoforge/i.test(key)) || 'vanilla', name: String(index.name || ''), mods: rows };
}

async function installModrinthProject(options = {}) {
  const dependencyContext = { installed: [] };
  const result = await installModrinthProjectInternal(options, { dependencyStack: [], pinnedVersionId: String(options.versionId || ''), dependencyContext });
  const seen = new Set();
  const dependenciesInstalled = dependencyContext.installed.filter(item => {
    const key = `${item.projectId}:${item.versionId}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  return { ...result, dependenciesInstalled };
}

async function installModrinthProjectInternal({ projectId, instanceId, projectType = 'mod', allowUninstalledVersion = false, targetWorld = '' }, internal = {}) {
  projectId = String(projectId || '').trim();
  projectType = normalizeModrinthProjectType(projectType);
  const dependencyStack = Array.isArray(internal.dependencyStack) ? internal.dependencyStack : [];
  const pinnedVersionId = String(internal.pinnedVersionId || '');
  const dependencyContext = internal.dependencyContext && typeof internal.dependencyContext === 'object' ? internal.dependencyContext : null;
  if (!projectId && !pinnedVersionId) throw new Error('Modrinth: не указан идентификатор проекта.');
  if (projectType === 'modpack') {
    const versions = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(projectId)}/version`);
    if (!versions.length) throw new Error('У проекта пока нет опубликованных версий.');
    const file = versions[0].files.find(f => f.primary) || versions[0].files[0];
    if (!file || !file.url) throw new Error('В сборке нет доступного файла.');
    const packPath = path.join(CACHE_DIR, 'modpacks', `${safeFileName(file.filename || versions[0].name)}.mrpack`);
    progress('modpack', 3, 'Загрузка сборки Modrinth');
    await downloadToFile(file.url, packPath, file.hashes?.sha1 || null, p => progress('modpack', p * 0.4, 'Загрузка .mrpack'));
    return installMrpack(packPath);
  }

  let instance = getInstance(instanceId);
  if (!instance) throw new Error('Сначала создай или выбери сборку.');
  const canonicalHint = projectId || pinnedVersionId;
  if (dependencyStack.includes(canonicalHint)) {
    log(`Пропущен циклический граф зависимостей Modrinth: ${[...dependencyStack, canonicalHint].join(' → ')}`, 'warn');
    return { ok: true, skipped: true, reason: 'dependency-cycle', projectId: canonicalHint };
  }

  // A pinned dependency must use the exact version declared by the parent mod.
  const version = pinnedVersionId
    ? await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(pinnedVersionId)}`)
    : await getModrinthVersion(projectId, instance, projectType);
  const resolvedProjectId = String(version.project_id || projectId);
  if (pinnedVersionId && projectId && resolvedProjectId !== projectId) throw new Error(`Указанная версия ${pinnedVersionId} принадлежит проекту ${resolvedProjectId}, а не ${projectId}.`);
  if (!projectId) projectId = resolvedProjectId;
  if (!Array.isArray(version.files) || !version.files.length) throw new Error(`У версии зависимости ${resolvedProjectId} нет файлов для загрузки.`);

  // Unlike a raw JAR copy, Modrinth project installs also resolve all required dependencies.
  // This is important for legacy Forge packs where a mod can start loading before a missing
  // core library produces a NoClassDefFoundError.
  if (projectType === 'mod') {
    const stackForChildren = [...dependencyStack, canonicalHint];
    for (const dependency of getRequiredModrinthDependencies(version)) {
      let dependencyProjectId = dependency.projectId;
      let dependencyVersionId = dependency.versionId;
      if (!dependencyProjectId && dependencyVersionId) {
        try {
          const depVersion = await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(dependencyVersionId)}`);
          dependencyProjectId = String(depVersion.project_id || '');
        } catch (error) {
          throw new Error(`Не удалось определить обязательную зависимость ${dependencyVersionId} для мода ${projectId}: ${error.message}`);
        }
      }
      if (!dependencyProjectId) continue;
      const knownConstraint = getKnownModrinthDependencyConstraint({
        parentProjectId: resolvedProjectId,
        parentVersionNumber: version.version_number,
        dependencyProjectId,
        minecraftVersion: instance.minecraftVersion
      });
      // If Modrinth pins a dependency to a release that contradicts the selected mod's
      // embedded range, prefer a release in the known compatible series instead of blindly
      // following the bad pin. Other dependencies continue to honor exact version pins.
      if (dependencyVersionId && knownConstraint) {
        try {
          const pinnedDependency = await fetchJson(`${MODRINTH_API}/version/${encodeURIComponent(dependencyVersionId)}`);
          if (!isVersionInSeries(pinnedDependency.version_number, knownConstraint.versionSeries)) {
            log(`${knownConstraint.reason} Игнорируется несовместимая закреплённая версия ${pinnedDependency.version_number}.`, 'warn');
            dependencyVersionId = '';
          }
        } catch {
          dependencyVersionId = '';
        }
      }
      // If the parent does not pin an exact dependency version, select the newest stable
      // release that supports both this Minecraft/loader and the dependency's version range.
      if (!dependencyVersionId) {
        try {
          const compatibleDependency = await getModrinthVersion(dependencyProjectId, instance, 'mod', {
            versionSeries: knownConstraint?.versionSeries || '',
            // When the parent is Iris itself, its selected version takes precedence over
            // the old Iris JAR currently on disk; don't let that stale file constrain Sodium.
            inferInstalledIrisConstraint: resolvedProjectId !== IRIS_PROJECT_ID
          });
          dependencyVersionId = String(compatibleDependency.id || '');
          if (!dependencyVersionId) throw new Error('Modrinth не вернул ID совместимой версии.');
          if (knownConstraint) log(`${knownConstraint.reason} Подобрана версия ${compatibleDependency.version_number}.`, 'info');
        } catch (error) {
          throw new Error(`Не удалось подобрать совместимую обязательную зависимость ${dependencyProjectId} для Minecraft ${instance.minecraftVersion} / ${instance.loader}: ${error.message}`);
        }
      }
      // Refresh persisted state before dependency checks. A pinned version must match exactly;
      // a different installed version of the same project is not a valid substitute.
      instance = getInstance(instanceId) || instance;
      const isAlreadyInstalled = isRequiredDependencyInstalled(instance.installedContent, { projectId: dependencyProjectId, versionId: dependencyVersionId });
      if (isAlreadyInstalled) continue;
      if (stackForChildren.includes(dependencyProjectId)) {
        log(`Пропущена циклическая зависимость ${dependencyProjectId} для ${projectId}.`, 'warn');
        continue;
      }
      try {
        const dependencyResult = await installModrinthProjectInternal({
          projectId: dependencyProjectId,
          instanceId,
          projectType: 'mod',
          allowUninstalledVersion
        }, { dependencyStack: stackForChildren, pinnedVersionId: dependencyVersionId, dependencyContext });
        if (dependencyContext && dependencyResult && !dependencyResult.skipped) {
          dependencyContext.installed.push({
            projectId: dependencyResult.projectId || dependencyProjectId,
            versionId: dependencyResult.versionId || dependencyVersionId || '',
            filename: dependencyResult.file || '',
            alreadyPresent: Boolean(dependencyResult.alreadyPresent)
          });
        }
      } catch (error) {
        throw new Error(`Не удалось установить обязательную зависимость ${dependencyProjectId} для мода ${projectId}: ${error.message}`);
      }
    }
    // Dependency installs save the instance too, so reload it before updating its content index.
    instance = getInstance(instanceId) || instance;
  }

  // Content can be downloaded before the base Minecraft version is installed. The correct
  // profile folder and required dependencies are prepared independently from the game launch.
  const file = version.files.find(f => f.primary) || version.files[0];
  if (!file || !file.url) throw new Error('Не найдена ссылка на файл.');
  let destinationDir;
  if (projectType === 'resourcepack') destinationDir = path.join(instance.root, 'resourcepacks');
  else if (projectType === 'shader') destinationDir = path.join(instance.root, 'shaderpacks');
  else if (projectType === 'datapack') {
    const worldName = String(targetWorld || '').trim();
    if (!worldName || path.basename(worldName) !== worldName || /[\\/\0]/.test(worldName)) throw new Error('Для датапака сначала выбери мир Minecraft.');
    const worldRoot = path.resolve(SHARED_SAVES_DIR, worldName);
    if (!worldRoot.startsWith(path.resolve(SHARED_SAVES_DIR) + path.sep) || !fs.existsSync(path.join(worldRoot, 'level.dat'))) throw new Error('Выбранный мир не найден в общей папке миров.');
    destinationDir = path.join(worldRoot, 'datapacks');
  } else destinationDir = path.join(instance.root, 'mods');
  fs.mkdirSync(destinationDir, { recursive: true });
  let destination = path.join(destinationDir, safeFileName(file.filename));
  // Different Modrinth projects can publish identically named files (often resourcepack.zip).
  // Never overwrite another project just because the upstream filename collides; keep both
  // visible in Minecraft and in the instance editor by adding a stable project suffix.
  if (fs.existsSync(destination)) {
    const owner = (instance.installedContent || []).find(row => row?.path && path.resolve(String(row.path)) === path.resolve(destination));
    if (!owner || String(owner.projectId || '') !== String(resolvedProjectId || '')) {
      const ext = path.extname(destination);
      const base = destination.slice(0, destination.length - ext.length);
      const suffix = safeFileName(String(resolvedProjectId || version.id || 'content')).slice(0, 12);
      let candidate = `${base}__${suffix}${ext}`;
      let counter = 2;
      while (fs.existsSync(candidate)) {
        const candidateOwner = (instance.installedContent || []).find(row => row?.path && path.resolve(String(row.path)) === path.resolve(candidate));
        if (candidateOwner && String(candidateOwner.projectId || '') === String(resolvedProjectId || '')) break;
        candidate = `${base}__${suffix}-${counter++}${ext}`;
        if (counter > 100) throw new Error('Не удалось подобрать уникальное имя файла контента.');
      }
      destination = candidate;
    }
  }
  const expectedSha1 = file.hashes?.sha1 || null;
  if (projectType === 'mod' && resolvedProjectId && version.id) {
    // Keep only one tracked version of a given mod project. Without this replacement step,
    // a newly pinned dependency could coexist with an old JAR and still crash Forge/Fabric.
    instance = getInstance(instanceId) || instance;
    const records = Array.isArray(instance.installedContent) ? instance.installedContent : [];
    const modsRoot = path.resolve(instance.root, 'mods');
    const remainingRecords = [];
    let removedOldVersion = false;
    for (const row of records) {
      const isOlderTrackedVersion = row?.projectType === 'mod' && row.projectId === resolvedProjectId && row.versionId && row.versionId !== version.id && row.path;
      if (!isOlderTrackedVersion) { remainingRecords.push(row); continue; }
      const oldPath = path.resolve(String(row.path));
      const isInsideMods = oldPath.startsWith(`${modsRoot}${path.sep}`);
      if (!isInsideMods) { remainingRecords.push(row); continue; }
      let oldFileCleared = false;
      try {
        const stat = fs.lstatSync(oldPath);
        if (!stat.isFile() || stat.isSymbolicLink()) { remainingRecords.push(row); continue; }
        fs.rmSync(oldPath, { force: true });
        oldFileCleared = true;
      } catch (error) {
        if (error?.code === 'ENOENT') oldFileCleared = true;
        else { remainingRecords.push(row); continue; }
      }
      if (!oldFileCleared) { remainingRecords.push(row); continue; }
      removedOldVersion = true;
      log(`Заменяется старая версия мода ${resolvedProjectId}: ${row.filename || path.basename(oldPath)} → ${version.version_number || version.id}`, 'info');
    }
    if (removedOldVersion) { instance.installedContent = remainingRecords; saveInstance(instance); }
  }
  let alreadyPresent = false;
  if (fs.existsSync(destination)) {
    try { alreadyPresent = !expectedSha1 || crypto.createHash('sha1').update(fs.readFileSync(destination)).digest('hex').toLowerCase() === expectedSha1.toLowerCase(); } catch {}
  }
  if (!alreadyPresent) {
    progress('content', 2, `Скачивание ${file.filename}`);
    await downloadToFile(file.url, destination, expectedSha1, p => progress('content', p, `Скачивание ${file.filename}`));
  }
  if (projectType === 'resourcepack') {
    try {
      const normalized = normalizeResourcePackArchive(destination);
      if (normalized.changed) log(`Нормализована структура ресурспака ${file.filename}: вложенная папка ${normalized.root}/ перенесена в корень архива.`, 'info');
      if (normalized.warning) log(`Ресурспак ${file.filename}: ${normalized.warning}`, 'warn');
      if (!normalized.valid) { fs.rmSync(destination, { force: true }); throw new Error(normalized.warning || 'pack.mcmeta повреждён или отсутствует.'); }
    } catch (error) {
      if (fs.existsSync(destination) && !alreadyPresent) { try { fs.rmSync(destination, { force: true }); } catch {} }
      throw new Error(`Не удалось проверить структуру ресурспака ${file.filename}: ${error.message}`);
    }
  }
  // Some old/manual installs aren't in installedContent. If Sodium is being repaired,
  // inspect the actual JAR metadata and move stale duplicate Sodium jars out of mods so
  // Fabric cannot load both 0.8.x and 0.6.x at once. Backups stay recoverable in the cache.
  if (projectType === 'mod' && resolvedProjectId === SODIUM_PROJECT_ID) backupDuplicateSodiumJars(getInstance(instanceId) || instance, destination);
  // Always merge with the latest saved instance; recursive dependencies may have added records.
  instance = getInstance(instanceId) || instance;
  const installedContent = Array.isArray(instance.installedContent) ? instance.installedContent : [];
  const record = { projectId: resolvedProjectId, projectType, versionId: version.id, versionNumber: String(version.version_number || ''), filename: file.filename, path: destination, installedAt: new Date().toISOString() };
  const index = installedContent.findIndex(x => (x.projectId === resolvedProjectId || x.versionId === version.id) && x.projectType === projectType);
  if (index >= 0) installedContent[index] = { ...installedContent[index], ...record }; else installedContent.push(record);
  instance.installedContent = installedContent;
  saveInstance(instance);
  log(`${alreadyPresent ? 'Файл уже был установлен' : 'Установлено из Modrinth'}: ${file.filename} → ${destinationDir}`);
  progress('content', 100, alreadyPresent ? 'Файл уже скачан' : 'Готово');
  return { ok: true, file: file.filename, path: destination, projectId: resolvedProjectId, versionId: version.id, projectType, alreadyPresent, compatibilityWarning: Boolean(version.satCompatibilityFallback) };
}

async function installMrpack(packPath, preferredName = '') {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(packPath);
  const indexEntry = zip.getEntry('modrinth.index.json');
  if (!indexEntry) throw new Error('Файл не похож на сборку Modrinth: отсутствует modrinth.index.json.');
  const index = JSON.parse(indexEntry.getData().toString('utf8'));
  if (index.formatVersion !== 1) throw new Error(`Не поддерживается формат сборки Modrinth: ${index.formatVersion}.`);
  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft;
  if (!mcVersion) throw new Error('В сборке не указана версия Minecraft.');
  const loaderEntry = Object.entries(deps).find(([key]) => ['fabric-loader', 'quilt-loader', 'forge', 'neoforge'].includes(key));
  let loader = 'vanilla', loaderVersion = '';
  if (loaderEntry) {
    loader = loaderEntry[0].replace('-loader', '');
    loaderVersion = String(loaderEntry[1]);
  }
  const name = preferredName || index.name || `Modrinth ${mcVersion}`;
  const instance = createInstance({ name, minecraftVersion: mcVersion, versionType: 'release', loader, loaderVersion, source: 'Modrinth', icon: '' });
  const files = index.files || [];
  let completed = 0;
  for (const item of files) {
    if (item.env && item.env.client === 'unsupported') { completed++; continue; }
    const relative = String(item.path || '').replace(/^\/+/, '');
    if (!relative || !Array.isArray(item.downloads) || !item.downloads.length) { completed++; continue; }
    const dest = toAbsoluteInside(instance.root, relative);
    let lastErr;
    for (const url of item.downloads) {
      try {
        const expected = item.hashes?.sha1 || item.hashes?.sha512 || null;
        await downloadToFile(url, dest, expected, (p, received, total) => {
          const detail = total ? `${relative} · ${formatBytes(received)} из ${formatBytes(total)}` : `${relative} · получено ${formatBytes(received)}`;
          progress('modpack', Math.min(74, Math.round((completed + (p || 0) / 100) / Math.max(files.length, 1) * 74)), detail);
        }, 15 * 60 * 1000);
        lastErr = null; break;
      } catch (e) { lastErr = e; }
    }
    if (lastErr) throw new Error(`Не удалось получить файл сборки ${relative}: ${lastErr.message}`);
    completed++;
    progress('modpack', Math.round(completed / Math.max(files.length, 1) * 75), `Файлы сборки: ${completed}/${files.length}`);
  }
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/');
    if (entry.isDirectory) continue;
    if (name.startsWith('overrides/') || name.startsWith('client-overrides/')) {
      const relative = name.replace(/^(overrides|client-overrides)\//, '');
      if (!relative) continue;
      const dest = toAbsoluteInside(instance.root, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, entry.getData());
    }
  }
  prepareResourcePacksForLaunch(instance);
  if (loader !== 'vanilla') {
    await installLoaderForInstance(instance, loader, loaderVersion);
  } else {
    instance.versionId = mcVersion;
    instance.installed = true;
    saveInstance(instance);
  }
  progress('modpack', 100, 'Сборка установлена');
  log(`Сборка Modrinth установлена: ${instance.name}`);
  return { ok: true, instance };
}

function parseMapCount(raw) {
  const normalized = String(raw || '').trim().replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  const match = normalized.match(/([0-9]+(?:\.[0-9]+)?)\s*([kкм]?)/i);
  if (!match) return null;
  const multiplier = /[kк]/i.test(match[2]) ? 1000 : /м/i.test(match[2]) ? 1000000 : 1;
  return Math.round(Number(match[1]) * multiplier);
}
function extractMapVersions(text) {
  const found = new Set();
  for (const match of String(text || '').matchAll(/(?<![\d.])1\.(?:[5-9]|1[0-9]|2[0-9])(?:\.\d{1,2})?(?![\d.])/g)) found.add(match[0]);
  return [...found].sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
}
function classifyMapGenres(text, tags = []) {
  const haystack = `${String(text || '')} ${(tags || []).join(' ')}`.toLowerCase();
  const rules = [
    ['parkour', /паркур|parkour|jump map/], ['horror', /хоррор|ужас|страшн|horror|scary/],
    ['survival', /выживан|survival|skyblock|one.?block/], ['adventure', /приключен|adventure|story|сюжет/],
    ['puzzle', /головолом| puzzle|puzzle|escape|побег/], ['city', /город|city|town|modern house|городск/],
    ['redstone', /редстоун|redstone|механизм|automation/], ['mini-game', /мини.?игр|minigame|mini.?game|bed.?wars|сражен/]
  ];
  return rules.filter(([,pattern]) => pattern.test(haystack)).map(([genre]) => genre);
}

function mapSearchCacheKey(source, query, page) {
  return `${source}|${Math.max(1, Number(page) || 1)}|${String(query || '').trim().toLocaleLowerCase()}`;
}
function getCachedMapSearch(source, query, page) {
  const key = mapSearchCacheKey(source, query, page);
  const hit = mapSearchCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.items.map(item => ({ ...item, tags: [...(item.tags || [])], versions: [...(item.versions || [])], genres: [...(item.genres || [])] }));
  if (hit) mapSearchCache.delete(key);
  return null;
}
function cacheMapSearch(source, query, page, items) {
  const key = mapSearchCacheKey(source, query, page);
  mapSearchCache.set(key, { expiresAt: Date.now() + 5 * 60 * 1000, items });
  while (mapSearchCache.size > 80) mapSearchCache.delete(mapSearchCache.keys().next().value);
}
async function prefetchMapSearch({ query = '', page = 1 } = {}) {
  const safePage = Math.max(1, Math.min(100, Number(page) || 1));
  return Promise.allSettled([
    scrapeInsideMaps({ query: String(query || '').slice(0, 120), page: safePage }),
    scrapePlanetMinecraftMaps({ query: String(query || '').slice(0, 120), page: safePage })
  ]).then(results => ({ cachedSources: results.filter(result => result.status === 'fulfilled').length }));
}

async function scrapeInsideMaps({ query = '', page = 1 } = {}) {
  const cached = getCachedMapSearch('inside', query, page); if (cached) return cached;
  const key = mapSearchCacheKey('inside', query, page);
  if (mapSearchPending.has(key)) return (await mapSearchPending.get(key)).map(item => ({ ...item, tags: [...(item.tags || [])], versions: [...(item.versions || [])], genres: [...(item.genres || [])] }));
  const pending = scrapeInsideMapsFresh({ query, page });
  mapSearchPending.set(key, pending);
  try { return await pending; } finally { if (mapSearchPending.get(key) === pending) mapSearchPending.delete(key); }
}
async function scrapeInsideMapsFresh({ query = '', page = 1 } = {}) {
  const url = new URL('/maps/', INSIDE_BASE);
  if (query) url.searchParams.set('q', query);
  if (page > 1) url.searchParams.set('page', String(page));
  const response = await fetchWithTimeout(url.toString(), { headers: { 'Accept': 'text/html,application/xhtml+xml' } }, 16000);
  if (!response.ok) throw new Error(`Minecraft Inside ответил HTTP ${response.status}.`);
  const html = await response.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const seen = new Set();
  const results = [];
  $('a[href*="/maps/"]').each((_, element) => {
    const a = $(element);
    const href = a.attr('href') || '';
    if (!/^\/maps\/\d+-[^/]+\.html(?:\?.*)?$/.test(href)) return;
    const canonical = href.split('?')[0];
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const title = (a.attr('title') || a.text() || a.find('img').attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (!title) return;
    const card = a.closest('article, .item, .post, .block, .card, li, .short-item');
    const scope = card.length ? card : a.parent().parent();
    const img = scope.find('img').first().attr('data-src') || scope.find('img').first().attr('src') || '';
    const description = (scope.find('p, .description, .text, .short-desc').first().text() || '').replace(/\s+/g, ' ').trim();
    const metaText = (scope.text() || '').replace(/\s+/g, ' ');
    const downloadMatch = metaText.match(/([\d,.]+\s*[kкм]?)\s*(?:скачиваний|загрузок|downloads|downloads?)/i);
    const ratingMatch = metaText.match(/(?:оценка|rating|рейтинг)\s*[:：]?\s*(\d(?:[.,]\d{1,2})?)(?:\s*\/\s*5)?/i);
    const tags = [];
    scope.find('[class*="tag"], [class*="version"]').each((__, item) => {
      const val = $(item).text().replace(/\s+/g, ' ').trim();
      if (val && val.length < 50 && !tags.includes(val)) tags.push(val);
    });
    const mapText = `${title} ${description} ${metaText} ${tags.join(' ')}`;
    results.push({ id: canonical.match(/\/(\d+)-/)?.[1] || canonical, title, description: description.slice(0, 260), image: img.startsWith('http') ? img : img ? new URL(img, INSIDE_BASE).toString() : '', url: new URL(canonical, INSIDE_BASE).toString(), tags, versions: extractMapVersions(mapText), genres: classifyMapGenres(mapText, tags), downloads: downloadMatch ? parseMapCount(downloadMatch[1]) : null, rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null, source: 'Minecraft Inside', mapSource: 'inside' });
  });
  const output = results.slice(0, 36);
  cacheMapSearch('inside', query, page, output);
  return output;
}

async function scrapePlanetMinecraftMaps({ query = '', page = 1 } = {}) {
  const cached = getCachedMapSearch('planet', query, page); if (cached) return cached;
  const key = mapSearchCacheKey('planet', query, page);
  if (mapSearchPending.has(key)) return (await mapSearchPending.get(key)).map(item => ({ ...item, tags: [...(item.tags || [])], versions: [...(item.versions || [])], genres: [...(item.genres || [])] }));
  const pending = scrapePlanetMinecraftMapsFresh({ query, page });
  mapSearchPending.set(key, pending);
  try { return await pending; } finally { if (mapSearchPending.get(key) === pending) mapSearchPending.delete(key); }
}
async function scrapePlanetMinecraftMapsFresh({ query = '', page = 1 } = {}) {
  const url = new URL('https://www.planetminecraft.com/projects/');
  url.searchParams.set('platform', '1');
  if (query) url.searchParams.set('keywords', String(query).slice(0, 120));
  if (page > 1) url.searchParams.set('p', String(page));
  const response = await fetchWithTimeout(url.toString(), { headers: { 'Accept': 'text/html,application/xhtml+xml' } }, 16000);
  if (!response.ok) {
    if (response.status === 403 || response.status === 429 || response.status >= 500) {
      log(`Planet Minecraft временно ограничил запросы (HTTP ${response.status}); переключаемся на Minecraft Inside.`, 'warn');
      const fallback = await scrapeInsideMaps({ query, page });
      return fallback.map(item => ({ ...item, mapSource: 'minecraftinside', source: 'Minecraft Inside', fallbackFrom: 'Planet Minecraft' }));
    }
    throw new Error(`Planet Minecraft ответил HTTP ${response.status}.`);
  }
  const html = await response.text();
  const cheerio = require('cheerio'); const $ = cheerio.load(html); const results = []; const seen = new Set();
  $('a[href*="/project/"]').each((_, element) => {
    const a = $(element); const href = a.attr('href') || '';
    let u; try { u = new URL(href, 'https://www.planetminecraft.com'); } catch { return; }
    if (!['www.planetminecraft.com','planetminecraft.com'].includes(u.hostname) || !/^\/project\/[^/]+\/?$/.test(u.pathname) || seen.has(u.pathname)) return;
    const title = (a.attr('title') || a.text() || a.find('img').attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (!title || /download minecraft map|how to install/i.test(title)) return;
    seen.add(u.pathname);
    let card = a.closest('article, .r, .project, .resource, .content, .item, li');
    if (!card.length) card = a.parent().parent().parent();
    const imageNode = card.find('img').first();
    const image = imageNode.attr('data-src') || imageNode.attr('src') || imageNode.attr('data-original') || '';
    const description = (card.find('p, .description, .desc, .summary').first().text() || '').replace(/\s+/g, ' ').trim();
    const metaText = (card.text() || '').replace(/\s+/g, ' ');
    const downloadMatch = metaText.match(/([\d,.]+\s*[kкм]?)\s*(?:downloads?|downloads?|скачиваний|загрузок)/i);
    const ratingMatch = metaText.match(/(?:rating|score|рейтинг|оценка)\s*[:：]?\s*(\d(?:[.,]\d{1,2})?)(?:\s*\/\s*5)?/i);
    const tags = [...new Set(card.find('.type, .category, [class*="tag"]').map((__, el) => $(el).text().replace(/\s+/g,' ').trim()).get().filter(Boolean))].slice(0, 4);
    const mapText = `${title} ${description} ${metaText} ${tags.join(' ')}`;
    results.push({ id: u.pathname, title, description: description.slice(0, 250), image: image ? new URL(image, u).toString() : '', url: u.toString(), tags, versions: extractMapVersions(mapText), genres: classifyMapGenres(mapText, tags), downloads: downloadMatch ? parseMapCount(downloadMatch[1]) : null, rating: ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null, source: 'Planet Minecraft', mapSource: 'planetminecraft' });
  });
  const output = results.slice(0, 25);
  cacheMapSearch('planet', query, page, output);
  return output;
}


async function installPlanetMinecraftMap({ url, instanceId } = {}) {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('Сначала создай или выбери сборку, куда установить карту.');
  const pageUrl = new URL(url);
  if (!['www.planetminecraft.com','planetminecraft.com'].includes(pageUrl.hostname) || !/^\/project\/[^/]+\/?$/.test(pageUrl.pathname)) throw new Error('Разрешены только страницы карт Planet Minecraft.');
  const lock = `map:${instance.id}`;
  if (operationLocks.has(lock)) throw new Error('Для этой сборки уже выполняется установка карты.');
  operationLocks.add(lock);
  let archivePath = '';
  try {
    progress('map', 2, 'Получаем ссылку на карту Planet Minecraft…');
    const page = await fetchWithTimeout(pageUrl.toString(), { headers: { Accept: 'text/html,application/xhtml+xml' } }, 35000);
    if (!page.ok) throw new Error(`Страница карты ответила HTTP ${page.status}.`);
    const html = await page.text();
    const cheerio = require('cheerio'); const $ = cheerio.load(html);
    const urls = new Set();
    $('a[href*="/download/"], a[href$=".zip"], a[href*=".zip?"], a[download], a[href*="download=true"], form[action*="download"]').each((_, el) => {
      const raw = $(el).attr('href') || $(el).attr('action'); if (!raw) return;
      try { const u = new URL(raw, pageUrl); if (u.protocol === 'https:' && (u.hostname.endsWith('planetminecraft.com') || /\.zip(?:$|\?)/i.test(u.pathname + u.search))) urls.add(u.toString()); } catch {}
    });
    // The site's supported Download button normally uses /download/worldmap/. Do not bypass login gates or ad challenges.
    const downloadRoute = new URL(`${pageUrl.pathname.replace(/\/$/, '')}/download/worldmap/`, pageUrl.origin).toString();
    urls.add(downloadRoute);
    const cacheDir = path.join(CACHE_DIR, 'maps'); fs.mkdirSync(cacheDir, { recursive: true });
    archivePath = path.join(cacheDir, `pm-${safeFileName(pageUrl.pathname.split('/').filter(Boolean).pop())}-${Date.now()}.zip`);
    let downloaded = false; let lastUrl = pageUrl.toString();
    for (const candidate of urls) {
      try {
        fs.rmSync(archivePath, { force: true });
        const res = await downloadMapArchive(candidate, archivePath, 'Загрузка карты Planet Minecraft', { Referer: pageUrl.toString() });
        lastUrl = res.url;
        if (isZipFile(archivePath)) { downloaded = true; break; }
        const size = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
        const body = size ? fs.readFileSync(archivePath).subarray(0, Math.min(size, 512 * 1024)).toString('utf8') : '';
        if (/<!doctype html|<html/i.test(body)) {
          const landing = cheerio.load(body);
          landing('a[href$=".zip"], a[href*=".zip?"], a[download], a[href*="download"], form[action*="download"], meta[http-equiv="refresh"]').each((__, el) => {
            const attr = landing(el).attr('href') || landing(el).attr('action') || landing(el).attr('content') || '';
            const match = attr.match(/url\s*=\s*([^;]+)/i); const raw = (match ? match[1] : attr).replace(/["']/g,'').trim();
            try { const u = new URL(raw, lastUrl); if (u.protocol === 'https:' && (u.hostname.endsWith('planetminecraft.com') || /\.(zip|7z|rar)(?:$|\?)/i.test(u.pathname + u.search))) urls.add(u.toString()); } catch {}
          });
          // A public detail page can expose the file link inside its own HTML/JS. Parse only explicit archive URLs;
          // do not execute scripts or follow CAPTCHA/ad-timer workflows.
          for (const match of body.matchAll(/https?:\/\/[^\s"'<>\\]+?\.(?:zip|7z|rar)(?:\?[^\s"'<>\\]*)?/gi)) {
            const raw = match[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
            try { const u = new URL(raw, lastUrl); if (u.protocol === 'https:') urls.add(u.toString()); } catch {}
          }
        }
      } catch (e) { log(`Вариант ссылки карты Planet Minecraft не сработал: ${e.message}`, 'debug'); }
    }
    if (!downloaded) throw new Error('Planet Minecraft не предоставил прямой ZIP-файл в ответе. Возможно, карта использует сторонний хостинг, вход или подтверждение. Лаунчер не обходит эти проверки. Скачай ZIP с сайта и воспользуйся кнопкой «Импортировать ZIP с компьютера».');
    const title = $('h1').first().text().trim() || pageUrl.pathname.split('/').filter(Boolean).pop() || 'Minecraft World';
    const installed = await installMapArchiveToInstance(instance, archivePath, title);
    recordInstalledMap(instance, pageUrl.toString(), installed);
    return { ...installed, sourceUrl: pageUrl.toString() };
  } finally { if (archivePath) fs.rmSync(archivePath, { force: true }); operationLocks.delete(lock); }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

async function downloadMapArchive(url, destination, stageLabel = 'Скачивание карты', requestHeaders = {}) {
  let lastReported = 0;
  const result = await downloadToFile(url, destination, null, (percent, received, total) => {
    const now = Date.now();
    // Emit at most 4 updates per second, including when a server omits Content-Length.
    if (now - lastReported < 250 && percent < 100) return;
    lastReported = now;
    const approximate = total ? Math.max(5, Math.min(82, 5 + Math.round(percent * .77))) : Math.min(78, 5 + Math.log2(received / 1048576 + 1) * 7);
    const detail = total
      ? `${stageLabel} · ${formatBytes(received)} из ${formatBytes(total)}`
      : `${stageLabel} · получено ${formatBytes(received)}`;
    progress('map', Math.min(82, approximate), detail);
  }, 15 * 60 * 1000, true, requestHeaders);
  return result;
}

function isZipFile(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r'); const b = Buffer.alloc(4);
    const n = fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
    return n === 4 && b.readUInt32LE(0) === 0x04034b50;
  } catch { return false; }
}
async function installMapArchiveToInstance(instance, archivePath, desiredName = 'Minecraft world') {
  if (!instance) throw new Error('Сначала создай или выбери сборку, куда установить карту.');
  progress('map', 84, 'Проверка архива и поиск мира…');
  if (!isZipFile(archivePath)) throw new Error('Выбранный файл не является ZIP-архивом карты. Скачай или распакуй архив мира и попробуй снова.');
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archivePath);
  const entries = zip.getEntries().filter(entry => !entry.isDirectory);
  if (!entries.length) throw new Error('Архив карты пустой.');
  const roots = detectWorldArchiveRoot(entries.map(entry => entry.entryName));
  // Root-level level.dat is valid; do not mistake it for a wrapper directory.
  if (!roots.levelPath) log('В архиве нет level.dat в стандартном пути; пробуем найти вложенную папку мира.', 'debug');
  const mapName = safeFileName(desiredName || path.basename(archivePath, path.extname(archivePath)) || 'Minecraft World');
  // Ensure the game directory is linked to the common world library, then install directly
  // into its canonical path so the map record is identical for every profile.
  ensureSharedSavesDirectory(instance);
  const savesDir = SHARED_SAVES_DIR;
  let uniqueName = mapName, suffix = 2;
  while (fs.existsSync(path.join(savesDir, uniqueName))) uniqueName = `${mapName} (${suffix++})`;
  const worldDir = path.join(savesDir, uniqueName);
  fs.mkdirSync(savesDir, { recursive: true }); fs.mkdirSync(worldDir, { recursive: true });
  let extracted = 0;
  for (const entry of entries) {
    const relative = getWorldRelativePath(entry.entryName, roots);
    if (!relative) continue;
    const dest = toAbsoluteInside(worldDir, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, entry.getData());
    extracted++;
    if (extracted % 30 === 0) progress('map', Math.min(98, 84 + Math.round(extracted / Math.max(entries.length, 1) * 14)), `Распаковано файлов: ${extracted}/${entries.length}`);
  }
  if (!extracted) { try { fs.rmSync(worldDir, { recursive: true, force: true }); } catch {} throw new Error('В архиве не удалось найти файлы мира.'); }
  if (!fs.existsSync(path.join(worldDir, 'level.dat')) && !fs.existsSync(path.join(worldDir, 'level.dat_old'))) {
    const possible = fs.readdirSync(worldDir, { withFileTypes: true }).filter(d => d.isDirectory());
    const nestedWorld = possible.find(d => fs.existsSync(path.join(worldDir, d.name, 'level.dat')) || fs.existsSync(path.join(worldDir, d.name, 'level.dat_old')));
    if (nestedWorld) {
      const nestedDir = path.join(worldDir, nestedWorld.name);
      for (const name of fs.readdirSync(nestedDir)) fs.renameSync(path.join(nestedDir, name), path.join(worldDir, name));
      fs.rmSync(nestedDir, { recursive: true, force: true });
    }
  }
  const hasLevelDat = fs.existsSync(path.join(worldDir, 'level.dat')) || fs.existsSync(path.join(worldDir, 'level.dat_old'));
  if (!hasLevelDat) {
    try { fs.rmSync(worldDir, { recursive: true, force: true }); } catch {}
    throw new Error('ZIP открылся, но внутри нет level.dat — это не готовый мир Java Edition (возможно, архив содержит Bedrock-пакет или установщик).');
  }
  log(`Карта «${uniqueName}» установлена в ${worldDir}. Файлов: ${extracted}`);
  progress('map', 100, 'Мир установлен — его можно открыть в одиночной игре');
  return { ok: true, mapName: uniqueName, path: worldDir, files: extracted, hasLevelDat: true };
}

function extractMapDownloadCandidates(html, baseUrl) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const found = new Map();
  const add = (raw, label = '') => {
    if (!raw || typeof raw !== 'string') return;
    let candidate = raw.trim().replace(/^['"]|['"]$/g, '').replace(/\\\//g, '/').replace(/&amp;/g, '&');
    const refresh = candidate.match(/url\s*=\s*([^;]+)/i);
    if (refresh) candidate = refresh[1].replace(/["']/g, '').trim();
    if (/^(javascript:|mailto:|data:|#)/i.test(candidate)) return;
    try {
      const u = new URL(candidate, baseUrl);
      if (u.protocol !== 'https:' || u.toString() === baseUrl) return;
      const pathAndQuery = `${u.pathname}${u.search}`;
      const text = `${pathAndQuery} ${label}`.toLowerCase();
      const likely = /download|\.zip(?:$|[?&])|\.7z(?:$|[?&])|\.rar(?:$|[?&])|mediafire|mega\.nz|drive\.google|file\.io|dropbox|redirect|скачать/.test(text);
      if (!likely) return;
      const score = /\.zip(?:$|[?&])/.test(text) ? 0 : /download/.test(text) ? 1 : 2;
      const old = found.get(u.toString());
      if (!old || score < old.score) found.set(u.toString(), { url: u.toString(), score, label });
    } catch {}
  };
  $('a[href], area[href]').each((_, el) => add($(el).attr('href'), `${$(el).text()} ${$(el).attr('title') || ''} ${$(el).attr('download') || ''}`));
  $('form[action]').each((_, el) => add($(el).attr('action'), `${$(el).text()} ${$(el).attr('id') || ''} ${$(el).attr('class') || ''}`));
  $('[data-url], [data-href], [data-download], [data-download-url]').each((_, el) => {
    for (const key of ['data-download-url','data-download','data-href','data-url']) add($(el).attr(key), `${$(el).text()} ${$(el).attr('class') || ''}`);
  });
  $('[onclick]').each((_, el) => {
    const code = $(el).attr('onclick') || '';
    for (const match of code.matchAll(/(?:location(?:\.href)?\s*=|open\s*\()\s*['"]([^'"]+)['"]/gi)) add(match[1], `${$(el).text()} ${code}`);
    for (const match of code.matchAll(/['"]([^'"]*(?:download|\.zip|\.7z|\.rar)[^'"]*)['"]/gi)) add(match[1], `${$(el).text()} ${code}`);
  });
  $('meta[http-equiv="refresh"]').each((_, el) => add($(el).attr('content'), 'meta refresh download'));
  for (const script of $('script').toArray()) {
    const body = $(script).html() || '';
    for (const match of body.matchAll(/(?:https?:)?\/\/[^\s"'<>\\]+?\.(?:zip|7z|rar)(?:\?[^\s"'<>\\]*)?|['"](\/[^'"\s<>]*(?:download|file)[^'"\s<>]*)['"]/gi)) add(match[1] || match[0], body.slice(Math.max(0, match.index - 30), match.index + 100));
    for (const match of body.matchAll(/(?:window\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]/gi)) add(match[1], 'script redirect download');
  }
  return [...found.values()].sort((a,b) => a.score - b.score).map(x => x.url).slice(0, 24);
}

async function downloadInsideMapArchive(pageUrl, pageHtml, archivePath, version = '', cookieLines = []) {
  const queue = [];
  const visited = new Set();
  const push = (url, referer) => {
    if (!url || visited.has(url) || queue.some(item => item.url === url)) return;
    try { if (new URL(url).protocol !== 'https:') return; } catch { return; }
    queue.push({ url, referer });
  };
  const cheerio = require('cheerio');
  const $ = cheerio.load(pageHtml);
  const labelled = [];
  $('a[href], form[action]').each((_, el) => {
    const href = $(el).attr('href') || $(el).attr('action') || '';
    const label = `${$(el).text()} ${$(el).attr('title') || ''} ${$(el).attr('class') || ''}`.replace(/\s+/g, ' ');
    if (/download|скачать|\.zip|\.rar|\.7z/i.test(`${href} ${label}`)) { try { labelled.push({ href: new URL(href, pageUrl).toString(), label }); } catch {} }
  });
  if (version) {
    const safeVersion = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = labelled.find(item => new RegExp(`(?:для|minecraft)?\\s*${safeVersion}(?:\\s|$|\\])`, 'i').test(item.label));
    if (match) push(match.href, pageUrl.toString());
  }
  for (const url of extractMapDownloadCandidates(pageHtml, pageUrl.toString())) push(url, pageUrl.toString());
  let hops = 0;
  while (queue.length && hops < 8) {
    const current = queue.shift();
    if (visited.has(current.url)) continue;
    visited.add(current.url); hops++;
    try {
      fs.rmSync(archivePath, { force: true });
      const requestHeaders = { Referer: current.referer || pageUrl.toString() };
      // Never forward Minecraft Inside cookies to another domain.
      if (new URL(current.url).hostname === 'minecraft-inside.ru' && cookieLines.length) requestHeaders.Cookie = cookieLines.join('; ');
      const fileResponse = await downloadMapArchive(current.url, archivePath, 'Скачивание карты', requestHeaders);
      if (isZipFile(archivePath)) return { response: fileResponse, hops };
      const size = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0;
      if (!size) continue;
      const body = fs.readFileSync(archivePath).subarray(0, Math.min(size, 1024 * 1024)).toString('utf8');
      if (!/<!doctype html|<html|<form|location\.href|download/i.test(body)) continue;
      if (/captcha|cf-challenge|verify you are human|проверка безопасности/i.test(body)) {
        log(`Источник карты требует штатного подтверждения (${new URL(current.url).hostname}); автоматическая загрузка остановлена.`, 'warn');
        continue;
      }
      for (const url of extractMapDownloadCandidates(body, fileResponse.url)) push(url, fileResponse.url);
    } catch (error) {
      log(`Ссылка карты не сработала (${current.url}): ${error.message}`, 'debug');
    }
  }
  return null;
}

async function installInsideMap({ url, instanceId, version = '' }) {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('Выбери или создай сборку, в которую нужно установить карту.');
  const pageUrl = new URL(url);
  if (pageUrl.hostname !== 'minecraft-inside.ru' || !pageUrl.pathname.startsWith('/maps/')) throw new Error('Разрешены только страницы карт Minecraft Inside.');
  const lock = `map:${instance.id}`;
  if (operationLocks.has(lock)) throw new Error('Для этой сборки уже выполняется установка карты.');
  operationLocks.add(lock);
  let archivePath = '';
  try {
    progress('map', 2, 'Подключение к Minecraft Inside…');
    const response = await fetchWithTimeout(pageUrl.toString(), { headers: { 'Accept': 'text/html,application/xhtml+xml' } }, 35000);
    if (!response.ok) throw new Error(`Страница карты ответила HTTP ${response.status}.`);
    const html = await response.text();
    const cheerio = require('cheerio'); const $ = cheerio.load(html);
    fs.mkdirSync(path.join(CACHE_DIR, 'maps'), { recursive: true });
    archivePath = path.join(CACHE_DIR, 'maps', `map-${safeFileName(pageUrl.pathname.split('/').pop())}-${Date.now()}.zip`);
    progress('map', 5, `Загрузка карты${version ? ` для Minecraft ${version}` : ''}…`);
    const cookieSetter = response.headers.getSetCookie ? response.headers.getSetCookie() : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    // Only origin cookies are kept for the map publisher; third-party file hosts never receive them.
    const cookieLines = cookieSetter.map(x => x.split(';')[0]).filter(Boolean);
    const resolved = await downloadInsideMapArchive(pageUrl, html, archivePath, version, cookieLines);
    if (!resolved || !isZipFile(archivePath)) {
      throw new Error('Не удалось получить ZIP напрямую из ссылок карты. Если сайт требует нажатия кнопки или подтверждения, лаунчер не обходит эту защиту. Открой встроенное окно загрузки или используй «Импортировать ZIP с компьютера».');
    }
    const mapName = safeFileName($('h1').first().text().trim() || pageUrl.pathname.split('/').pop().replace(/\.html.*/, '') || 'Minecraft World');
    const installed = await installMapArchiveToInstance(instance, archivePath, mapName);
    recordInstalledMap(instance, pageUrl.toString(), installed);
    return { ...installed, sourceUrl: pageUrl.toString() };
  } finally {
    if (archivePath) { try { fs.rmSync(archivePath, { force: true }); } catch {} }
    operationLocks.delete(lock);
  }
}

const mapDownloadContexts = new Map();
let mapDownloadListenerReady = false;
function ensureMapDownloadListener() {
  if (mapDownloadListenerReady) return;
  mapDownloadListenerReady = true;
  const mapSession = session.fromPartition('persist:sat-map-download');
  mapSession.on('will-download', (event, item, contents) => {
    const ctx = contents ? mapDownloadContexts.get(contents.id) : null;
    if (!ctx) return;
    ensureDirectories();
    const suggested = safeFileName(item.getFilename() || 'minecraft-map.zip');
    const destination = path.join(CACHE_DIR, 'maps', `${Date.now()}-${suggested}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    item.setSavePath(destination);
    ctx.downloadStarted = true;
    log(`Загрузка карты из встроенного окна: ${suggested}`);
    item.on('updated', (_event, state) => {
      if (state === 'progressing') {
        const total = Number(item.getTotalBytes()) || 0;
        const received = Number(item.getReceivedBytes()) || 0;
        progress('map', total ? Math.min(78, Math.round(received / total * 78)) : 25,
          total ? `Получение архива · ${formatBytes(received)} из ${formatBytes(total)}` : `Получение архива · ${formatBytes(received)}`);
      }
    });
    item.once('done', async (_event, state) => {
      try {
        if (state !== 'completed') throw new Error(`Скачивание отменено или прервано (${state}).`);
        if (!isZipFile(destination)) throw new Error('Сайт скачал страницу или неподдерживаемый архив вместо ZIP-карты. Проверь, что на сайте выбран настоящий файл карты.');
        const instance = getInstance(ctx.instanceId);
        if (!instance) throw new Error('Сборка, для которой скачивалась карта, больше не существует.');
        const result = await installMapArchiveToInstance(instance, destination, path.basename(suggested, path.extname(suggested)));
        recordInstalledMap(instance, ctx.sourceUrl, result);
        emit('launcher:mapBrowserDownloadComplete', { ok: true, instanceId: instance.id, sourceUrl: ctx.sourceUrl, mapName: result.mapName, path: result.path });
      } catch (error) {
        log(`Не удалось установить карту из встроенного окна: ${error.message}`, 'warn');
        emit('launcher:mapBrowserDownloadComplete', { ok: false, instanceId: ctx.instanceId, error: error.message });
      } finally {
        try { fs.rmSync(destination, { force: true }); } catch {}
        operationLocks.delete(`map:${ctx.instanceId}`);
        mapDownloadContexts.delete(contents.id);
        if (ctx.window && !ctx.window.isDestroyed()) ctx.window.close();
      }
    });
  });
}

async function openMapDownloadWindow({ url, instanceId, source = 'inside' } = {}) {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('Сначала создай или выбери сборку, куда установить карту.');
  const pageUrl = new URL(String(url || ''));
  const allowed = source === 'planetminecraft'
    ? ['www.planetminecraft.com', 'planetminecraft.com'].includes(pageUrl.hostname) && /^\/project\/[^/]+\/?$/.test(pageUrl.pathname)
    : pageUrl.hostname === 'minecraft-inside.ru' && pageUrl.pathname.startsWith('/maps/');
  if (pageUrl.protocol !== 'https:' || !allowed) throw new Error('Открывать встроенное скачивание можно только со страницы карты Minecraft Inside или Planet Minecraft.');
  const lock = `map:${instance.id}`;
  if (operationLocks.has(lock)) throw new Error('Для этой сборки уже выполняется установка карты.');
  operationLocks.add(lock);
  ensureMapDownloadListener();
  const win = new BrowserWindow({
    parent: mainWindow || undefined, width: 1040, height: 760, minWidth: 760, minHeight: 560,
    title: 'Скачать карту · SAT LAUNCHER', autoHideMenuBar: true, icon: path.join(__dirname, 'src', 'assets', 'icons', 'sat-app.ico'),
    webPreferences: { partition: 'persist:sat-map-download', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  const webContentsId = win.webContents.id;
  const ctx = { instanceId: instance.id, source, sourceUrl: pageUrl.toString(), window: win, downloadStarted: false };
  mapDownloadContexts.set(webContentsId, ctx);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      if (new URL(target).protocol === 'https:') { win.loadURL(target).catch(() => {}); return { action: 'deny' }; }
    } catch {}
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    try { if (new URL(target).protocol !== 'https:') event.preventDefault(); } catch { event.preventDefault(); }
  });
  win.on('closed', () => {
    mapDownloadContexts.delete(webContentsId);
    if (!ctx.downloadStarted) {
      operationLocks.delete(lock);
      emit('launcher:mapBrowserDownloadComplete', { ok: false, cancelled: true, instanceId: instance.id, error: 'Окно скачивания закрыто до загрузки файла.' });
    }
  });
  try { await win.loadURL(pageUrl.toString()); win.show(); }
  catch (error) { operationLocks.delete(lock); mapDownloadContexts.delete(webContentsId); if (!win.isDestroyed()) win.close(); throw error; }
  log(`Открыто встроенное окно загрузки карты (${source}) для сборки ${instance.name}.`);
  return { opened: true, instanceId: instance.id };
}

async function importMapArchive({ instanceId } = {}) {
  const instance = getInstance(instanceId);
  if (!instance) throw new Error('Сначала создай или выбери сборку для карты.');
  const lock = `map:${instance.id}`;
  if (operationLocks.has(lock)) throw new Error('Для этой сборки уже выполняется установка карты.');
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Архив карты Minecraft', extensions: ['zip'] }],
    title: 'Выбери ZIP-архив мира Minecraft'
  });
  if (result.canceled || !result.filePaths[0]) return { cancelled: true };
  const archivePath = result.filePaths[0];
  operationLocks.add(lock);
  try { return await installMapArchiveToInstance(instance, archivePath, path.basename(archivePath, path.extname(archivePath))); }
  finally { operationLocks.delete(lock); }
}

async function getMinecraftUiTextures() {
  if (assetLoadResult) return { ...assetLoadResult, cached: true };
  const allCached = MINECRAFT_UI_TEXTURES.every(rel => textureDataUrlCache.has(rel));
  if (allCached) { assetLoadResult = { textures: Object.fromEntries(textureDataUrlCache), count: textureDataUrlCache.size, cached: true }; return assetLoadResult; }
  if (assetLoadPromise) return assetLoadPromise;
  assetLoadPromise = (async () => {
    ensureDirectories();
    const AdmZip = require('adm-zip');
    const files = MINECRAFT_UI_TEXTURES.map(rel => ({ rel, disk: path.join(MINECRAFT_ASSETS_DIR, ...rel.split('/')) }));
    const isPng = file => { try { const b = fs.readFileSync(file); return b.length > 8 && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); } catch { return false; } };
    for (const item of files) if (!isPng(item.disk)) fs.rmSync(item.disk, { force: true });
    const missing = files.filter(item => !isPng(item.disk));
    const sourceMetaPath = path.join(MINECRAFT_ASSETS_DIR, 'source.json');
    const requestedPaths = files.map(item => item.rel);
    if (missing.length) {
      const existingMeta = readJson(sourceMetaPath, null);
      const lastAttempt = Date.parse(existingMeta?.attemptedAt || '');
      const retryCooldown = existingMeta?.networkError && Number.isFinite(lastAttempt) && Date.now() - lastAttempt < 3 * 60 * 1000;
      const sameSet = existingMeta?.cacheSchema === TEXTURE_CACHE_SCHEMA && Array.isArray(existingMeta.requestedPaths) && requestedPaths.length === existingMeta.requestedPaths.length && requestedPaths.every(p => existingMeta.requestedPaths.includes(p));
      const knownMissing = new Set(sameSet && Array.isArray(existingMeta.permanentMissing) ? existingMeta.permanentMissing : []);
      const allMissingKnown = missing.length > 0 && missing.every(item => knownMissing.has(item.rel));
      if (!retryCooldown && !allMissingKnown) {
        try {
          progress('assets', 2, 'Подключаем официальный клиент Minecraft…');
          const manifest = await fetchJson(MOJANG_MANIFEST, {}, 25000);
          const latestId = manifest.latest?.release;
          const versionEntry = manifest.versions.find(v => v.id === latestId);
          if (!versionEntry?.url) throw new Error('В официальном манифесте Mojang не найдена текущая стабильная версия.');
          const versionInfo = await fetchJson(versionEntry.url, {}, 25000);
          const client = versionInfo.downloads?.client;
          if (!client?.url || !client?.sha1) throw new Error(`Для Minecraft ${latestId} не найден клиентский JAR с контрольной суммой.`);
          const jarDir = path.join(CACHE_DIR, 'official-client-jars');
          const jarPath = path.join(jarDir, `${safeFileName(latestId)}-${client.sha1}.jar`);
          fs.mkdirSync(jarDir, { recursive: true });
          const jarMetaPath = `${jarPath}.json`;
          const jarMeta = readJson(jarMetaPath, null);
          const cachedJarValid = () => {
            try {
              const stat = fs.statSync(jarPath);
              if (!isZipFile(jarPath) || stat.size < 1024 * 1024) return false;
              if (jarMeta?.sha1 === client.sha1 && jarMeta?.size === stat.size) return true;
              const valid = crypto.createHash('sha1').update(fs.readFileSync(jarPath)).digest('hex').toLowerCase() === client.sha1.toLowerCase();
              if (valid) writeJson(jarMetaPath, { sha1: client.sha1, size: stat.size, verifiedAt: new Date().toISOString() });
              return valid;
            } catch { return false; }
          };
          if (!cachedJarValid()) {
            fs.rmSync(jarPath, { force: true });
            const downloadedJar = await downloadToFile(client.url, jarPath, client.sha1, (pct, received, total) => {
              progress('assets', Math.max(4, Math.round(4 + (pct || 0) * 0.3)), `Официальный клиент ${latestId} · ${formatBytes(received)}${total ? ` из ${formatBytes(total)}` : ''}`);
            }, 15 * 60 * 1000);
            writeJson(jarMetaPath, { sha1: client.sha1, size: downloadedJar.size, verifiedAt: new Date().toISOString() });
          }
          const zip = new AdmZip(jarPath);
          // Some icon names changed between game versions. Resolve aliases against the real JAR.
          const aliases = {
            'textures/item/compass_16.png': ['assets/minecraft/textures/item/compass_16.png','assets/minecraft/textures/item/compass_00.png','assets/minecraft/textures/item/compass.png'],
            'textures/item/clock_00.png': ['assets/minecraft/textures/item/clock_00.png','assets/minecraft/textures/item/clock_00.png'],
            'textures/entity/player/wide/steve.png': ['assets/minecraft/textures/entity/player/wide/steve.png','assets/minecraft/textures/entity/steve.png'],
            'textures/entity/player/slim/alex.png': ['assets/minecraft/textures/entity/player/slim/alex.png','assets/minecraft/textures/entity/alex.png']
          };
          const allEntries = new Set(zip.getEntries().map(entry => entry.entryName.replace(/\\/g, '/')));
          const unresolved = [];
          let done = 0;
          for (const item of missing) {
            const options = aliases[item.rel] || [`assets/minecraft/${item.rel}`];
            let candidate = options.find(name => allEntries.has(name));
            if (!candidate) {
              const basename = path.posix.basename(item.rel);
              const likely = [...allEntries].filter(name => name.startsWith('assets/minecraft/textures/') && name.endsWith(`/${basename}`));
              const rank = name => name.includes('/textures/block/') ? 0 : name.includes('/textures/item/') ? 1 : name.includes('/textures/entity/') ? 2 : name.includes('/textures/gui/') ? 3 : 9;
              likely.sort((a,b) => rank(a)-rank(b) || a.length-b.length);
              candidate = likely[0] || null;
              if (candidate) log(`Текстура ${item.rel} найдена в актуальном пути ${candidate}`, 'debug');
            }
            if (!candidate) { unresolved.push(item.rel); continue; }
            try {
              const entry = zip.getEntry(candidate);
              const bytes = entry?.getData();
              if (!bytes || bytes.length < 9 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { unresolved.push(item.rel); continue; }
              fs.mkdirSync(path.dirname(item.disk), { recursive: true });
              const temp = `${item.disk}.tmp-${process.pid}`;
              fs.writeFileSync(temp, bytes); fs.renameSync(temp, item.disk);
              done++;
            } catch (err) { log(`Не удалось извлечь оригинальную текстуру ${item.rel}: ${err.message}`, 'warn'); unresolved.push(item.rel); }
          }
          writeJson(sourceMetaPath, {
            cacheSchema: TEXTURE_CACHE_SCHEMA, source: 'Официальный клиентский JAR Mojang', version: latestId,
            clientSha1: client.sha1, jarPath, attemptedAt: new Date().toISOString(), requestedPaths,
            paths: files.filter(item => isPng(item.disk)).map(item => item.rel), permanentMissing: unresolved, networkError: false,
            note: 'Готовые PNG повторно не загружаются. Клиентский JAR кэшируется и используется для извлечения недостающих текстур.'
          });
          log(`Оригинальные текстуры Minecraft: ${files.filter(item => isPng(item.disk)).length}/${files.length}; извлечено сейчас ${done}, нет в JAR: ${unresolved.length}.`);
          if (unresolved.length) log(`Некоторые текстуры отсутствуют в этой версии клиента: ${unresolved.join(', ')}`, 'warn');
          progress('assets', 100, `Оригинальные текстуры готовы · ${files.filter(item => isPng(item.disk)).length}/${files.length}`);
        } catch (error) {
          log(`Не удалось подготовить официальные текстуры Minecraft: ${error.message}`, 'warn');
          try { writeJson(sourceMetaPath, { cacheSchema: TEXTURE_CACHE_SCHEMA, source: 'Официальный клиентский JAR Mojang', attemptedAt: new Date().toISOString(), requestedPaths, paths: files.filter(item => isPng(item.disk)).map(item => item.rel), networkError: true, error: error.message }); } catch {}
          progress('assets', 100, 'Текстуры пока недоступны — лаунчер продолжит работу');
        }
      }
    }
    for (const item of files) {
      if (!textureDataUrlCache.has(item.rel) && isPng(item.disk)) {
        try { textureDataUrlCache.set(item.rel, `data:image/png;base64,${fs.readFileSync(item.disk).toString('base64')}`); } catch {}
      }
    }
    assetLoadResult = { textures: Object.fromEntries(textureDataUrlCache), count: textureDataUrlCache.size, directory: MINECRAFT_ASSETS_DIR, cached: missing.length === 0 };
    return assetLoadResult;
  })();
  try { return await assetLoadPromise; } finally { assetLoadPromise = null; }
}

// Yandex Music API is undocumented. The OAuth client ID below is used by community
// clients; this is best-effort integration, not an official Yandex Music SDK.
const YANDEX_MUSIC_COMMUNITY_CLIENT_ID = '23cabbbdc6cd418abb4b39c32c41195d';
function readYandexMusicToken() {
  if (!fs.existsSync(YANDEX_MUSIC_TOKEN_FILE) || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(fs.readFileSync(YANDEX_MUSIC_TOKEN_FILE, 'utf8'), 'base64')); }
  catch { return ''; }
}
function writeYandexMusicToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно — вход нельзя безопасно сохранить.');
  ensureDirectories();
  const encoded = safeStorage.encryptString(String(token)).toString('base64');
  fs.writeFileSync(YANDEX_MUSIC_TOKEN_FILE, encoded, { encoding: 'utf8', mode: 0o600 });
}
function clearYandexMusicToken() {
  try { fs.rmSync(YANDEX_MUSIC_TOKEN_FILE, { force: true }); } catch {}
}
async function yandexMusicRequest(apiPath, token = readYandexMusicToken(), options = {}) {
  if (!token) throw new Error('Сначала подключи аккаунт Яндекс Музыки.');
  const url = /^https:\/\//i.test(apiPath) ? apiPath : `https://api.music.yandex.net/${String(apiPath).replace(/^\/+/, '')}`;
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Authorization: `OAuth ${token}`,
      Accept: 'application/json',
      'X-Yandex-Music-Client': 'YandexMusicDesktopAppWindows/5.95.0',
      ...(options.headers || {})
    }
  }, 20000);
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload?.error) {
    const reason = payload?.error?.message || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Яндекс Музыка: ${reason}`);
  }
  return payload?.result ?? payload;
}
async function yandexMusicAccountStatus(token = readYandexMusicToken()) {
  const result = await yandexMusicRequest('account/status', token);
  const account = result?.account || result?.user || {};
  return { connected: true, username: String(account.login || account.displayName || account.uid || 'Яндекс ID'), uid: String(account.uid || '') };
}
async function loginYandexMusic() {
  if (yandexMusicAuthWindow && !yandexMusicAuthWindow.isDestroyed()) {
    yandexMusicAuthWindow.focus();
    return new Promise(resolve => yandexMusicAuthWindow.once('closed', () => resolve({ connected: false, cancelled: true })));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      const authWindow = yandexMusicAuthWindow;
      yandexMusicAuthWindow = null;
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      if (error) reject(error); else resolve(result);
    };
    const authWindow = new BrowserWindow({
      parent: mainWindow || undefined, width: 480, height: 720, minWidth: 420, minHeight: 600,
      title: 'Вход в Яндекс Музыку · SAT LAUNCHER', autoHideMenuBar: true, backgroundColor: '#171208',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: 'persist:sat-yandex-music-login' }
    });
    yandexMusicAuthWindow = authWindow;
    const authUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YANDEX_MUSIC_COMMUNITY_CLIENT_ID}`;
    const capture = async rawUrl => {
      if (settled) return false;
      let token = '';
      try {
        const parsed = new URL(String(rawUrl));
        const params = new URLSearchParams(parsed.hash.replace(/^#/, ''));
        token = params.get('access_token') || '';
      } catch {}
      if (!token) return false;
      try {
        const status = await yandexMusicAccountStatus(token);
        writeYandexMusicToken(token);
        log(`Подключён аккаунт Яндекс Музыки: ${status.username}`);
        finish(null, status);
      } catch (error) {
        log(`Не удалось подтвердить токен Яндекс Музыки: ${error.message}`, 'warn');
        finish(new Error(`Не удалось подтвердить вход Яндекса. Попробуй ещё раз. ${error.message}`));
      }
      return true;
    };
    authWindow.webContents.on('will-redirect', (event, url) => {
      if (String(url).includes('access_token=')) { event.preventDefault(); capture(url).catch(error => finish(error)); }
    });
    authWindow.webContents.on('will-navigate', (event, url) => {
      if (String(url).includes('access_token=')) { event.preventDefault(); capture(url).catch(error => finish(error)); }
    });
    authWindow.webContents.on('did-navigate-in-page', (_event, url) => { capture(url).catch(error => finish(error)); });
    authWindow.on('closed', () => {
      if (yandexMusicAuthWindow === authWindow) yandexMusicAuthWindow = null;
      if (!settled) { settled = true; resolve({ connected: false, cancelled: true }); }
    });
    authWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//i.test(url) && /oauth\.yandex\.ru|music\.yandex\.ru|passport\.yandex\./i.test(url)) { authWindow.loadURL(url).catch(() => {}); }
      else shell.openExternal(url).catch(() => {});
      return { action: 'deny' };
    });
    authWindow.loadURL(authUrl).catch(error => finish(error));
  });
}
function normalizeYandexTrack(track) {
  const source = track?.track || track || {};
  const album = source.albums?.[0] || source.album || {};
  const coverRaw = album.coverUri || album.cover?.uri || source.coverUri || source.cover?.uri || source.albums?.[0]?.coverUri || '';
  const cover = String(coverRaw).replace(/^https?:\/\//, '').replace(/^\/\//, '').replace(/%%/g, '400x400');
  return {
    id: String(source.id || ''), title: String(source.title || 'Неизвестный трек'),
    artist: (source.artists || []).map(artist => artist.name).filter(Boolean).join(', ') || 'Неизвестный исполнитель',
    album: String(album.title || ''), durationMs: Number(source.durationMs || 0),
    coverUrl: cover ? `https://${cover}` : '', explicit: Boolean(source.contentWarning?.length)
  };
}
async function searchYandexMusicTracks(query) {
  const text = String(query || '').trim().slice(0, 120);
  if (!text) return [];
  const result = await yandexMusicRequest(`search?type=track&page=0&text=${encodeURIComponent(text)}`);
  const rows = result?.tracks?.results || result?.tracks?.items || [];
  return rows.slice(0, 30).map(normalizeYandexTrack).filter(track => track.id);
}
async function getYandexMusicPlaylists() {
  const account = await yandexMusicAccountStatus();
  const uid = String(account.uid || '').trim();
  if (!/^\d{1,20}$/.test(uid)) throw new Error('Яндекс Музыка не вернула идентификатор аккаунта. Переподключи аккаунт.');
  const result = await yandexMusicRequest(`users/${encodeURIComponent(uid)}/playlists/list`);
  const rows = Array.isArray(result) ? result : Array.isArray(result?.playlists) ? result.playlists : [];
  return rows.slice(0, 80).map(row => {
    const cover = String(row.cover?.uri || row.coverUri || '').replace(/^https?:\/\//, '').replace(/%%/g, '200x200');
    return { kind: String(row.kind ?? row.id ?? ''), title: String(row.title || row.name || 'Плейлист'), trackCount: Number(row.trackCount || row.tracksCount || 0), coverUrl: cover ? `https://${cover}` : '' };
  }).filter(row => /^\d{1,20}$/.test(row.kind));
}
async function getYandexMusicPlaylistTracks(kind) {
  const safeKind = String(kind || '').trim();
  if (!/^\d{1,20}$/.test(safeKind)) throw new Error('Некорректный идентификатор плейлиста.');
  const account = await yandexMusicAccountStatus();
  const uid = String(account.uid || '').trim();
  if (!/^\d{1,20}$/.test(uid)) throw new Error('Яндекс Музыка не вернула идентификатор аккаунта. Переподключи аккаунт.');
  const result = await yandexMusicRequest(`users/${encodeURIComponent(uid)}/playlists/${encodeURIComponent(safeKind)}`);
  const rows = Array.isArray(result?.tracks) ? result.tracks : Array.isArray(result?.playlist?.tracks) ? result.playlist.tracks : [];
  return rows.slice(0, 200).map(normalizeYandexTrack).filter(track => track.id);
}
async function getYandexMusicStream(trackId) {
  const id = String(trackId || '').trim();
  if (!/^\d{1,20}$/.test(id)) throw new Error('Некорректный идентификатор трека.');
  // The download-info API returns an XML descriptor, not audio bytes. Passing that
  // descriptor to <audio> causes Chromium's "no supported source" error. Resolve
  // the signed media URL in the main process, preferring a real MP3 variant.
  const result = await yandexMusicRequest(`tracks/${encodeURIComponent(id)}/download-info?can_use_streaming=true`);
  const sources = Array.isArray(result) ? result : Array.isArray(result?.downloadInfo) ? result.downloadInfo : [];
  const candidates = sources.filter(row => row?.downloadInfoUrl || row?.src).sort((a, b) => {
    const score = row => (String(row.codec || '').toLowerCase() === 'mp3' ? 100000 : 0) + (row.preview ? -50000 : 0) + Number(row.bitrateInKbps || 0);
    return score(b) - score(a);
  });
  if (!candidates.length) throw new Error('Яндекс Музыка не предоставила аудиопоток. Проверь активность подписки и доступность трека.');
  let lastError = null;
  for (const item of candidates) {
    try {
      let rawUrl = item.src || item.downloadInfoUrl;
      if (!rawUrl) continue;
      let mediaUrl = new URL(rawUrl, 'https://api.music.yandex.net');
      if (mediaUrl.protocol !== 'https:') throw new Error('Поток должен использовать HTTPS.');
      // A signed CDN URL can be returned directly by some API variants.
      if (item.direct === true || /\.(mp3|m4a|m3u8)(?:$|\?)/i.test(mediaUrl.pathname + mediaUrl.search)) {
        return { url: mediaUrl.toString(), isHls: /m3u8/i.test(mediaUrl.pathname), codec: String(item.codec || '').toLowerCase(), bitrate: Number(item.bitrateInKbps || 0), preview: Boolean(item.preview) };
      }
      const descriptorResponse = await fetchWithTimeout(mediaUrl.toString(), {
        headers: { Authorization: `OAuth ${readYandexMusicToken()}`, Accept: 'application/xml,text/xml,*/*', 'X-Yandex-Music-Client': 'YandexMusicDesktopAppWindows/5.95.0' }
      }, 18000);
      if (!descriptorResponse.ok) throw new Error(`Не удалось получить описание аудио (HTTP ${descriptorResponse.status}).`);
      const xml = await descriptorResponse.text();
      const descriptor = parseYandexDownloadInfoXml(xml);
      if (descriptor) {
        const direct = buildYandexDirectMp3Url(descriptor);
        return { url: direct, isHls: false, codec: 'mp3', bitrate: Number(item.bitrateInKbps || 0), preview: Boolean(item.preview) };
      }
      // Some servers return a redirect or the direct media URL rather than XML.
      const finalUrl = descriptorResponse.url || mediaUrl.toString();
      const contentType = String(descriptorResponse.headers.get('content-type') || '').toLowerCase();
      if (contentType.startsWith('audio/') || /\.(mp3|m4a|m3u8)(?:$|\?)/i.test(finalUrl)) {
        return { url: finalUrl, isHls: /m3u8/i.test(finalUrl), codec: String(item.codec || 'mp3').toLowerCase(), bitrate: Number(item.bitrateInKbps || 0), preview: Boolean(item.preview) };
      }
      throw new Error('Сервер вернул метаданные вместо прямой ссылки на аудио.');
    } catch (error) { lastError = error; }
  }
  throw new Error(`Не удалось разрешить аудиопоток Яндекс Музыки. ${lastError?.message || 'Попробуй другой трек.'}`);
}

async function getYandexMyWaveTracks(afterTrackId = '') {
  const lastId = String(afterTrackId || '').trim();
  if (lastId && !/^\d{1,20}$/.test(lastId)) throw new Error('Некорректный идентификатор последнего трека.');
  const params = new URLSearchParams({ settings2: 'true' });
  if (lastId) params.set('queue', lastId);
  const result = await yandexMusicRequest(`rotor/station/user:onyourwave/tracks?${params.toString()}`);
  const sequence = Array.isArray(result?.sequence) ? result.sequence : [];
  const tracks = sequence.map(item => normalizeYandexTrack(item?.track || item)).filter(track => track.id);
  return { tracks, batchId: String(result?.batchId || ''), stationId: 'user:onyourwave', afterTrackId: lastId };
}
async function sendYandexMyWaveFeedback(payload = {}) {
  const event = ['radioStarted', 'trackStarted', 'trackFinished', 'skip'].includes(String(payload.event)) ? String(payload.event) : 'trackStarted';
  const trackId = String(payload.trackId || '').trim();
  if (trackId && !/^\d{1,20}$/.test(trackId)) throw new Error('Некорректный идентификатор трека для обратной связи.');
  return yandexMusicRequest('rotor/station/user:onyourwave/feedback', readYandexMusicToken(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ...(trackId ? { trackId } : {}), ...(payload.batchId ? { batchId: String(payload.batchId) } : {}), totalPlayedSeconds: Math.max(0, Math.min(86400, Number(payload.totalPlayedSeconds) || 0)) })
  });
}

const LABY_SKIN_SORTS = new Set(['trending_24h', 'trending_7d', 'trending_30d', 'most_used', 'latest']);
const LABY_RENDER_PLAYER_UUID = '8667ba71-b85a-4004-af54-457a9734eed7';
async function getLabySkinTextureCatalog({ sort = 'trending_7d', offset = 0, limit = 36 } = {}) {
  const order = LABY_SKIN_SORTS.has(String(sort)) ? String(sort) : 'trending_7d';
  const size = Math.max(12, Math.min(48, Number(limit) || 36));
  const start = Math.max(0, Math.min(5000, Number(offset) || 0));
  const cacheKey = `${order}|${start}|${size}`;
  const cached = labySkinCatalogCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.items.map(item => ({ ...item, tags: [...item.tags] }));
  const params = new URLSearchParams({ page: String(Math.floor(start / size) + 1), order, size: String(size), offset: String(start) });
  const response = await fetchWithTimeout(`https://laby.net/api/v3/search/textures/skin?${params}`, { headers: { Accept: 'application/json' } }, 18000);
  if (!response.ok) throw new Error(`Laby не загрузил каталог скинов (HTTP ${response.status}).`);
  const payload = await response.json();
  const source = Array.isArray(payload?.results) ? payload.results : Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const items = source.map(row => {
    const hash = String(row?.image_hash || row?.hash || '').toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(hash)) return null;
    const rawTags = Array.isArray(row?.tags) ? row.tags : typeof row?.tags === 'string' ? row.tags.split(/\s+/) : [];
    const tags = rawTags.map(tag => typeof tag === 'string' ? tag : String(tag?.name || tag?.label || '')).map(tag => tag.trim()).filter(Boolean).slice(0, 8);
    const title = tags.join(' · ') || `Скин сообщества ${hash.slice(0, 6)}`;
    // The no-parameter URL is Laby's documented, CDN-cached preview endpoint.
    // Keep it as a display-only render; it is not the editable UV texture.
    const preview = `https://laby.net/api/v3/render/skin/${hash}.webp`;
    return { hash, title, name: title, tags, useCount: Math.max(0, Number(row?.use_count || row?.uses || 0)), slim: Boolean(row?.slim ?? row?.slim_skin), preview, rawTextureUrl: String(row?.texture_url || row?.textureUrl || row?.download_url || row?.downloadUrl || ''), source: 'Laby' };
  }).filter(Boolean);
  labySkinCatalogCache.set(cacheKey, { expiresAt: Date.now() + 3 * 60 * 1000, items });
  while (labySkinCatalogCache.size > 48) labySkinCatalogCache.delete(labySkinCatalogCache.keys().next().value);
  return items;
}
async function getLabySkinTexture(hashValue) {
  const hash = String(hashValue || '').trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(hash)) throw new Error('Некорректный идентификатор текстуры Laby.');
  if (labySkinTextureCache.has(hash)) return labySkinTextureCache.get(hash);

  // IMPORTANT: /api/v3/render/skin/{hash} returns a 3D render, not the editable UV atlas.
  // Only accept a downloaded PNG after verifying its native Minecraft atlas dimensions.
  const catalogRow = labySkinCatalogCache.size
    ? [...labySkinCatalogCache.values()].flatMap(entry => entry.items || []).find(item => item.hash === hash)
    : null;
  const candidates = [
    catalogRow?.rawTextureUrl,
    `https://texture.laby.net/skin/${hash}.png`,
    `https://texture.laby.net/${hash}.png`,
    `https://texture.laby.net/texture/${hash}.png`,
    `https://laby.net/api/v3/textures/skin/${hash}.png`,
    `https://laby.net/api/v3/download/skin/${hash}.png`
  ].filter((url, index, all) => url && /^https:\/\//i.test(url) && all.indexOf(url) === index);
  let lastError = null;
  for (const url of candidates) {
    try {
      const response = await fetchWithTimeout(url, { headers: { Accept: 'image/png,*/*' } }, 4500);
      if (!response.ok) { lastError = new Error(`HTTP ${response.status}`); continue; }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (contentType !== 'image/png') { lastError = new Error('Источник вернул не PNG'); continue; }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 24 || bytes.length > 2 * 1024 * 1024 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
        lastError = new Error('Некорректный PNG'); continue;
      }
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (width !== 64 || ![32,64].includes(height)) { lastError = new Error(`Это не UV-текстура 64×64 или 64×32 (получено ${width}×${height})`); continue; }
      const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
      labySkinTextureCache.set(hash, dataUrl);
      while (labySkinTextureCache.size > 96) labySkinTextureCache.delete(labySkinTextureCache.keys().next().value);
      return dataUrl;
    } catch (error) { lastError = error; }
  }
  throw new Error(`Laby не предоставил исходную UV-текстуру для редактирования. 3D-превью остаётся доступным, но рендер нельзя использовать как скин; загрузи PNG-текстуру вручную. ${lastError?.message || ''}`.trim());
}

async function getCraftyTrendingSkins(sort = 'trending') {
  const sortKey = ['trending', 'viewed', 'worn', 'new'].includes(sort) ? sort : 'trending';
  if (craftyTrendingSkinCache.expiresAt > Date.now() && craftyTrendingSkinCache.items[sortKey]) return craftyTrendingSkinCache.items[sortKey];
  const response = await fetchWithTimeout('https://crafty.gg/skins', { headers: { Accept: 'text/html,application/xhtml+xml' } }, 18000);
  if (!response.ok) throw new Error(`Crafty.gg ответил ${response.status}.`);
  const html = await response.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const headingMap = { trending: 'trending skins', viewed: 'most viewed', worn: 'most worn', new: 'new skins' };
  const sectionHeading = $('h2').filter((_i, el) => $(el).text().trim().toLowerCase() === headingMap[sortKey]).first();
  let scope = sectionHeading;
  for (let depth = 0; depth < 5 && scope.length; depth++) {
    if (scope.find('img[alt*="Minecraft skin"]').length >= 2) break;
    scope = scope.parent();
  }
  if (!scope.length || scope.find('img[alt*="Minecraft skin"]').length < 2) scope = $('body');
  const items = [];
  const seen = new Set();
  scope.find('img[alt*="Minecraft skin"]').each((_index, el) => {
    const image = $(el);
    const alt = String(image.attr('alt') || '');
    const nameMatch = alt.match(/first worn by\s+([A-Za-z0-9_]{3,16})/i);
    const imageAnchor = image.closest('a');
    const card = imageAnchor.parent().parent().parent();
    let username = nameMatch?.[1] || '';
    if (!username) {
      const possible = card.find('a').toArray().map(a => $(a).text().trim()).find(text => /^[A-Za-z0-9_]{3,16}$/.test(text));
      username = possible || '';
    }
    if (!username || seen.has(username.toLowerCase())) return;
    seen.add(username.toLowerCase());
    const rawSrc = image.attr('src') || image.attr('data-src') || '';
    let preview = '';
    try { const parsed = new URL(rawSrc, 'https://crafty.gg'); if (parsed.protocol === 'https:' && /(^|\.)render\.crafty\.gg$/.test(parsed.hostname)) preview = parsed.toString(); } catch {}
    const parentText = card.text().replace(/\s+/g, ' ').trim();
    const countMatch = parentText.match(/([\d,.]+\s?[kKmM]?)\s*(?:views|players|worn)/i);
    items.push({ username, title: alt.replace(/\s*—.*$/, '').replace(/^Image:\s*/i, '').slice(0, 100) || username, preview, popularity: countMatch?.[1] || '', source: 'Crafty.gg' });
  });
  const result = items.slice(0, 24);
  if (!result.length) throw new Error('Crafty.gg не вернул список скинов.');
  craftyTrendingSkinCache = { expiresAt: Date.now() + 5 * 60 * 1000, items: { ...(craftyTrendingSkinCache.items || {}), [sortKey]: result } };
  return result;
}

async function getLabyTrendingClothing() {
  if (labyTrendingClothingCache.expiresAt > Date.now() && labyTrendingClothingCache.items.length) return labyTrendingClothingCache.items;
  const response = await fetchWithTimeout('https://laby.net/ru', { headers: { Accept: 'text/html,application/xhtml+xml' } }, 12000);
  if (!response.ok) throw new Error(`Laby ответил HTTP ${response.status}.`);
  const html = await response.text();
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  const items = [], seen = new Set();
  $('a[href*="/clothing/"]').each((_, element) => {
    const link = $(element);
    const href = link.attr('href') || '';
    let parsed;
    try { parsed = new URL(href, 'https://laby.net'); } catch { return; }
    const match = parsed.pathname.match(/^\/(?:[a-z]{2}\/)?clothing\/(\d+)\.([a-z0-9-]+)/i);
    if (!match || seen.has(match[1])) return;
    const id = match[1]; seen.add(id);
    const card = link.closest('article, li, [class*="clothing-card"], [class*="ClothingCard"], [class*="card"]');
    const scope = card.length ? card : link;
    const image = scope.find('img').first();
    const title = String(link.attr('aria-label') || link.attr('title') || image.attr('alt') || link.text() || match[2].replace(/-/g, ' ')).replace(/\s+/g, ' ').trim().replace(/\s+\d+\s*$/, '');
    const imgRaw = image.attr('src') || image.attr('data-src') || (image.attr('srcset') || '').split(',')[0].trim().split(/\s+/)[0] || '';
    let preview = '';
    try {
      const imgUrl = imgRaw ? new URL(imgRaw, parsed).toString() : '';
      if (imgUrl && /^https:$/.test(new URL(imgUrl).protocol) && /(^|\.)laby\.net$/.test(new URL(imgUrl).hostname)) preview = imgUrl;
    } catch {}
    const text = `${title} ${scope.text()}`;
    const category = /crown|hat|headwear|goggle|glasses|mask|head/i.test(text) ? 'Головной убор' : /hoodie|suit|shirt|clothing|jacket/i.test(text) ? 'Одежда' : 'Аксессуар';
    items.push({ id, title: title.slice(0, 120), category, preview, url: `https://laby.net/ru/clothing/${id}.${match[2]}` });
  });
  const result = items.slice(0, 10);
  if (!result.length) throw new Error('На главной Laby не удалось найти актуальные предметы одежды.');
  labyTrendingClothingCache = { expiresAt: Date.now() + 10 * 60 * 1000, items: result };
  return result;
}
async function getLabyClothingTexture(clothingId) {
  const id = String(clothingId || '').trim();
  if (!/^\d{1,12}$/.test(id)) throw new Error('Некорректный идентификатор одежды Laby.');
  if (labyClothingTextureCache.has(id)) return labyClothingTextureCache.get(id);
  const url = `https://laby.net/api/v3/clothing/${encodeURIComponent(id)}/texture/wide.png?download=1`;
  const response = await fetchWithTimeout(url, { headers: { Accept: 'image/png,image/*' } }, 15000);
  if (!response.ok) throw new Error(`Не удалось скачать текстуру одежды Laby (HTTP ${response.status}).`);
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType && !contentType.includes('image/png') && !contentType.includes('application/octet-stream')) throw new Error('Laby вернул не PNG-текстуру.');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 2 * 1024 * 1024 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Текстура Laby повреждена или слишком велика.');
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (![64, 128].includes(width) || ![32, 64, 128].includes(height) || width !== height && !(width === 64 && height === 32)) throw new Error(`Неожиданный размер текстуры Laby: ${width}×${height}.`);
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  labyClothingTextureCache.set(id, dataUrl);
  return dataUrl;
}

async function getSkinByUsername(username, options = {}) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Укажи ник Minecraft: 3–16 латинских букв, цифр или _.');
  if (!options.publicOnly) {
    const localProfileSkin = offlineSkinPathFor({ username: name });
    const activeProfile = getProfile();
    const activeSkin = activeProfile.type === 'offline' && activeProfile.username.toLowerCase() === name.toLowerCase() ? skinFileForProfile(activeProfile) : '';
    const localSkin = activeSkin && fs.existsSync(activeSkin) ? activeSkin : (fs.existsSync(localProfileSkin) ? localProfileSkin : '');
    if (localSkin) return { username: name, dataUrl: `data:image/png;base64,${fs.readFileSync(localSkin).toString('base64')}`, source: 'local-offline-profile' };
  }
  const lookup = await fetchWithTimeout(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {}, 12000);
  if (!lookup.ok) throw new Error(lookup.status === 404 ? `Профиль ${name} не найден в публичном каталоге Minecraft.` : `Не удалось найти профиль Minecraft (HTTP ${lookup.status}).`);
  const profile = await lookup.json();
  if (!profile?.id) throw new Error('Публичный профиль не содержит UUID.');
  const session = await fetchWithTimeout(`https://sessionserver.mojang.com/session/minecraft/profile/${encodeURIComponent(profile.id)}?unsigned=false`, {}, 12000);
  if (!session.ok) throw new Error(`Не удалось получить текстуру профиля (HTTP ${session.status}).`);
  const data = await session.json();
  const property = (data.properties || []).find(item => item.name === 'textures');
  if (!property?.value) throw new Error(`У профиля ${name} нет доступной текстуры скина.`);
  const decoded = JSON.parse(Buffer.from(property.value, 'base64').toString('utf8'));
  const url = String(decoded.textures?.SKIN?.url || '').replace(/^http:\/\//i, 'https://');
  if (!/^https:\/\/textures\.minecraft\.net\//.test(url)) throw new Error('Сервер профилей вернул недопустимый адрес текстуры.');
  const destination = path.join(SKINS_DIR, `lookup-${profile.id}.png`);
  await downloadToFile(url, destination, null, null, 30000);
  const bytes = fs.readFileSync(destination);
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 64 || ![32,64].includes(bytes.readUInt32BE(20))) throw new Error('Полученный файл не является корректным PNG-скином Minecraft.');
  return { username: profile.name || name, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
}

function offlineSkinPathFor(profile) {
  const name = String(profile?.username || 'player').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).toLowerCase() || 'player';
  return path.join(SKINS_DIR, `offline-${name}.png`);
}
function skinFileForProfile(profile) {
  if (profile?.type === 'microsoft') return profile.skinPath && fs.existsSync(profile.skinPath) ? profile.skinPath : '';
  if (profile?.type === 'offline') {
    const perProfile = offlineSkinPathFor(profile);
    if (fs.existsSync(perProfile)) return perProfile;
    const configured = profile.customSkinPath;
    if (configured && fs.existsSync(configured) && path.resolve(configured) !== path.resolve(path.join(SKINS_DIR, 'custom-skin.png'))) return configured;
    // Migration path for skins saved by earlier SAT releases before per-offline-profile storage existed.
    const legacy = path.join(SKINS_DIR, 'custom-skin.png');
    return fs.existsSync(legacy) ? legacy : '';
  }
  const guestPath = profile?.customSkinPath || path.join(SKINS_DIR, 'custom-skin.png');
  return fs.existsSync(guestPath) ? guestPath : '';
}

async function getProfileSkin() {
  const profile = getProfile();
  let file = '';
  if (profile.type === 'microsoft' && profile.uuid) {
    // A Microsoft profile always shows the licensed skin. Never fall through to the local/offline skin.
    file = profile.skinPath && fs.existsSync(profile.skinPath) ? profile.skinPath : '';
    if (!file) {
      try {
        const uuid = String(profile.uuid).replace(/-/g, '');
        const res = await fetchWithTimeout(`https://sessionserver.mojang.com/session/minecraft/profile/${uuid}?unsigned=false`, {}, 15000);
        if (res.ok) {
          const data = await res.json();
          const prop = (data.properties || []).find(p => p.name === 'textures');
          if (prop?.value) {
            const decoded = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
            const rawSkinUrl = decoded.textures?.SKIN?.url;
            const skinUrl = typeof rawSkinUrl === 'string' ? rawSkinUrl.replace(/^http:\/\//i, 'https://') : '';
            if (skinUrl && /^https:\/\/textures\.minecraft\.net\//.test(skinUrl)) {
              const dest = path.join(SKINS_DIR, `official-${uuid}.png`);
              await downloadToFile(skinUrl, dest, null, null, 30000);
              const bytes = fs.readFileSync(dest);
              if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && bytes.readUInt32BE(16) === 64 && [32,64].includes(bytes.readUInt32BE(20))) {
                profile.skinPath = dest; profile.skinTextureUrl = skinUrl; saveProfile(profile); file = dest;
              } else fs.rmSync(dest, { force: true });
            }
          }
        }
      } catch (error) { log(`Не удалось получить официальный скин профиля: ${error.message}`, 'warn'); }
    }
  } else if (profile.type === 'offline') {
    const perProfile = offlineSkinPathFor(profile);
    const legacySkin = path.join(SKINS_DIR, 'custom-skin.png');
    const configuredSkin = profile.customSkinPath && fs.existsSync(profile.customSkinPath) && path.resolve(profile.customSkinPath) !== path.resolve(legacySkin) ? profile.customSkinPath : '';
    if (fs.existsSync(perProfile)) {
      file = perProfile;
    } else if (configuredSkin) {
      file = configuredSkin;
    } else {
      // Offline names can also belong to a public Mojang profile. Try that texture once
      // and cache misses briefly; keep the user's own local skin as a fallback.
      const cacheKey = String(profile.username || '').toLowerCase();
      const cached = offlineSkinLookupCache.get(cacheKey);
      if (cached?.file && fs.existsSync(cached.file)) {
        file = cached.file;
      } else if (!cached || cached.expiresAt < Date.now()) {
        try {
          const found = await getSkinByUsername(profile.username, { publicOnly: true });
          const payload = found.dataUrl.slice(found.dataUrl.indexOf(',') + 1);
          const bytes = Buffer.from(payload, 'base64');
          if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== 64 || ![32, 64].includes(bytes.readUInt32BE(20))) throw new Error('Получена некорректная UV-текстура.');
          fs.mkdirSync(SKINS_DIR, { recursive: true });
          const temporary = `${perProfile}.tmp`;
          fs.writeFileSync(temporary, bytes);
          fs.renameSync(temporary, perProfile);
          profile.customSkinPath = perProfile;
          saveProfile(profile);
          offlineSkinLookupCache.set(cacheKey, { file: perProfile, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
          file = perProfile;
        } catch (error) {
          offlineSkinLookupCache.set(cacheKey, { file: '', expiresAt: Date.now() + 10 * 60 * 1000 });
          log(`Публичный скин для офлайн-профиля ${profile.username} недоступен; используется локальный скин, если он есть. ${error.message}`, 'debug');
        }
      }
      if (!file && fs.existsSync(legacySkin)) file = legacySkin;
    }
  } else {
    file = skinFileForProfile(profile);
  }
  if (!file || !fs.existsSync(file)) return null;
  try { return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`; } catch { return null; }
}

function saveCustomSkin(dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\/png;base64,[a-z0-9+/=]+$/i.test(dataUrl)) throw new Error('Ожидалось PNG-изображение скина.');
  const payload = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (payload.length > 3 * 1024 * 1024) throw new Error('Файл скина слишком большой.');
  const buffer = Buffer.from(payload, 'base64');
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Файл не является PNG.');
  // Minecraft classic skins are 64x64. PNG IHDR width/height are big-endian at bytes 16/20.
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (width !== 64 || ![32, 64].includes(height)) throw new Error('Скин должен иметь размер 64×64 или 64×32 пикселя.');
  ensureDirectories();
  const activeProfile = getProfile();
  const destination = activeProfile.type === 'offline' ? offlineSkinPathFor(activeProfile) : path.join(SKINS_DIR, 'custom-skin.png');
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, destination);
  const profile = getProfile();
  profile.customSkinPath = destination;
  saveProfile(profile);
  log('Пользовательский скин сохранён локально.');
  return { ok: true, path: destination, width, height };
}
function getCustomSkin() {
  const file = path.join(SKINS_DIR, 'custom-skin.png');
  if (!fs.existsSync(file)) return null;
  try { return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`; } catch { return null; }
}

async function chooseDirectory() {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
}
async function chooseJavaFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: process.platform === 'win32' ? [{ name: 'Java executable', extensions: ['exe'] }] : [{ name: 'Executable', extensions: ['*'] }]
  });
  return result.canceled ? null : result.filePaths[0];
}


function stopDiscordPresence() {
  const client = discordRpcClient;
  discordRpcClient = null;
  discordRpcAppId = null;
  discordPresenceKey = '';
  discordPresenceStartedAt = 0;
  if (!client) return;
  try { Promise.resolve(client.clearActivity()).catch(() => {}); } catch {}
  try { client.destroy(); } catch {}
}

function normalizeDiscordImageKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

function getDiscordPresenceInstance() {
  const ids = [...runningGames.keys()];
  const id = ids.length ? ids[ids.length - 1] : null;
  return id ? getInstance(id) : null;
}

async function syncDiscordPresence(activity = 'launcher') {
  const settings = getSettings();
  const appId = String(settings.discordApplicationId || '').trim();
  if (!appId) return { enabled: false, reason: 'not-configured', message: 'Укажи Application ID в настройках Discord.' };
  if (!/^\d{17,20}$/.test(appId)) throw new Error('Discord Application ID должен состоять из 17–20 цифр.');
  try {
    if (discordRpcClient && discordRpcAppId !== appId) stopDiscordPresence();
    if (!discordRpcClient) {
      const RPC = require('discord-rpc');
      RPC.register(appId);
      const rpc = new RPC.Client({ transport: 'ipc' });
      rpc.on('disconnected', () => {
        if (discordRpcClient === rpc) {
          discordRpcClient = null;
          discordRpcAppId = null;
          // Preserve the session timestamp: a short Discord restart must not reset elapsed time.
        }
      });
      await rpc.login({ clientId: appId });
      discordRpcClient = rpc;
      discordRpcAppId = appId;
    }

    let resolvedActivity = activity === 'game' && runningGames.size > 0 ? 'game' : 'launcher';
    const instance = resolvedActivity === 'game' ? getDiscordPresenceInstance() : null;
    const activityKey = `${resolvedActivity}:${instance?.id || ''}`;
    if (activityKey !== discordPresenceKey || !discordPresenceStartedAt) {
      discordPresenceKey = activityKey;
      discordPresenceStartedAt = Date.now();
    }

    const imageKey = normalizeDiscordImageKey(settings.discordImageKey || 'sat_launcher');
    const details = resolvedActivity === 'game'
      ? `Minecraft Java Edition${instance?.minecraftVersion ? ` · ${instance.minecraftVersion}` : ''}`
      : 'Выбирает сборку Minecraft';
    const stateText = resolvedActivity === 'game'
      ? `Сборка: ${String(instance?.name || 'Minecraft').slice(0, 96)}`
      : 'SAT LAUNCHER';
    const presence = {
      details: details.slice(0, 128),
      state: stateText.slice(0, 128),
      largeImageText: 'SAT LAUNCHER',
      startTimestamp: new Date(discordPresenceStartedAt),
      instance: false
    };
    // Uploaded art asset names are optional. When blank/invalid, Discord can still use
    // the application's icon configured in Developer Portal → General Information.
    if (imageKey) presence.largeImageKey = imageKey;

    await discordRpcClient.setActivity(presence);
    discordLastFailureMessage = '';
    return { enabled: true, connected: true, activity: resolvedActivity, details, state: stateText };
  } catch (error) {
    const message = String(error?.message || error || 'Неизвестная ошибка Discord RPC');
    const now = Date.now();
    if (message !== discordLastFailureMessage || now - discordLastFailureLoggedAt > 60000) {
      log(`Discord Rich Presence недоступен: ${message}`, 'warn');
      discordLastFailureMessage = message;
      discordLastFailureLoggedAt = now;
    }
    // Do not destroy timestamp state on a transient disconnect; retry logic can restore it.
    const client = discordRpcClient;
    discordRpcClient = null;
    discordRpcAppId = null;
    if (client) { try { client.destroy(); } catch {} }
    return { enabled: false, connected: false, reason: message, message: 'Проверь, что запущен настольный Discord и Application ID указан верно.' };
  }
}

function getDiscordPresenceStatus() {
  const settings = getSettings();
  return {
    configured: Boolean(String(settings.discordApplicationId || '').trim()),
    connected: Boolean(discordRpcClient),
    applicationId: String(settings.discordApplicationId || '').trim(),
    imageKey: String(settings.discordImageKey || 'sat_launcher'),
    gameRunning: runningGames.size > 0,
    activity: runningGames.size > 0 ? 'game' : 'launcher'
  };
}


function getLauncherCacheInfo() {
  const result = { bytes: 0, files: 0 };
  const preserved = path.resolve(path.join(CACHE_DIR, 'compatibility-backups'));
  const visit = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (path.resolve(target) === preserved) continue; // Recovery backups are not disposable cache.
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) {
        try { result.bytes += fs.statSync(target).size; result.files++; } catch {}
      }
    }
  };
  visit(CACHE_DIR);
  visit(MINECRAFT_ASSETS_DIR);
  return result;
}

function countFilesAndBytes(directory) {
  const result = { files: 0, bytes: 0 };
  const visit = current => {
    let entries; try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) { try { result.files++; result.bytes += fs.statSync(target).size; } catch {} }
    }
  };
  visit(directory);
  return result;
}

async function clearLauncherCache() {
  const targets = [CACHE_DIR, MINECRAFT_ASSETS_DIR];
  let removed = 0;
  let removedBytes = 0;
  const errors = [];
  for (const target of targets) {
    try {
      fs.mkdirSync(target, { recursive: true });
      const entries = fs.readdirSync(target);
      for (const entry of entries) {
        // These are recovery backups for compatibility repairs, not disposable cache.
        if (target === CACHE_DIR && entry === 'compatibility-backups') continue;
        const itemPath = path.join(target, entry);
        const before = countFilesAndBytes(itemPath);
        try {
          fs.rmSync(itemPath, { recursive: true, force: true });
          removed += before.files;
          removedBytes += before.bytes;
        } catch (error) { errors.push(`${entry}: ${error.message}`); }
      }
    } catch (error) { errors.push(error.message); }
  }
  try { await session.defaultSession.clearCache(); } catch (error) { errors.push(`Chromium cache: ${error.message}`); }
  try { await session.defaultSession.clearStorageData({ storages: ['appcache', 'shadercache', 'cachestorage'] }); } catch (error) { errors.push(`Chromium storage cache: ${error.message}`); }
  textureDataUrlCache.clear();
  assetLoadPromise = null;
  assetLoadResult = null;
  loaderVersionsCache.clear();
  modrinthTranslationCache.clear();
  modrinthProjectDetailsCache.clear();
  mapSearchCache.clear();
  mapSearchPending.clear();
  labyClothingTextureCache.clear();
  labySkinTextureCache.clear();
  labySkinCatalogCache.clear();
  offlineSkinLookupCache.clear();
  labyTrendingClothingCache = { expiresAt: 0, items: [] };
  craftyTrendingSkinCache = { expiresAt: 0, items: {} };
  return { ok: errors.length === 0, removed, removedBytes, errors };
}

async function clearLauncherLogs() {
  const language = getSettings().language === 'en' ? 'en' : 'ru';
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: language === 'en' ? ['Clear logs', 'Cancel'] : ['Очистить логи', 'Отмена'],
    defaultId: 1, cancelId: 1, noLink: true,
    title: language === 'en' ? 'Clear launcher and Minecraft logs?' : 'Очистить логи лаунчера и Minecraft?',
    message: language === 'en' ? 'Launcher logs, crash reports and inactive instances logs will be deleted. Active Minecraft logs are kept.' : 'Будут удалены журналы лаунчера, отчёты о сбоях и логи неактивных сборок. Логи запущенного Minecraft останутся.',
  });
  if (confirmation.response !== 0) return { ok: false, cancelled: true, removedFiles: 0, skippedInstances: 0 };
  let removedFiles = 0;
  let skippedInstances = 0;
  const errors = [];
  try {
    for (const suffix of ['', '.1', '.2', '.3']) { const file = `${LOG_FILE}${suffix}`; if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removedFiles++; } }
    fs.writeFileSync(LOG_FILE, '', 'utf8');
  } catch (error) { errors.push(`launcher.log: ${error.message}`); log(`Не удалось очистить файл журнала лаунчера: ${error.message}`, 'warn'); }
  logs = [];
  for (const instance of getInstances()) {
    if (runningGames.has(instance.id) || launchingGames.has(String(instance.id))) { skippedInstances++; continue; }
    for (const folder of ['logs', 'crash-reports']) {
      const target = path.join(instance.root, folder);
      try {
        if (!fs.existsSync(target)) continue;
        const before = countFilesAndBytes(target);
        fs.rmSync(target, { recursive: true, force: true });
        fs.mkdirSync(target, { recursive: true });
        removedFiles += before.files;
      } catch (error) { errors.push(`${instance.name}/${folder}: ${error.message}`); log(`Не удалось очистить ${folder} в сборке ${instance.name}: ${error.message}`, 'warn'); }
    }
  }
  return { ok: errors.length === 0, cancelled: false, removedFiles, skippedInstances, errors };
}


let autoUpdaterInstance = null;
let installAfterDownload = false;
let updaterState = { state: 'idle', currentVersion: app.getVersion(), version: '', percent: 0, error: '' };
function setUpdaterState(patch) {
  updaterState = { ...updaterState, ...patch, currentVersion: app.getVersion() };
  emit('launcher:updateStatus', updaterState);
}
function handleUpdaterFailure(error, fallbackError = 'update_check_failed') {
  installAfterDownload = false;
  if (isNoPublishedReleaseError(error)) {
    const wasAlreadyCurrent = updaterState.state === 'current';
    setUpdaterState({ state: 'current', version: app.getVersion(), percent: 0, error: '' });
    if (!wasAlreadyCurrent) log('Опубликованных обновлений пока нет; текущая версия остаётся активной.', 'info');
    return 'no-update';
  }
  setUpdaterState({ state: 'error', error: fallbackError });
  log(fallbackError === 'update_download_failed'
    ? 'Не удалось скачать обновление SAT LAUNCHER.'
    : 'Не удалось проверить или загрузить обновление SAT LAUNCHER.', 'warn');
  return 'error';
}
function configureAutoUpdater() {
  if (!app.isPackaged) return;
  const updaterConfigPath = path.join(process.resourcesPath || '', 'app-update.yml');
  if (!fs.existsSync(updaterConfigPath)) {
    setUpdaterState({ state: 'unconfigured', error: '' });
    log('Автоматическое обновление сейчас недоступно для этой установки.', 'warn');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdaterInstance = autoUpdater;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    // Existing preview builds (for example 1.0.8) may migrate down to the requested 1.0.0
    // initial release exactly once. Once 1.0.0 has launched successfully, persist a flag and
    // return to normal forward-only updates (1.0.1, 1.0.2, ...).
    if (app.getVersion() === '1.0.0') {
      try { fs.writeFileSync(INITIAL_VERSION_MIGRATION_FLAG, 'done', 'utf8'); } catch {}
    }
    autoUpdater.allowDowngrade = app.getVersion() !== '1.0.0' && !fs.existsSync(INITIAL_VERSION_MIGRATION_FLAG);
    autoUpdater.on('checking-for-update', () => setUpdaterState({ state: 'checking', error: '' }));
    autoUpdater.on('update-available', info => {
      setUpdaterState({ state: 'available', version: String(info?.version || ''), releaseNotes: '', percent: 0, error: '' });
      log(`Доступно обновление SAT LAUNCHER ${info?.version || ''}.`, 'info');
    });
    autoUpdater.on('update-not-available', info => setUpdaterState({ state: 'current', version: String(info?.version || app.getVersion()), percent: 0, error: '' }));
    autoUpdater.on('download-progress', progressInfo => setUpdaterState({ state: 'downloading', version: updaterState.version, percent: Math.max(0, Math.min(100, Number(progressInfo?.percent) || 0)), error: '' }));
    autoUpdater.on('update-downloaded', info => {
      setUpdaterState({ state: 'downloaded', version: String(info?.version || updaterState.version), percent: 100, error: '' });
      log(`Обновление SAT LAUNCHER ${info?.version || updaterState.version} загружено.`, 'info');
      // Clicking the single "Install" button authorizes the complete download + restart flow.
      if (installAfterDownload) {
        installAfterDownload = false;
        setTimeout(() => {
          try { installDownloadedUpdate(); }
          catch {
            setUpdaterState({ state: 'error', error: 'update_install_failed' });
            log('Не удалось установить обновление SAT LAUNCHER.', 'warn');
          }
        }, 0);
      }
    });
    autoUpdater.on('error', error => {
      const isDownloadFailure = ['downloading', 'downloaded'].includes(updaterState.state);
      handleUpdaterFailure(error, isDownloadFailure ? 'update_download_failed' : 'update_check_failed');
    });
    // The user chooses whether to download after seeing the available-version notice.
    // An empty GitHub Releases feed is an ordinary up-to-date state, not an error popup.
    const checkForReleaseUpdate = () => autoUpdater.checkForUpdates().catch(error => {
      handleUpdaterFailure(error, 'update_check_failed');
    });
    setTimeout(checkForReleaseUpdate, 4500).unref?.();
    // Also discover releases published while the launcher is already running.
    const recurringUpdateCheck = setInterval(() => {
      if (['downloading', 'downloaded'].includes(updaterState.state)) return;
      checkForReleaseUpdate();
    }, 6 * 60 * 60 * 1000);
    recurringUpdateCheck.unref?.();
  } catch (error) {
    setUpdaterState({ state: 'error', error: 'updater_unavailable' });
    log('Не удалось инициализировать автоматическое обновление.', 'warn');
  }
}
async function startUpdateDownload() {
  if (!autoUpdaterInstance) throw new Error('Автообновление не настроено в этой сборке.');
  if (!['available', 'error'].includes(updaterState.state)) throw new Error('Сейчас нет доступного для загрузки обновления.');
  setUpdaterState({ state: 'downloading', percent: 0, error: '' });
  try { await autoUpdaterInstance.downloadUpdate(); }
  catch (error) {
    installAfterDownload = false;
    setUpdaterState({ state: 'error', error: 'update_download_failed' });
    log('Не удалось скачать обновление SAT LAUNCHER.', 'warn');
    throw error;
  }
}
function installDownloadedUpdate() {
  if (!autoUpdaterInstance || updaterState.state !== 'downloaded') throw new Error('Обновление ещё не загружено.');
  setUpdaterState({ state: 'installing', percent: 100, error: '' });
  autoUpdaterInstance.quitAndInstall(false, true);
  return true;
}
async function installUpdateFromNotice() {
  if (!autoUpdaterInstance) throw new Error('Автообновление не настроено в этой сборке.');
  if (updaterState.state === 'downloaded') return installDownloadedUpdate();
  if (updaterState.state === 'downloading') return true;
  if (updaterState.state !== 'available') throw new Error('Сейчас нет доступного обновления. Сначала проверь новые версии.');
  installAfterDownload = true;
  try {
    // The update-downloaded event installs only because the user clicked Install.
    await startUpdateDownload();
    return true;
  } catch (error) {
    installAfterDownload = false;
    throw error;
  }
}

ipcMain.handle('app:version', () => app.getVersion());

app.whenReady().then(() => {
  // A secondary process must never create windows or initialize background services.
  if (!hasSingleInstanceLock) return;
  app.setName('SAT LAUNCHER');
  if (process.platform === 'win32') app.setAppUserModelId('com.satlauncher.desktop');
  ensureDirectories();
  createWindow();
  configureAutoUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  log('SAT LAUNCHER запущен.');
  if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  if (getSettings().discordApplicationId) syncDiscordPresence('launcher').catch(() => {});
  // If Discord starts after SAT LAUNCHER, retry in the background without keeping Node alive.
  discordReconnectTimer = setInterval(() => {
    const settings = getSettings();
    if (settings.discordApplicationId && !discordRpcClient) {
      syncDiscordPresence(runningGames.size ? 'game' : 'launcher').catch(() => {});
    }
  }, 15000);
  discordReconnectTimer.unref?.();
});
app.on('before-quit', () => { if (discordReconnectTimer) clearInterval(discordReconnectTimer); stopDiscordPresence(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:maximize', () => { if (!mainWindow) return; mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize(); return mainWindow.isMaximized(); });
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('app:getInit', async () => {
  const settings = getSettings();
  const instances = getInstancesForRenderer();
  const selectedInstance = instances.find(instance => instance.id === settings.selectedInstanceId) || instances[0] || null;
  return { profile: getProfile(), settings, javaPathAvailable: Boolean(settings.javaPath && fs.existsSync(settings.javaPath)), instances, selectedInstance, logs: logs.slice(-200) };
});
ipcMain.handle('app:getVersions', async () => listMinecraftVersions());
ipcMain.handle('loaders:getVersions', async (_e, payload) => getLoaderVersions(String(payload?.loader || ''), String(payload?.minecraftVersion || '')));
ipcMain.handle('loaders:getSupportedGames', async (_e, payload) => getSupportedLoaderGames(String(payload?.loader || '')));
ipcMain.handle('profile:getSkin', async () => getProfileSkin());
ipcMain.handle('assets:getMinecraftTextures', async () => getMinecraftUiTextures());
ipcMain.handle('skin:get', async () => getProfileSkin());
ipcMain.handle('skin:lookupByUsername', async (_e, username) => getSkinByUsername(username));
ipcMain.handle('catalog:craftyTrendingSkins', async (_e, sort) => getCraftyTrendingSkins(sort));
ipcMain.handle('catalog:labySkinTextures', async (_e, payload) => getLabySkinTextureCatalog(payload || {}));
ipcMain.handle('skin:labySkinTexture', async (_e, hash) => getLabySkinTexture(hash));
ipcMain.handle('yandex:status', async () => { const token = readYandexMusicToken(); if (!token) return { connected: false }; try { return await yandexMusicAccountStatus(token); } catch (error) { log(`Сессия Яндекс Музыки требует повторного входа: ${error.message}`, 'warn'); return { connected: false, needsReconnect: true }; } });
ipcMain.handle('yandex:connect', async () => loginYandexMusic());
ipcMain.handle('yandex:disconnect', async () => { clearYandexMusicToken(); return { connected: false }; });
ipcMain.handle('yandex:search', async (_e, query) => searchYandexMusicTracks(query));
ipcMain.handle('yandex:playlists', async () => getYandexMusicPlaylists());
ipcMain.handle('yandex:playlistTracks', async (_e, kind) => getYandexMusicPlaylistTracks(kind));
ipcMain.handle('yandex:wave', async (_e, afterTrackId) => getYandexMyWaveTracks(afterTrackId));
ipcMain.handle('yandex:waveFeedback', async (_e, payload) => sendYandexMyWaveFeedback(payload));
ipcMain.handle('yandex:stream', async (_e, trackId) => getYandexMusicStream(trackId));
ipcMain.handle('skin:save', async (_e, dataUrl) => saveCustomSkin(dataUrl));
ipcMain.handle('skin:applyToInstance', async (_e, instanceId) => { const instance = getInstance(instanceId); if (!instance) throw new Error('Сначала выбери сборку Minecraft.'); return applyOfflineSkinToInstance(instance); });
ipcMain.handle('app:getStatus', async () => {
  const settings = getSettings();
  const instances = getInstancesForRenderer();
  const selectedInstance = instances.find(instance => instance.id === settings.selectedInstanceId) || instances[0] || null;
  return { profile: getProfile(), settings, instances, selectedInstance, running: [...runningGames.keys()] };
});
ipcMain.handle('profile:list', async () => getSavedProfiles());
ipcMain.handle('profile:switch', async (_e, keyValue) => {
  const key = String(keyValue || '');
  const target = getSavedProfiles().find(profile => profile.key === key || profileStorageKey(profile) === key);
  if (!target) throw new Error('Сохранённый профиль не найден.');
  if (target.type === 'microsoft') {
    const tokenPath = profileAuthFile(target);
    const current = getProfile();
    const legacyAllowed = profileStorageKey(current) === profileStorageKey(target) && fs.existsSync(AUTH_FILE);
    if (!fs.existsSync(tokenPath) && !legacyAllowed) throw new Error('Для этого аккаунта нужно повторно войти через Microsoft.');
  }
  activeMinecraftAuthorization = null; activeMsmc = null;
  const profile = { ...target }; delete profile.key;
  saveProfile(profile);
  if (profile.type === 'microsoft') {
    try { await getProfileSkin(); } catch (error) { log(`Официальный скин будет загружен позже: ${error.message}`, 'warn'); }
  }
  log(`Активирован сохранённый профиль: ${profile.username} (${profile.type}).`);
  return getProfile();
});
ipcMain.handle('profile:offline', async (_e, username) => {
  const name = validateOfflineName(username);
  const uuid = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest('hex');
  const profile = { username: name, uuid, type: 'offline', loggedInAt: new Date().toISOString() };
  const perProfileSkin = offlineSkinPathFor(profile);
  if (fs.existsSync(perProfileSkin)) profile.customSkinPath = perProfileSkin;
  else if (fs.existsSync(path.join(SKINS_DIR, 'custom-skin.png'))) profile.customSkinPath = path.join(SKINS_DIR, 'custom-skin.png');
  activeMinecraftAuthorization = null;
  activeMsmc = null;
  // Keep encrypted Microsoft sessions and saved accounts when switching to offline mode.
  saveProfile(profile); log(`Активирован офлайн-профиль: ${name}`); return profile;
});
ipcMain.handle('profile:microsoft', async () => loginMicrosoft());
ipcMain.handle('profile:logout', async () => {
  const current = getProfile();
  activeMinecraftAuthorization = null; activeMsmc = null;
  // Sign out means forget this active launcher profile, not merely change the label to Guest.
  const currentKey = profileStorageKey(current);
  const stored = readJson(PROFILES_FILE, []);
  const remaining = (Array.isArray(stored) ? stored : []).filter(item => profileStorageKey(item) !== currentKey);
  writeJson(PROFILES_FILE, remaining);
  if (current?.type === 'microsoft') {
    try { fs.rmSync(profileAuthFile(current), { force: true }); } catch (error) { log(`Не удалось удалить токен Microsoft: ${error.message}`, 'warn'); }
    // Clear web authentication state as well as the encrypted offline token.
    // This prevents the account chooser from silently reusing a remembered Microsoft session.
    for (const origin of [
      'https://login.live.com', 'https://login.microsoftonline.com', 'https://account.live.com',
      'https://account.microsoft.com', 'https://xboxlive.com', 'https://www.xbox.com', 'https://minecraft.net'
    ]) {
      try { await session.defaultSession.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }); }
      catch (error) { log(`Не удалось очистить веб-сессию ${origin}: ${error.message}`, 'warn'); }
    }
  }
  // Remove legacy auth regardless of the current profile; it is no longer used after logout.
  try { fs.rmSync(AUTH_FILE, { force: true }); } catch {}
  const profile = { username: '', type: 'guest' };
  writeJson(PROFILE_FILE, profile);
  log(`Выполнен выход из профиля ${current?.username || 'гость'}; сохранённые данные активного аккаунта удалены.`);
  return profile;
});
ipcMain.handle('instances:create', async (_e, payload) => {
  const mcVersion = String(payload?.minecraftVersion || '').trim();
  if (!mcVersion) throw new Error('Укажи версию Minecraft.');
  if (!/^[0-9A-Za-z._-]{1,32}$/.test(mcVersion)) throw new Error('Некорректная версия Minecraft.');
  const loader = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'].includes(payload.loader) ? payload.loader : 'vanilla';
  const versionType = ['release', 'snapshot', 'old_beta', 'old_alpha'].includes(payload.versionType) ? payload.versionType : 'release';
  const instance = createInstance({ name: String(payload.name || `${loader} ${mcVersion}`).trim().slice(0, 64), minecraftVersion: mcVersion, versionType, loader, loaderVersion: payload.loaderVersion || '', source: 'manual' });
  return instance;
});
ipcMain.handle('instances:select', async (_e, instanceId) => {
  const instance = getInstance(instanceId); if (!instance) throw new Error('Сборка не найдена.');
  const settings = getSettings(); settings.selectedInstanceId = instanceId; writeJson(SETTINGS_FILE, settings); return instance;
});
ipcMain.handle('instances:delete', async (_e, instanceId) => {
  const instance = getInstance(instanceId); if (!instance) return false;
  if (runningGames.has(instanceId) || launchingGames.has(String(instanceId))) throw new Error('Нельзя удалить сборку, пока Minecraft запущен или подготавливается к запуску.');
  const remaining = getInstances().filter(i => i.id !== instanceId); saveInstances(remaining);
  try { fs.rmSync(instance.root, { recursive: true, force: true }); } catch (e) { log(`Не удалось удалить файлы ${instance.name}: ${e.message}`, 'warn'); }
  const settings = getSettings(); settings.selectedInstanceId = remaining[0]?.id || null; writeJson(SETTINGS_FILE, settings);
  log(`Сборка удалена: ${instance.name}`); return true;
});
ipcMain.handle('instances:installLoader', async (_e, { instanceId, loader, loaderVersion }) => {
  const instance = getInstance(instanceId); if (!instance) throw new Error('Сборка не найдена.');
  return installLoaderForInstance(instance, loader, loaderVersion || '');
});
ipcMain.handle('game:launch', async (_e, instanceId) => launchInstance(instanceId));
ipcMain.handle('cache:clear', async () => clearLauncherCache());
ipcMain.handle('cache:info', () => getLauncherCacheInfo());
ipcMain.handle('logs:clear', async () => clearLauncherLogs());
ipcMain.handle('app:update:status', () => updaterState);
ipcMain.handle('app:update:check', async () => {
  if (!autoUpdaterInstance) return updaterState;
  try {
    await autoUpdaterInstance.checkForUpdates();
  } catch (error) {
    handleUpdaterFailure(error, 'update_check_failed');
  }
  return updaterState;
});
ipcMain.handle('app:update:download', async () => { await startUpdateDownload(); return updaterState; });
ipcMain.handle('app:update:install', () => installUpdateFromNotice());
ipcMain.handle('catalog:searchModrinth', async (_e, payload) => searchModrinth(payload || {}));
ipcMain.handle('catalog:searchSources', async (_e, payload) => searchCatalogSources(payload || {}));
ipcMain.handle('catalog:installExternal', async (_e, payload) => installExternalContent(payload || {}));
ipcMain.handle('catalog:analyzeModrinth', async (_e, payload) => analyzeModrinthCompatibility(payload || {}));
ipcMain.handle('catalog:getModpackContents', async (_e, payload) => getModpackContents(payload || {}));
ipcMain.handle('worlds:listShared', async () => listSharedWorlds());
ipcMain.handle('catalog:labyTrendingClothing', async () => getLabyTrendingClothing());
ipcMain.handle('skin:labyClothingTexture', async (_e, clothingId) => getLabyClothingTexture(clothingId));
ipcMain.handle('catalog:installModrinth', async (_e, payload) => installModrinthProject(payload || {}));
ipcMain.handle('catalog:searchInsideMaps', async (_e, payload) => scrapeInsideMaps(payload || {}));
ipcMain.handle('catalog:searchPlanetMaps', async (_e, payload) => scrapePlanetMinecraftMaps(payload || {}));
ipcMain.handle('catalog:prefetchMaps', async (_e, payload) => prefetchMapSearch(payload || {}));
ipcMain.handle('instances:listContent', async (_e, instanceId) => {
  const instance = getInstance(String(instanceId || ''));
  if (!instance) throw new Error('Сборка не найдена.');
  const listed = listInstanceContent(instance.root);
  return { instanceId: instance.id, name: instance.name, counts: listed.counts, items: listed.items };
});
ipcMain.handle('instances:saveContent', async (_e, payload = {}) => {
  const instance = getInstance(String(payload.instanceId || ''));
  if (!instance) throw new Error('Сборка не найдена.');
  // Minecraft and minecraft-launcher-core expect these directories to be writable.
  // Create them before launch so an otherwise healthy instance never fails because a report directory is absent.
  for (const folder of ['logs','crash-reports','reports','mods','resourcepacks','shaderpacks','config','saves']) { try { fs.mkdirSync(path.join(instance.root, folder), { recursive: true }); } catch (error) { throw new Error(`Не удалось подготовить каталог ${folder}: ${error.message}`); } }
  if (runningGames.has(instance.id)) throw new Error('Нельзя изменять файлы сборки, пока Minecraft запущен. Закрой игру и повтори.');
  const result = removeInstanceContentFiles(instance.root, payload.removeItems || []);
  const folderByType = { mod: 'mods', shader: 'shaderpacks', resourcepack: 'resourcepacks' };
  const removedPaths = new Set(result.removed.map(item => path.resolve(instance.root, folderByType[item.type], item.filename)));
  instance.installedContent = (instance.installedContent || []).filter(entry => !entry.path || !removedPaths.has(path.resolve(entry.path)));
  saveInstance(instance);
  log(`Изменена сборка ${instance.name}: удалено файлов контента ${result.removed.length}.`);
  return { ok: true, removed: result.removed, skipped: result.skipped, counts: result.summary.counts, items: result.summary.items };
});
ipcMain.handle('instances:versionInstalled', async (_e, instanceId) => prepareInstanceVersion(getInstance(instanceId)));
ipcMain.handle('catalog:installPlanetMap', async (_e, payload) => installPlanetMinecraftMap(payload || {}));
ipcMain.handle('catalog:openMapDownload', async (_e, payload) => openMapDownloadWindow(payload || {}));
ipcMain.handle('catalog:installInsideMap', async (_e, payload) => installInsideMap(payload || {}));
ipcMain.handle('maps:importArchive', async (_e, payload) => importMapArchive(payload || {}));
ipcMain.handle('modpack:importFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'SAT / Modrinth pack', extensions: ['satpack','mrpack','zip'] }] });
  if (result.canceled || !result.filePaths[0]) return null;
  const file = result.filePaths[0];
  if (/\.satpack$/i.test(file)) return importInstancePackFromPath(file);
  if (/\.mrpack$/i.test(file)) return installMrpack(file);
  const AdmZip = require('adm-zip');
  let zip; try { zip = new AdmZip(file); } catch { throw new Error('Не удалось открыть ZIP-архив.'); }
  throw new Error('ZIP не содержит sat-launcher-pack.json. Для локальной SAT-сборки используй .satpack, для Modrinth — .mrpack.');
});
ipcMain.handle('instances:importPack', async () => importInstancePack());
ipcMain.handle('instances:diagnoseRepair', async (_e, payload = {}) => inspectAndRepairInstance(payload.instanceId, { repair: Boolean(payload.repair) }));
ipcMain.handle('settings:get', () => getSettings());
ipcMain.handle('discord:sync', async () => syncDiscordPresence(runningGames.size ? 'game' : 'launcher'));
ipcMain.handle('discord:status', () => getDiscordPresenceStatus());
ipcMain.handle('discord:clear', async () => { stopDiscordPresence(); return true; });
ipcMain.handle('settings:update', async (_e, patch) => {
  const old = getSettings();
  const allowed = ['memoryMin', 'memoryMax', 'autoJava', 'javaPath', 'customGameDirectory', 'discordApplicationId', 'discordImageKey', 'closeAfterLaunch', 'theme', 'language', 'uiScale', 'rightRailCollapsed'];
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(patch || {}, key)) old[key] = patch[key];
  old.language = old.language === 'en' ? 'en' : 'ru';
  old.discordApplicationId = String(old.discordApplicationId || '').trim();
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'discordApplicationId')) {
    old.discordPresenceEnabled = Boolean(old.discordApplicationId);
  }
  if (old.discordApplicationId && !/^\d{17,20}$/.test(old.discordApplicationId)) throw new Error('Discord Application ID должен состоять из 17–20 цифр.');
  old.discordImageKey = normalizeDiscordImageKey(old.discordImageKey || 'sat_launcher');
  delete old.satRelayUrl; // Clean up the legacy removed Friends/Relay setting.
  old.uiScale = Math.max(0.85, Math.min(1.3, Number(old.uiScale) || 1.1));
  if (!/^\d+(?:\.\d+)?G$/i.test(old.memoryMin)) old.memoryMin = '2G';
  if (!/^\d+(?:\.\d+)?G$/i.test(old.memoryMax)) old.memoryMax = '6G';
  if (Number.parseFloat(old.memoryMin) > Number.parseFloat(old.memoryMax)) old.memoryMax = old.memoryMin;
  writeJson(SETTINGS_FILE, old);
  try { mainWindow?.webContents.setZoomFactor(old.uiScale); } catch {}
  if (Object.prototype.hasOwnProperty.call(patch || {}, 'discordApplicationId') || Object.prototype.hasOwnProperty.call(patch || {}, 'discordImageKey')) {
    if (!old.discordApplicationId) stopDiscordPresence();
    else await syncDiscordPresence(runningGames.size ? 'game' : 'launcher');
  }
  return old;
});
ipcMain.handle('settings:chooseDirectory', () => chooseDirectory());
ipcMain.handle('settings:chooseJava', async () => {
  const result = await chooseJavaFile(); if (!result) return null;
  const settings = getSettings(); settings.javaPath = result; settings.autoJava = false; writeJson(SETTINGS_FILE, settings); return result;
});
ipcMain.handle('settings:openGameDirectory', async (_e, instanceId) => {
  const instance = getInstance(instanceId) || currentInstance();
  const target = instance?.root || INSTANCES_DIR;
  fs.mkdirSync(target, { recursive: true }); return shell.openPath(target);
});
ipcMain.handle('settings:openLogs', async () => { if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8'); return shell.openPath(LOG_FILE); });
ipcMain.handle('app:getLogs', () => logs.slice(-500));
ipcMain.handle('app:openExternal', async (_e, url) => {
  try {
    const u = new URL(url);
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error('Недопустимая ссылка.');
    if (isSourceRepositoryUrl(u.toString())) throw new Error('Переход на страницу исходного репозитория отключён в лаунчере.');
    await shell.openExternal(u.toString());
    return true;
  } catch (e) { throw new Error(`Не удалось открыть ссылку: ${e.message}`); }
});
