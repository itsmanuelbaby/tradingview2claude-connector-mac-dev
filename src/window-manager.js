'use strict';

// ================================================================
//  window-manager.js — affianca TradingView alla dashboard
//  - lancia TradingView con la porta debug (richiesta dall'MCP)
//  - posiziona la finestra di TradingView accanto alla nostra
//  Posizionare la finestra di un'altra app richiede il permesso
//  "Accessibilità" di macOS (gestito con fallback se assente).
// ================================================================

const { screen } = require('electron');
const { execFile, spawn, execSync } = require('child_process');
const http = require('http');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const HOME = os.homedir();
const DEBUG_PORT = 9222;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Area utile dello schermo principale ──────────────────────────
function workArea() {
  return screen.getPrimaryDisplay().workArea; // {x,y,width,height}
}

// ── Trova TradingView.app ────────────────────────────────────────
function findTradingViewApp() {
  const candidates = [
    '/Applications/TradingView.app',
    path.join(HOME, 'Applications', 'TradingView.app'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  try {
    const found = execSync(
      "mdfind \"kMDItemCFBundleIdentifier == 'com.tradingview.tradingviewapp'\"",
      { encoding: 'utf8' }
    ).trim().split('\n')[0];
    if (found && fs.existsSync(found)) return found;
  } catch (_) {}
  return null;
}

// ── La porta debug risponde con una pagina TradingView? ──────────
function isDebugReady() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: DEBUG_PORT, path: '/json/list', timeout: 1500 },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve(/tradingview/i.test(body)));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// ── Chiude TradingView in modo pulito (via AppleScript) ──────────
function quitTradingView() {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "TradingView" to quit'],
      () => resolve());
  });
}

// ── Lancia TradingView con la porta debug ────────────────────────
function launchTradingView(appPath) {
  try {
    const child = spawn('open',
      ['-a', appPath, '--args', `--remote-debugging-port=${DEBUG_PORT}`],
      { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch (_) {
    return false;
  }
}

// ── Assicura che TradingView sia pronto sulla porta debug ────────
// onStatus(testo) — callback opzionale per aggiornare la UI
async function ensureTradingView(onStatus) {
  if (await isDebugReady()) return { ok: true, alreadyReady: true };

  const appPath = findTradingViewApp();
  if (!appPath) return { ok: false, error: 'not-installed' };

  if (onStatus) onStatus('Chiusura istanza precedente di TradingView…');
  await quitTradingView();
  await delay(1800);

  if (onStatus) onStatus('Avvio di TradingView…');
  launchTradingView(appPath);

  // Attesa pronto (max ~60s)
  for (let i = 0; i < 30; i++) {
    await delay(2000);
    if (await isDebugReady()) return { ok: true };
    if (onStatus) onStatus(`Attendo che TradingView sia pronto… ${(i + 1) * 2}s`);
  }
  return { ok: false, error: 'timeout' };
}

// ── Posiziona la finestra di TradingView ─────────────────────────
// b = {x,y,width,height}. Richiede permesso Accessibilità.
function positionTradingView(b) {
  return new Promise((resolve) => {
    const script =
      'tell application "System Events"\n' +
      '  set tvList to (every process whose name contains "TradingView")\n' +
      '  if (count of tvList) is 0 then return "no-process"\n' +
      '  set tvProc to item 1 of tvList\n' +
      '  set frontmost of tvProc to true\n' +
      '  try\n' +
      `    set position of window 1 of tvProc to {${Math.round(b.x)}, ${Math.round(b.y)}}\n` +
      `    set size of window 1 of tvProc to {${Math.round(b.width)}, ${Math.round(b.height)}}\n` +
      '  on error errMsg number errNum\n' +
      '    return "err:" & errNum\n' +
      '  end try\n' +
      'end tell\n' +
      'return "ok"';

    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      const out = String(stdout || '').trim();
      const errText = String(stderr || '') + out;
      if (/-?1719|not allowed|assistive|-25211/.test(errText)) {
        resolve({ ok: false, error: 'accessibility' });
      } else if (err) {
        resolve({ ok: false, error: 'osascript' });
      } else if (out === 'no-process') {
        resolve({ ok: false, error: 'no-process' });
      } else if (out.startsWith('err:')) {
        resolve({ ok: false, error: out });
      } else {
        resolve({ ok: true });
      }
    });
  });
}

module.exports = {
  workArea,
  findTradingViewApp,
  isDebugReady,
  ensureTradingView,
  positionTradingView,
};
