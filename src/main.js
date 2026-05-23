'use strict';

// ================================================================
//  TradingView2Claude Connector — main.js (MAC ONLY)
//  Self-contained: bundled-mcp incluso nel .app, nessuna dipendenza esterna
// ================================================================

const { app, BrowserWindow, ipcMain, shell, net } = require('electron');
const path   = require('path');
const { spawn, exec } = require('child_process');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const claudeEngine = require('./claude-engine');

// Porta debug: espone il TradingView incorporato all'MCP (server.js)
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// ── Costanti ─────────────────────────────────────────────────────
const HOME    = os.homedir();
const IS_MAC  = process.platform === 'darwin';
const IS_WIN  = process.platform === 'win32';
const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'TradingView2Claude Dev');
const LOG_FILE = path.join(LOG_DIR, 'installer.log');

// ── Logger ───────────────────────────────────────────────────────
function initLog() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch(_) {}
}

function writeLog(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch(_) {}
}

function sendLog(msg, win) {
  writeLog(msg);
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', msg);
  }
}

// ── Path bundled-mcp ─────────────────────────────────────────────
function getBundledMcpPath() {
  let p = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-mcp')
    : path.join(__dirname, '..', 'bundled-mcp');
  try { p = fs.realpathSync(p); } catch(_) {}
  return p;
}

// ── Path bundled-node ────────────────────────────────────────────
function getBundledNodePath() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  let base = app.isPackaged
    ? path.join(process.resourcesPath, 'bundled-node')
    : path.join(__dirname, '..', 'bundled-node');
  try { base = fs.realpathSync(base); } catch(_) {}
  const nodeBin = path.join(base, `node-${arch}`);
  return fs.existsSync(nodeBin) ? nodeBin : null;
}

