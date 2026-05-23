'use strict';

// ================================================================
//  claude-engine.js — pilota Claude Code in modalità headless
//  Spawna il binario `claude` con --output-format stream-json,
//  intercetta lo streaming e lo inoltra alla UI tramite callback.
//  Il cliente usa il SUO abbonamento (nessuna chiave API).
// ================================================================

const { spawn, execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const memory = require('./memory');

const HOME = os.homedir();
const LOG_DIR  = path.join(HOME, 'Library', 'Logs', 'TradingView2Claude Dev');
const LOG_FILE = path.join(LOG_DIR, 'chat.log');
function personaFileFor(lang) {
  const fname = lang === 'en' ? 'persona-en.txt' : 'persona.txt';
  return path.join(__dirname, fname);
}

// Timeout di sicurezza per una singola risposta (analisi con più tool = lente)
const TURN_TIMEOUT_MS = 180000;

// ── Stato conversazione (una sessione per avvio app) ─────────────
let sessionId = null;

// Modello AI in uso (opus = massima qualità, default)
let currentModel = 'opus';
function setModel(m) {
  if (m === 'opus' || m === 'sonnet' || m === 'haiku') {
    currentModel = m;
    log(`Modello impostato: ${m}`);
  }
}

// Lingua dell'assistente (it default)
let currentLang = 'it';
function setLang(l) {
  if (l === 'it' || l === 'en') {
    currentLang = l;
    log(`Lingua impostata: ${l}`);
  }
}

// ── Log diagnostico ──────────────────────────────────────────────
function log(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// ── Trova il binario `claude` (universale) ───────────────────────
function findClaudeBinary() {
  const candidates = [
    path.join(HOME, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(HOME, '.npm-global', 'bin', 'claude'),
    path.join(HOME, 'Library', 'Application Support', 'npm', 'bin', 'claude'),
    '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  // which claude
  try {
    const w = execSync('which claude', { encoding: 'utf8' }).trim();
    if (w && fs.existsSync(w)) return w;
  } catch (_) {}
  // Fallback: installazione via Claude.app (binario macOS in claude-code)
  const ccDir = path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    if (fs.existsSync(ccDir)) {
      const found = execSync(
        `find "${ccDir}" -path "*/MacOS/claude" -type f 2>/dev/null | sort -V | tail -1`,
        { encoding: 'utf8' }
      ).trim();
      if (found && fs.existsSync(found)) return found;
    }
  } catch (_) {}
  return null;
}

// ── PATH robusto: claude ha bisogno di node nel PATH ─────────────
function buildEnv() {
  const extra = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(HOME, '.local', 'bin'),
    '/usr/bin', '/bin',
  ];
  const current = process.env.PATH || '';
  return Object.assign({}, process.env, {
    PATH: extra.join(':') + (current ? ':' + current : ''),
  });
}

// ── Etichette amichevoli per gli strumenti TradingView ───────────
function friendlyTool(name) {
  if (!name) return 'Sto consultando TradingView…';
  const n = String(name).replace('mcp__tradingview-mcp__', '');
  if (/screenshot|capture/.test(n))               return 'Sto osservando il grafico…';
  if (/^chart_set|set_symbol|set_timeframe|scroll/.test(n)) return 'Sto aggiornando il grafico…';
  if (/^chart_get|get_state|visible_range/.test(n)) return 'Sto leggendo il grafico…';
  if (/quote|symbol_info|^depth/.test(n))         return 'Sto controllando le quotazioni…';
  if (/^data_get/.test(n))                        return 'Sto analizzando i dati…';
  if (/indicator|study/.test(n))                  return 'Sto leggendo gli indicatori…';
  if (/symbol_search|watchlist/.test(n))          return 'Sto cercando il simbolo…';
  if (/draw/.test(n))                             return 'Sto disegnando sul grafico…';
  if (/alert/.test(n))                            return 'Sto gestendo gli alert…';
  if (/pine/.test(n))                             return 'Sto lavorando sullo script…';
  if (/replay/.test(n))                           return 'Sto usando la modalità replay…';
  return 'Sto consultando TradingView…';
}

// ── Rimuove dal testo le righe [LEZIONE] e [PREVISIONE] ──────────
// (vengono salvate nel vault, non mostrate in chat)
function stripLessons(text) {
  return String(text || '').replace(/^[ \t]*\[(LEZIONE|PREVISIONE)\][^\n]*\n?/gim, '');
}

// ── Interpreta una riga NDJSON dello stream ──────────────────────
function handleLine(line, state, handlers) {
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }

  // init di sessione → cattura session_id
  if (msg.type === 'system' && msg.subtype === 'init') {
    if (msg.session_id) sessionId = msg.session_id;
    return;
  }

  // messaggi dell'assistente: testo + chiamate strumenti
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        state.gotText = true;
        state.rawAnswer += block.text;
        const shown = stripLessons(block.text);
        if (shown.trim()) handlers.onText(shown);
      } else if (block.type === 'tool_use') {
        handlers.onTool(friendlyTool(block.name));
      }
    }
    return;
  }

  // risultato finale
  if (msg.type === 'result') {
    if (msg.session_id) sessionId = msg.session_id;
    if (msg.is_error && !state.gotText) {
      const txt = (typeof msg.result === 'string' && msg.result) ? msg.result : '';
      state.resultError = txt || 'Errore durante l\'elaborazione.';
    } else if (!msg.is_error && !state.gotText &&
               typeof msg.result === 'string' && msg.result.trim()) {
      // Sicurezza: nessun testo nei messaggi 'assistant' → usa il risultato finale
      state.gotText = true;
      state.rawAnswer += msg.result;
      const shown = stripLessons(msg.result);
      if (shown.trim()) handlers.onText(shown);
    }
    return;
  }
}

