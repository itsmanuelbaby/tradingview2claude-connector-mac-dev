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

// ── Costanti ─────────────────────────────────────────────────────
const HOME    = os.homedir();
const IS_MAC  = process.platform === 'darwin';
const IS_WIN  = process.platform === 'win32';
const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'TradingView2Claude');
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

// ── Trova TradingView (Mac) ──────────────────────────────────────
async function findTradingView() {
  const staticPaths = [
    '/Applications/TradingView.app',
    path.join(HOME, 'Applications', 'TradingView.app'),
  ];
  for (const p of staticPaths) {
    if (fs.existsSync(p)) return p;
  }
  // mdfind
  const found = await runQ("mdfind \"kMDItemCFBundleIdentifier == 'com.tradingview.tradingviewapp'\"");
  if (found) {
    const first = found.split('\n')[0].trim();
    if (first && fs.existsSync(first)) return first;
  }
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

// ── Step 1: Node.js ──────────────────────────────────────────────
async function step1_nodejs() {
  // Su Mac usiamo node bundled — non dipende da Node di sistema
  const nodeBin = getBundledNodePath();
  if (nodeBin) {
    const v = await runQ(`"${nodeBin}" --version`);
    sendLog(`Node.js bundled ${v} — OK`, mainWin);
    return;
  }

  // Fallback: node di sistema
  const v = await runQ('node --version');
  if (v) {
    sendLog(`Node.js sistema ${v} — OK`, mainWin);
    return;
  }

  // Installa via Homebrew
  sendLog('Installazione Node.js via Homebrew...', mainWin);
  const brew = await runQ('which brew');
  if (brew) {
    await run(brew, ['install', 'node'], { ignoreError: true });
    const v2 = await runQ('node --version');
    if (v2) { sendLog(`Node.js ${v2} installato`, mainWin); return; }
  }

  throw new Error(
    'Node.js non trovato e installazione automatica fallita.\n' +
    'Scaricalo da: https://nodejs.org/\n' +
    'Poi riesegui il Connector.'
  );
}

// ── Step 2: Git ──────────────────────────────────────────────────
async function step2_git() {
  const v = await runQ('git --version');
  if (v) { sendLog('Git già installato', mainWin); return; }

  sendLog('Installazione Git via Homebrew...', mainWin);
  const brew = await runQ('which brew');
  if (brew) {
    await run(brew, ['install', 'git'], { ignoreError: true });
    const v2 = await runQ('git --version');
    if (v2) { sendLog('Git installato', mainWin); return; }
  }

  // Xcode Command Line Tools
  sendLog('Tentativo installazione Xcode CLT...', mainWin);
  await run('xcode-select', ['--install'], { ignoreError: true });
  const v3 = await runQ('git --version');
  if (v3) { sendLog('Git installato (Xcode CLT)', mainWin); return; }

  sendLog('Git non disponibile — continuo comunque', mainWin);
}

// ── Step 3: Claude Code ──────────────────────────────────────────
async function step3_claude() {
  let claudePath = await findClaude();
  if (claudePath) {
    sendLog(`Claude Code già installato: ${claudePath}`, mainWin);
    return claudePath;
  }

  sendLog('Installazione Claude Code in corso...', mainWin);

  // Determina npm
  const npmPaths = [
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
  ];
  let npmBin = null;
  for (const p of npmPaths) {
    if (fs.existsSync(p)) { npmBin = p; break; }
  }
  if (!npmBin) npmBin = await runQ('which npm');
  if (!npmBin) {
    // Usa npm bundled con node bundled
    const nodeBin = getBundledNodePath();
    if (nodeBin) {
      const nodeDir = path.dirname(nodeBin);
      const bundledNpm = path.join(
        app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
        'bundled-node', 'npm_modules', 'bin', 'npm-cli.js'
      );
      if (fs.existsSync(bundledNpm)) {
        await run(nodeBin, [bundledNpm, 'install', '-g', '@anthropic-ai/claude-code'], { ignoreError: false });
      }
    }
  } else {
    await run(npmBin, ['install', '-g', '@anthropic-ai/claude-code'], { ignoreError: false });
  }

  // Riprova a trovare Claude
  await new Promise(r => setTimeout(r, 3000));
  claudePath = await findClaude();
  if (!claudePath) {
    throw new Error(
      'Claude Code non trovato dopo installazione.\n' +
      'Riprova o installalo manualmente con:\n' +
      'npm install -g @anthropic-ai/claude-code'
    );
  }

  sendLog(`Claude Code installato: ${claudePath}`, mainWin);
  return claudePath;
}

// ── Step 4: MCP bundled ──────────────────────────────────────────
async function step4_mcp() {
  const bundledMcp = getBundledMcpPath();
  writeLog(`[step4] bundledMcp: ${bundledMcp}`);
  writeLog(`[step4] bundledMcp exists: ${fs.existsSync(bundledMcp)}`);

  if (!fs.existsSync(bundledMcp)) {
    throw new Error(
      `File MCP bundled non trovati.\n` +
      `Path cercato: ${bundledMcp}\n` +
      `app.isPackaged: ${app.isPackaged}\n` +
      `process.resourcesPath: ${process.resourcesPath}\n` +
      'Reinstalla il software.'
    );
  }

  // Verifica che src/server.js esista nel bundled
  const bundledServer = path.join(bundledMcp, 'src', 'server.js');
  writeLog(`[step4] bundled src/server.js: ${fs.existsSync(bundledServer)}`);

  if (!fs.existsSync(bundledServer)) {
    // Lista contenuto bundled per diagnostica
    try {
      const files = fs.readdirSync(bundledMcp);
      writeLog(`[step4] contenuto bundled-mcp: ${files.join(', ')}`);
    } catch(e) { writeLog(`[step4] errore lettura bundled-mcp: ${e.message}`); }
    throw new Error(
      `src/server.js non trovato nel bundled-mcp.\n` +
      `Path: ${bundledServer}\n` +
      `La build non ha incluso il fork jackson correttamente.`
    );
  }

  // Usa direttamente il bundled-mcp senza copiare nella home
  // Questo garantisce: nessun path hardcoded, nessuna cartella ~/tradingview-mcp
  sendLog('tradingview-mcp bundled — OK', mainWin);
  writeLog(`[step4] MCP path: ${bundledMcp}`);
  return bundledMcp;
}

// ── Step 5: TradingView ──────────────────────────────────────────
async function step5_findtv() {
  sendLog('Ricerca TradingView...', mainWin);
  const p = await findTradingView();
  if (p) {
    sendLog(`TradingView trovato: ${p}`, mainWin);
    writeLog(`[step5] TradingView: ${p}`);
  } else {
    sendLog('TradingView non trovato — installalo da https://www.tradingview.com/desktop/', mainWin);
    writeLog('[step5] TradingView non trovato');
  }
  return p || null;
}

// ── Step 6: Configura MCP in Claude Code ─────────────────────────
async function step6_mcp(claudePath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');
  if (!mcpDir)     throw new Error('Directory MCP non determinata');

  // Trova entry point MCP
  const candidates = [
    path.join(mcpDir, 'src', 'server.js'),
    path.join(mcpDir, 'src', 'index.js'),
    path.join(mcpDir, 'server.js'),
    path.join(mcpDir, 'index.js'),
  ];
  let indexPath = null;
  for (const cp of candidates) {
    if (fs.existsSync(cp)) { indexPath = cp; break; }
  }

  if (!indexPath) {
    writeLog(`[step6] candidates cercati: ${candidates.join(', ')}`);
    throw new Error(
      `File MCP server non trovato.\n` +
      `Directory MCP: ${mcpDir}\n` +
      `Cercati: src/server.js, src/index.js, server.js, index.js`
    );
  }

  writeLog(`[step6] entry point MCP: ${indexPath}`);
  sendLog(`Entry point MCP: ${path.basename(indexPath)}`, mainWin);

  // Usa node bundled se disponibile, altrimenti node di sistema
  const nodeBin = getBundledNodePath() || 'node';
  writeLog(`[step6] node per MCP: ${nodeBin}`);

  // Crea wrapper in HOME (path senza spazi — evita bug di claude mcp add con path che hanno spazi)
  const wrapperPath = path.join(HOME, '.tv2claude_mcp.sh');
  const wrapperContent = `#!/bin/bash\nexec "${nodeBin}" "${indexPath}"\n`;
  fs.writeFileSync(wrapperPath, wrapperContent, { encoding: 'utf8', mode: 0o755 });
  writeLog(`[step6] wrapper MCP creato: ${wrapperPath}`);

  // Rimuovi registrazioni precedenti
  for (const oldName of ['tradingview', 'tradingview-mcp']) {
    await run(claudePath, ['mcp', 'remove', oldName], { cwd: HOME, ignoreError: true });
  }

  // Registra MCP con --scope user → finisce nella sezione globale di ~/.claude.json
  // (senza --scope user viene aggiunto come project config per HOME, invisibile
  //  quando Claude parte da un'altra directory come bundled-mcp)
  await run(
    claudePath,
    ['mcp', 'add', '--scope', 'user', 'tradingview-mcp', '/bin/bash', wrapperPath],
    { cwd: HOME, ignoreError: false }
  );

  // Verifica leggendo ~/.claude.json — controlla che sia nella sezione user (mcpServers)
  const claudeConfigPath = path.join(HOME, '.claude.json');
  let registered = false;
  try {
    const config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
    registered = !!config?.mcpServers?.['tradingview-mcp'];
    writeLog(`[step6] mcpServers in ~/.claude.json: ${JSON.stringify(config?.mcpServers)}`);
  } catch(e) {
    writeLog(`[step6] errore lettura ~/.claude.json: ${e.message}`);
  }

  if (registered) {
    sendLog('Server MCP registrato correttamente ✓', mainWin);
  } else {
    sendLog('ATTENZIONE: tradingview-mcp non trovato in mcpServers di ~/.claude.json', mainWin);
    throw new Error('Registrazione MCP fallita. Controlla il log per dettagli.');
  }
}

// ── Step 7: Launcher Mac ─────────────────────────────────────────
async function step7_launcher(claudePath, tvPath, mcpDir) {
  if (!claudePath) throw new Error('Percorso Claude Code non determinato');

  // Risolvi il percorso reale del Desktop (può essere una symlink a iCloud Drive)
  let desktop = path.join(HOME, 'Desktop');
  try {
    desktop = fs.realpathSync(desktop);
  } catch {
    // Desktop non ancora accessibile (iCloud non sincronizzato) — usa HOME
    desktop = HOME;
  }

  const tvApp = tvPath || '/Applications/TradingView.app';
  const nodeBin = getBundledNodePath() || 'node';

  // Entry point MCP
  const mcpEntry = fs.existsSync(path.join(mcpDir, 'src', 'server.js'))
    ? path.join(mcpDir, 'src', 'server.js')
    : path.join(mcpDir, 'index.js');

  // Wrapper MCP in HOME (path senza spazi — evita bug di claude mcp add con spazi)
  const wrapperPath = path.join(HOME, '.tv2claude_mcp.sh');

  const script = [
    '#!/bin/bash',
    '',
    '# TradingView2Claude Connector Launcher',
    `MCP_DIR="${mcpDir}"`,
    `MCP_ENTRY="${mcpEntry}"`,
    `NODE="${nodeBin}"`,
    `TV_APP="${tvApp}"`,
    `WRAPPER="${wrapperPath}"`,
    '',
    '# Carica i profile shell per avere il PATH corretto (il .command non è login shell)',
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    '[ -f "$HOME/.zprofile" ]     && source "$HOME/.zprofile"     2>/dev/null',
    '[ -f "$HOME/.bash_profile" ] && source "$HOME/.bash_profile" 2>/dev/null',
    '',
    '# Trova Claude Code — cerca in tutti i path noti',
    'CLAUDE=""',
    'for p in \\',
    '  "$HOME/.local/bin/claude" \\',
    '  "$(which claude 2>/dev/null)" \\',
    '  /opt/homebrew/bin/claude \\',
    '  /usr/local/bin/claude \\',
    '  "$HOME/.npm-global/bin/claude" \\',
    '  "$HOME/Library/Application Support/npm/bin/claude" \\',
    '  /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude \\',
    '  /usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude; do',
    '  if [ -n "$p" ] && [ -x "$p" ]; then CLAUDE="$p"; break; fi',
    'done',
    '# Fallback: cerca il binario macOS in claude-code (installazione via Claude.app)',
    'if [ -z "$CLAUDE" ] || [ ! -x "$CLAUDE" ]; then',
    '  CLAUDE_CODE_DIR="$HOME/Library/Application Support/Claude/claude-code"',
    '  if [ -d "$CLAUDE_CODE_DIR" ]; then',
    '    CLAUDE=$(find "$CLAUDE_CODE_DIR" -path "*/MacOS/claude" -type f 2>/dev/null | sort -V | tail -1)',
    '  fi',
    'fi',
    'if [ -z "$CLAUDE" ] || [ ! -x "$CLAUDE" ]; then',
    '  echo "  ERRORE: Claude Code non trovato."',
    '  echo "  Scaricalo da: https://claude.ai/download"',
    '  exit 1',
    'fi',
    '',
    'clear',
    'echo ""',
    'echo "  +==============================================+"',
    'echo "  |      TradingView2Claude Connector          |"',
    'echo "  +==============================================+"',
    'echo ""',
    '',
    '# Verifica licenza attiva',
    'LICENSE_FILE="$HOME/.tv2claude_license"',
    'if [ ! -f "$LICENSE_FILE" ]; then',
    '  echo "  ✕ Licenza non trovata."',
    '  echo "  Apri TradingView2Claude Connector per attivarla."',
    '  exit 1',
    'fi',
    'LICENSE_KEY=$(grep -o \'"key":"[^"]*"\' "$LICENSE_FILE" | cut -d\'"\' -f4)',
    'if [ -z "$LICENSE_KEY" ]; then',
    '  echo "  ✕ File licenza non valido. Reinstalla TradingView2Claude Connector."',
    '  exit 1',
    'fi',
    'UUID=$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | grep IOPlatformUUID | grep -o \'"[A-F0-9-]*"\' | tr -d \'"\')',
    'if [ -n "$UUID" ]; then',
    '  MACHINE_ID=$(echo -n "$UUID" | openssl dgst -sha256 | awk \'{print $2}\' | cut -c1-32)',
    'else',
    '  MACHINE_ID=$(echo -n "$(hostname)$(whoami)" | openssl dgst -sha256 | awk \'{print $2}\' | cut -c1-32)',
    'fi',
   `GAS_URL="${GAS_URL}"`,
    'LIC_RESPONSE=$(curl -s --max-time 10 -L -X POST "$GAS_URL" \\',
    '  -H "Content-Type: application/json" \\',
    '  -d "{\\"action\\":\\"check-license\\",\\"license_key\\":\\"$LICENSE_KEY\\",\\"machine_id\\":\\"$MACHINE_ID\\"}" 2>/dev/null)',
    'if [ -z "$LIC_RESPONSE" ]; then',
    '  echo "  ⚠  Impossibile verificare la licenza (nessuna connessione) — avvio offline"',
    'elif echo "$LIC_RESPONSE" | grep -q \'"ok":true\'; then',
    '  echo "  ✓  Licenza attiva"',
    'else',
    '  echo "  ✕  Licenza non attiva."',
    '  echo "  Contatta il supporto per assistenza."',
    '  exit 1',
    'fi',
    'echo ""',
    '',
    '# Crea wrapper MCP (path senza spazi per compatibilità claude mcp add)',
    'cat > "$WRAPPER" << \'WEOF\'',
    '#!/bin/bash',
    `exec "${nodeBin}" "${mcpEntry}"`,
    'WEOF',
    'chmod +x "$WRAPPER"',
    '',
    '# Re-registra MCP ad ogni avvio con --scope user (visibile da qualsiasi directory)',
    '"$CLAUDE" mcp remove --scope user tradingview 2>/dev/null',
    '"$CLAUDE" mcp remove --scope user tradingview-mcp 2>/dev/null',
    '"$CLAUDE" mcp add --scope user tradingview-mcp /bin/bash "$WRAPPER"',
    'echo "  MCP registrato: $("$CLAUDE" mcp list 2>/dev/null | grep tradingview || echo "NON trovato — controlla il log")"',
    '',
    'echo "  [1/3] Chiusura TradingView precedente..."',
    'pkill -f "TradingView" 2>/dev/null',
    'sleep 2',
    '',
    'echo "  [2/3] Apertura TradingView con porta debug..."',
    'if [ -d "$TV_APP" ]; then',
    '  open "$TV_APP" --args --remote-debugging-port=9222',
    'else',
    '  echo "  ATTENZIONE: TradingView non trovato in $TV_APP"',
    '  echo "  Installalo da: https://www.tradingview.com/desktop/"',
    'fi',
    '',
    '# Attendi che TradingView sia pronto su porta 9222 (max 60s)',
    'echo "  Attendo che TradingView carichi..."',
    'WAITED=0',
    'until curl -s http://localhost:9222/json/list | grep -q "tradingview" 2>/dev/null; do',
    '  sleep 2',
    '  WAITED=$((WAITED+2))',
    '  if [ $WAITED -ge 60 ]; then',
    '    echo "  ATTENZIONE: TradingView non risponde su porta 9222 dopo 60s"',
    '    echo "  Assicurati che TradingView Desktop sia aperto su un grafico"',
    '    break',
    '  fi',
    '  echo "  ...${WAITED}s"',
    'done',
    'echo "  TradingView pronto!"',
    '',
    'echo "  [3/3] Avvio Claude Code..."',
    'echo ""',
    'echo "  Digita il tuo prompt e premi INVIO"',
    'echo "  Esempio: Analizza il grafico attuale, dimmi supporti e resistenze"',
    'echo ""',
    `cd "${mcpDir}"`,
    '"$CLAUDE"',
  ].join('\n');

  const launcherPath = path.join(desktop, 'Avvia TradingView2Claude.command');
  fs.writeFileSync(launcherPath, script, { encoding: 'utf8' });
  fs.chmodSync(launcherPath, 0o755);

  sendLog(`Launcher creato: ${launcherPath}`, mainWin);
  writeLog(`[step7] launcher: ${launcherPath}`);
}

// ── Pipeline principale ──────────────────────────────────────────
async function runInstall() {
  const steps = [
    { label: 'Verifica sistema',  fn: step0_sistema },
    { label: 'Node.js',           fn: step1_nodejs  },
    { label: 'Git',               fn: step2_git     },
    { label: 'Claude Code',       fn: step3_claude  },
    { label: 'TradingView MCP',   fn: step4_mcp     },
    { label: 'Rileva TradingView',fn: step5_findtv  },
    { label: 'Configura MCP',     fn: null          },
    { label: 'Crea launcher',     fn: null          },
  ];

  const total = steps.length;
  let claudePath, mcpDir, tvPath;

  function stepEvent(index, status) {
    mainWin?.webContents.send('step', { index, status });
  }

  try {
    for (let i = 0; i < total; i++) {
      stepEvent(i, 'running');
      try {
        if (i === 0) await step0_sistema();
        else if (i === 1) await step1_nodejs();
        else if (i === 2) await step2_git();
        else if (i === 3) claudePath = await step3_claude();
        else if (i === 4) mcpDir = await step4_mcp();
        else if (i === 5) tvPath = await step5_findtv();
        else if (i === 6) await step6_mcp(claudePath, mcpDir);
        else if (i === 7) await step7_launcher(claudePath, tvPath, mcpDir);
        stepEvent(i, 'done');
        mainWin?.webContents.send('progress', Math.round((i + 1) / total * 100));
      } catch(e) {
        writeLog(`[ERRORE step ${i}] ${e.stack || e.message}`);
        stepEvent(i, 'error');
        mainWin?.webContents.send('done', { ok: false, msg: e.message });
        return;
      }
    }
    mainWin?.webContents.send('done', { ok: true });
  } catch(e) {
    writeLog(`[ERRORE fatale] ${e.stack || e.message}`);
    mainWin?.webContents.send('done', { ok: false, msg: e.message });
  }
}

// ── IPC handlers ─────────────────────────────────────────────────
ipcMain.on('start-install', () => { runInstall(); });
ipcMain.on('open-url', (_, url) => { shell.openExternal(url); });

// Apre il launcher .command sul Desktop
ipcMain.on('open-launcher', () => {
  let desktopDir = path.join(HOME, 'Desktop');
  try { desktopDir = fs.realpathSync(desktopDir); } catch { desktopDir = HOME; }
  const launcherPath = path.join(desktopDir, 'Avvia TradingView2Claude.command');
  if (fs.existsSync(launcherPath)) {
    shell.openPath(launcherPath);
  } else {
    writeLog('[open-launcher] file non trovato: ' + launcherPath);
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
      saveLicense({ key });
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
    const res = await apiPost({
      action: 'check',
      license_key: saved.key,
      machine_id: getMachineId()
    });
    writeLog(`[license] check response: ${JSON.stringify(res)}`);
    if (res?.ok) {
      event.sender.send('screen', { name: 'install', data: { name: res.customer_name } });
    } else {
      clearLicense();
      event.sender.send('screen', { name: 'license' });
    }
  } catch(e) {
    writeLog(`[license] check error: ${e.message}`);
    // In caso di errore di rete mostra schermata licenza
    event.sender.send('screen', { name: 'license' });
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

// ── App lifecycle ────────────────────────────────────────────────
app.whenReady().then(() => {
  initLog();
  writeLog('=== APP AVVIATA ===');
  writeLog(`Versione: ${app.getVersion()}`);
  writeLog(`Architettura: ${process.arch}`);
  createWindow();
  app.on('activate', () => { if (!mainWin) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