// ── Helper: run processo ─────────────────────────────────────────
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const { cwd, ignoreError, env } = opts;
    const mergedEnv = { ...process.env, ...env };
    const child = spawn(cmd, args, {
      cwd: cwd || HOME,
      shell: false,
      env: mergedEnv,
    });
    let stdout = '', stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('close', code => {
      writeLog(`[run] ${cmd} ${args.join(' ')} → exit ${code}`);
      if (stderr) writeLog(`[stderr] ${stderr.trim()}`);
      if (code !== 0 && !ignoreError) {
        reject(new Error(`${cmd} uscito con codice ${code}\nstderr: ${stderr}\nstdout: ${stdout}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.on('error', err => {
      writeLog(`[run error] ${cmd}: ${err.message}`);
      if (!ignoreError) reject(err);
      else resolve('');
    });
  });
}

function runQ(cmd, timeoutMs = 10000) {
  return new Promise(resolve => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// ── Finestra principale ──────────────────────────────────────────
let mainWin = null;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 820, height: 640,
    resizable: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWin.loadFile(path.join(__dirname, 'index.html'));
  mainWin.on('closed', () => { mainWin = null; });
}

// ── Finestra Dashboard (nuovo prodotto) ──────────────────────────
let dashWin = null;

function createDashboardWindow() {
  dashWin = new BrowserWindow({
    width: 1320, height: 850,
    minWidth: 900, minHeight: 600,
    frame: false,
    backgroundColor: '#0D0D0D',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
  });
  dashWin.loadFile(path.join(__dirname, 'dashboard.html'));
  dashWin.on('closed', () => { dashWin = null; });
}

// Fase 3 — TradingView è incorporato nella dashboard (vedi dashboard.html):
// nessun posizionamento di finestre, nessun permesso Accessibilità.

// ── Trova Claude (Mac) ───────────────────────────────────────────
async function findClaude() {
  // 1. Installazione nativa ufficiale (~/.local/bin)
  const localBin = path.join(HOME, '.local', 'bin', 'claude');
  if (fs.existsSync(localBin)) return localBin;
  // 2. Claude Code CLI (npm/homebrew)
  const npmPaths = [
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(HOME, '.npm-global', 'bin', 'claude'),
    path.join(HOME, 'Library', 'Application Support', 'npm', 'bin', 'claude'),
  ];
  for (const p of npmPaths) {
    if (fs.existsSync(p)) return p;
  }
  // 3. which claude
  const w = await runQ('which claude');
  if (w && fs.existsSync(w)) return w;
  return null;
}

// ── Licenze ──────────────────────────────────────────────────────
function getMachineId() {
  try {
    const out = require('child_process').execSync(
      'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
      { encoding: 'utf8', timeout: 5000 }
    );
    const m = out.match(/"([A-F0-9-]{36})"/i);
    if (m) return crypto.createHash('sha256').update(m[1]).digest('hex').substring(0, 32);
  } catch(_) {}
  return crypto.createHash('sha256').update(os.hostname() + os.userInfo().username).digest('hex').substring(0, 32);
}

const GAS_URL = 'https://script.google.com/macros/s/AKfycbyXx0246ZvZtieTHHLUgsG4bbZirOVMGnDgT788bodMVkwjY_6Pnusho2IAL3YSrZSW/exec';
const API_TIMEOUT_MS = 15000;

async function apiPost(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    // net.fetch usa lo stack di rete nativo di Electron (richiesto nel main process)
    const res = await net.fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text }; }
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout connessione (15s) — riprova');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const LICENSE_FILE = path.join(HOME, '.tv2claude_license');
function saveLicense(data) { try { fs.writeFileSync(LICENSE_FILE, JSON.stringify(data)); } catch(_) {} }
function loadLicense() { try { return JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')); } catch { return null; } }
function clearLicense() { try { fs.unlinkSync(LICENSE_FILE); } catch(_) {} }

// ── IPC: Licenza ─────────────────────────────────────────────────
// check-license gestito da ipcMain.on più sotto

// activate-license gestito da ipcMain.on più sotto

// deactivate gestito lato admin

// ── IPC: Log ─────────────────────────────────────────────────────
ipcMain.handle('get-log', () => {
  try { return fs.readFileSync(LOG_FILE, 'utf8'); } catch { return ''; }
});

ipcMain.handle('open-log', () => {
  shell.openPath(LOG_FILE);
});

// ── Step 0: Info sistema ─────────────────────────────────────────
async function step0_sistema() {
  initLog();
  writeLog('=== NUOVA INSTALLAZIONE ===');
  writeLog(`App versione: ${app.getVersion()}`);
  writeLog(`app.isPackaged: ${app.isPackaged}`);
  writeLog(`process.resourcesPath: ${process.resourcesPath}`);
  writeLog(`macOS: ${os.release()}`);
  writeLog(`Architettura: ${process.arch}`);
  writeLog(`HOME: ${HOME}`);
  writeLog(`bundled-mcp path: ${getBundledMcpPath()}`);
  writeLog(`bundled-node path: ${getBundledNodePath() || 'non trovato'}`);

  sendLog(`Sistema: macOS ${process.arch} (${os.release()})`, mainWin);
  const nodeBin = getBundledNodePath();
  if (nodeBin) {
    const v = await runQ(`"${nodeBin}" --version`);
    sendLog(`Node.js bundled: ${v || 'errore lettura versione'}`, mainWin);
  } else {
    const v = await runQ('node --version');
    sendLog(`Node.js runtime: ${v || 'non trovato'}`, mainWin);
  }
}

// ── Step 3: Claude Code ──────────────────────────────────────────
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) {
    sendLog(`Claude Code già installato: ${claudePath}`, mainWin);
    return claudePath;
  }

  sendLog('Installazione di Claude Code in corso...', mainWin);

  // Installer nativo ufficiale: scarica un binario autonomo in ~/.local/bin.
  // Non richiede né Node.js né npm — funziona su qualunque Mac.
  const safeEnv = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:'
        + (process.env.PATH || ''),
  };
  try {
    await run('/bin/bash',
      ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'],
      { cwd: HOME, env: safeEnv, ignoreError: false });
  } catch (e) {
    writeLog(`[step3] installer nativo: ${e.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));
  claudePath = await findClaude();
  if (claudePath) {
    sendLog(`Claude Code installato: ${claudePath}`, mainWin);
    return claudePath;
  }

  throw new Error(
    'Non è stato possibile installare Claude Code automaticamente.\n\n' +
    'Apri il Terminale, incolla questo comando e premi Invio:\n' +
    '  curl -fsSL https://claude.ai/install.sh | bash\n\n' +
    'Al termine, torna qui e premi "Riprova".'
  );
}

// ── Step: configura l'assistente (registra l'MCP bundled) ────────
async function step_assistant(claudePath) {
  const bundledMcp = getBundledMcpPath();
  const serverJs = path.join(bundledMcp, 'src', 'server.js');

  if (!fs.existsSync(serverJs)) {
    // Modalità sviluppo (npm start): MCP non incluso — si usa la
    // configurazione MCP già presente. Nessun errore.
    sendLog('Assistente: uso la configurazione esistente', mainWin);
    writeLog(`[assistant] MCP bundled assente (${serverJs}) — skip`);
    return;
  }
  if (!claudePath) throw new Error('Claude Code non disponibile');

  const nodeBin = getBundledNodePath() || 'node';
  const wrapperPath = path.join(HOME, '.tv2claude_mcp.sh');
  fs.writeFileSync(wrapperPath,
    `#!/bin/bash\nexec "${nodeBin}" "${serverJs}"\n`,
    { encoding: 'utf8', mode: 0o755 });
  writeLog(`[assistant] wrapper MCP: ${wrapperPath}`);

  for (const old of ['tradingview', 'tradingview-mcp']) {
    await run(claudePath, ['mcp', 'remove', '--scope', 'user', old],
      { cwd: HOME, ignoreError: true });
  }
  await run(claudePath,
    ['mcp', 'add', '--scope', 'user', 'tradingview-mcp', '/bin/bash', wrapperPath],
    { cwd: HOME, ignoreError: false });

  sendLog('Assistente di mercato configurato ✓', mainWin);
}

// ── Pipeline di setup ────────────────────────────────────────────
async function runInstall() {
  function stepEvent(i, s) { mainWin?.webContents.send('step', { index: i, status: s }); }
  function progress(p)     { mainWin?.webContents.send('progress', p); }

  try {
    stepEvent(0, 'running');
    await step0_sistema();
    stepEvent(0, 'done'); progress(33);

    stepEvent(1, 'running');
    const claudePath = await step3_claude();
    stepEvent(1, 'done'); progress(66);

    stepEvent(2, 'running');
    await step_assistant(claudePath);
    stepEvent(2, 'done'); progress(100);

    mainWin?.webContents.send('done', { ok: true });
  } catch (e) {
    writeLog(`[ERRORE setup] ${e.stack || e.message}`);
    mainWin?.webContents.send('done', { ok: false, msg: e.message });
  }
}

// ── Verifica se il setup è già completo ──────────────────────────
async function isSetupComplete() {
  const claude = await findClaude();
  if (!claude) return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    return !!(cfg && cfg.mcpServers && cfg.mcpServers['tradingview-mcp']);
  } catch {
    return false;
  }
}

// ── Verifica licenza all'avvio (con tolleranza offline) ──────────
// Ritorna: 'valid' | 'suspended' | 'offline'
async function verifyLicenseStatus(key) {
  try {
    const res = await apiPost({ action: 'validate', license_key: key });
    if (res && res.ok) return 'valid';
    return 'suspended';
  } catch (e) {
    writeLog(`[license] verifica offline: ${e.message}`);
    return 'offline';
  }
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.on('start-install', () => { runInstall(); });
ipcMain.on('open-url', (_, url) => { shell.openExternal(url); });

// Setup completato → apre la dashboard e chiude la finestra di setup
ipcMain.on('open-dashboard', () => {
  createDashboardWindow();
  if (mainWin && !mainWin.isDestroyed()) mainWin.close();
});

// ── Report diagnostico ───────────────────────────────────────────
async function generateDiagnosticReport() {
  const L = [];
  L.push('═══ TradingView2Claude Connector — Report Diagnostico ═══');
  L.push('Generato: ' + new Date().toISOString().replace('T', ' ').slice(0, 19));
  L.push('App versione: ' + app.getVersion());
  L.push(`Sistema: macOS ${os.release()} ${process.arch}`);
  L.push('');
  L.push('── Claude Code ──');
  const claudePath = await findClaude();
  L.push('Binario: ' + (claudePath || 'NON TROVATO'));
  L.push('');
  L.push('── MCP ──');
  let mcpReg = false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    mcpReg = !!(cfg && cfg.mcpServers && cfg.mcpServers['tradingview-mcp']);
  } catch (_) {}
  L.push('tradingview-mcp registrato: ' + (mcpReg ? 'sì' : 'no'));
  L.push('Wrapper ~/.tv2claude_mcp.sh: '
       + (fs.existsSync(path.join(HOME, '.tv2claude_mcp.sh')) ? 'sì' : 'no'));
  L.push('');
  L.push('── TradingView (porta debug 9222) ──');
  const tvUp = await new Promise(r => {
    const http = require('http');
    const req = http.get({host:'127.0.0.1', port:9222, path:'/json/version', timeout:1500},
      res => { res.resume(); r(true); });
    req.on('error', () => r(false));
    req.on('timeout', () => { req.destroy(); r(false); });
  });
  L.push('Raggiungibile: ' + (tvUp ? 'sì' : 'no'));
  L.push('');
  L.push('── Licenza ──');
  L.push('File presente: ' + (fs.existsSync(LICENSE_FILE) ? 'sì' : 'no')
       + '  (chiave non inclusa per privacy)');
  L.push('');
  L.push('── Vault memoria ──');
  try {
    const vault = path.join(HOME, 'Documents', 'TradingView2Claude Vault');
    if (fs.existsSync(vault)) {
      L.push('Cartella: ' + vault);
      const adir = path.join(vault, 'Analisi');
      const nNotes = fs.existsSync(adir)
        ? fs.readdirSync(adir).filter(f => f.endsWith('.md')).length : 0;
      L.push('Note di analisi: ' + nNotes);
      const cnt = (f) => {
        try { return fs.readFileSync(path.join(vault, f), 'utf8')
                       .split('\n').filter(l => l.startsWith('- ')).length; }
        catch { return 0; }
      };
      L.push('Lezioni: ' + cnt('Lezioni.md'));
      L.push('Previsioni: ' + cnt('Previsioni.md'));
    } else {
      L.push('Vault non ancora creato');
    }
  } catch (e) { L.push('Errore lettura vault: ' + e.message); }

  function tailLog(file, n) {
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      return lines.slice(-n).join('\n');
    } catch { return '(non disponibile)'; }
  }
  L.push('');
  L.push('── Ultime righe del log installer ──');
  L.push(tailLog(LOG_FILE, 80));
  L.push('');
  L.push('── Ultime righe del log chat ──');
  L.push(tailLog(path.join(LOG_DIR, 'chat.log'), 80));

  let desktop = path.join(HOME, 'Desktop');
  try { desktop = fs.realpathSync(desktop); } catch { desktop = HOME; }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const reportPath = path.join(desktop, `TradingView2Claude-Report-${stamp}.txt`);
  fs.writeFileSync(reportPath, L.join('\n'));
  return reportPath;
}

ipcMain.on('diag:generate', async (event) => {
  try {
    const p = await generateDiagnosticReport();
    shell.showItemInFolder(p);
    if (!event.sender.isDestroyed()) event.sender.send('diag:done', { ok: true, path: p });
  } catch (e) {
    writeLog('[diag] errore: ' + e.message);
    if (!event.sender.isDestroyed()) event.sender.send('diag:done', { ok: false, error: e.message });
  }
});

// Handler 'activate' — chiamato dalla UI con ipc.send('activate', {key})
ipcMain.on('activate', async (event, { key }) => {
  writeLog(`[license] activate richiesto per key: ${key}`);
  try {
    const res = await apiPost({
      action: 'activate',
      license_key: key,
      machine_id: getMachineId(),
      machine_info: `${os.platform()} ${os.arch()} ${os.hostname()}`
    });
    writeLog(`[license] activate response: ${JSON.stringify(res)}`);
    if (res?.ok) {
      saveLicense({ key, customer_name: res.customer_name || '' });
      event.sender.send('lic-result', { ok: true, customer_name: res.customer_name || 'Cliente' });
    } else {
      event.sender.send('lic-result', { ok: false, error: res?.error || 'Chiave non valida' });
    }
  } catch(e) {
    writeLog(`[license] activate error: ${e.message}`);
    event.sender.send('lic-result', { ok: false, error: `Connessione fallita: ${e.message}` });
  }
});

// Handler 'check-license' — chiamato dalla UI con ipc.send('check-license')
ipcMain.on('check-license', async (event) => {
  writeLog('[license] check-license richiesto');
  const saved = loadLicense();
  if (!saved?.key) {
    writeLog('[license] nessuna licenza salvata — mostra schermata licenza');
    event.sender.send('screen', { name: 'license' });
    return;
  }
  try {
    const res = await apiPost({ action: 'validate', license_key: saved.key });
    writeLog(`[license] check response: ${JSON.stringify(res)}`);
    if (res?.ok) {
      event.sender.send('screen', { name: 'install', data: { name: res.customer_name } });
    } else {
      // Licenza non attiva (es. sospesa): NON cancellare la chiave salvata —
      // se viene riattivata, l'utente non deve reinserirla da capo.
      event.sender.send('screen', { name: 'license', notice:
        'La licenza non risulta attiva. Se è stata appena riattivata, chiudi e riapri l\'app.' });
    }
  } catch(e) {
    writeLog(`[license] check error (offline): ${e.message}`);
    // Offline ma con licenza salvata → tolleranza: procedi al setup
    event.sender.send('screen', { name: 'install', data: { name: saved.customer_name || '' } });
  }
});

// Handler 'get-version'
ipcMain.on('get-version', (event) => {
  event.sender.send('version', app.getVersion());
});

// Handler 'close-app'
ipcMain.on('close-app', () => {
  app.quit();
});

// ── IPC: Chat dashboard ──────────────────────────────────────────
// La UI invia 'chat:send' con il testo; il motore risponde in streaming.
ipcMain.on('chat:send', (event, text) => {
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  claudeEngine.ask(String(text || ''), {
    onText:  (t)     => send('claude:text', t),
    onTool:  (label) => send('claude:tool', label),
    onError: (msg)   => send('claude:error', msg),
    onDone:  ()      => send('claude:done'),
  });
});

// Azzera la conversazione corrente (per una "nuova chat")
ipcMain.on('chat:reset', () => { claudeEngine.reset(); });

// Cambia il modello AI (opus / sonnet / haiku)
ipcMain.on('chat:set-model', (_e, model) => { claudeEngine.setModel(model); });

// ── App lifecycle ────────────────────────────────────────────────
app.whenReady().then(async () => {
  initLog();
  writeLog('=== APP AVVIATA ===');
  writeLog(`Versione: ${app.getVersion()}`);
  writeLog(`Architettura: ${process.arch}`);
  try { require('./memory').ensureVault(); } catch (_) {}

  // Flusso di avvio: dashboard solo se licenza valida e setup completo,
  // altrimenti schermata di setup/licenza.
  let goDashboard = false;
  const lic = loadLicense();
  if (lic && lic.key) {
    const status = await verifyLicenseStatus(lic.key);
    writeLog(`[avvio] stato licenza: ${status}`);
    if (status !== 'suspended' && await isSetupComplete()) {
      goDashboard = true;
    }
  }

  if (goDashboard) {
    writeLog('[avvio] → dashboard');
    createDashboardWindow();
  } else {
    writeLog('[avvio] → setup/licenza');
    createWindow();
  }

  app.on('activate', () => {
    if (!mainWin && !dashWin) createDashboardWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