// ── Chiede una risposta a Claude ─────────────────────────────────
// handlers: { onText(str), onTool(label), onError(msg), onDone() }
function ask(userMessage, handlers) {
  const claude = findClaudeBinary();
  if (!claude) {
    log('ERRORE: binario claude non trovato');
    handlers.onError('Claude non è stato trovato. Apri l\'app per completare la configurazione iniziale.');
    return;
  }

  // Reinietta la memoria: lezioni apprese + analisi passate rilevanti
  let prompt = userMessage;
  try {
    const ctx = memory.buildContext(userMessage, currentLang);
    if (ctx) {
      const heading = currentLang === 'en' ? '# CURRENT USER QUESTION' : '# DOMANDA ATTUALE';
      prompt = ctx + '\n\n' + heading + '\n' + userMessage;
    }
  } catch (e) { log('memory context error: ' + e.message); }

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--model', currentModel,
    '--allowedTools', 'mcp__tradingview-mcp__*,WebSearch',
  ];
  if (sessionId) args.push('--resume', sessionId);

  // Persona personalizzata (append: mantiene la consapevolezza degli strumenti)
  try {
    let pf = personaFileFor(currentLang);
    if (!fs.existsSync(pf)) pf = personaFileFor('it'); // fallback
    if (fs.existsSync(pf)) {
      const persona = fs.readFileSync(pf, 'utf8');
      if (persona.trim()) args.push('--append-system-prompt', persona);
    }
  } catch (_) {}

  log(`SPAWN ${claude} (sessione: ${sessionId || 'nuova'})`);

  let child;
  try {
    child = spawn(claude, args, { cwd: HOME, env: buildEnv() });
  } catch (e) {
    log(`ERRORE spawn: ${e.message}`);
    handlers.onError('Impossibile avviare il motore di analisi.');
    return;
  }

  const state = { gotText: false, resultError: null, finished: false, rawAnswer: '' };
  let stdoutBuf = '';
  let stderrBuf = '';

  const timer = setTimeout(() => {
    log('TIMEOUT — chiudo il processo');
    try { child.kill('SIGTERM'); } catch (_) {}
  }, TURN_TIMEOUT_MS);

  function finish(errMsg) {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(timer);
    if (errMsg) {
      handlers.onError(errMsg);
      return;
    }
    // Successo → salva l'analisi nel vault, estrai lezioni e previsioni
    if (state.rawAnswer.trim()) {
      try {
        memory.extractLessons(state.rawAnswer);
        memory.extractPredictions(state.rawAnswer);
        memory.saveNote(userMessage, stripLessons(state.rawAnswer).trim());
      } catch (e) { log('memory save error: ' + e.message); }
    }
    handlers.onDone();
  }

  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString();
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) handleLine(line, state, handlers);
    }
  });

  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  child.on('error', (e) => {
    log(`ERRORE processo: ${e.message}`);
    finish('Impossibile comunicare con il motore di analisi.');
  });

  child.on('close', (code) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim(), state, handlers);
    log(`CHIUSO code=${code} gotText=${state.gotText}`);
    if (stderrBuf.trim()) log(`STDERR: ${stderrBuf.trim().slice(0, 500)}`);

    if (state.resultError && !state.gotText) {
      finish(humanizeError(state.resultError));
    } else if (code !== 0 && !state.gotText) {
      finish(humanizeError(stderrBuf || 'Il motore di analisi si è interrotto.'));
    } else {
      finish(null);
    }
  });
}

// ── Traduce errori tecnici in messaggi comprensibili ─────────────
function humanizeError(raw) {
  const t = String(raw).toLowerCase();
  if (/login|auth|unauthor|not logged|credential/.test(t)) {
    return 'Devi accedere a Claude per usare l\'assistente. Completa l\'accesso e riprova.';
  }
  if (/network|econn|timeout|fetch failed|enotfound/.test(t)) {
    return 'Connessione assente o instabile. Controlla la rete e riprova.';
  }
  if (/rate limit|overloaded|529|429/.test(t)) {
    return 'Servizio momentaneamente sovraccarico. Riprova tra poco.';
  }
  return 'Si è verificato un problema durante l\'analisi. Riprova.';
}

// ── Azzera la conversazione (per una "nuova chat") ───────────────
function reset() {
  sessionId = null;
  log('Sessione azzerata');
}

module.exports = { ask, reset, setModel, setLang, findClaudeBinary };
