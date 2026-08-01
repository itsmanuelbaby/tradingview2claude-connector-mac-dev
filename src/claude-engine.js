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

// ── Timeout ──────────────────────────────────────────────────────
// Invece di un'unica ghigliottina fissa usiamo tre guardie:
//  • STARTUP: nessun output entro 30s dallo spawn → avvio bloccato
//    (è il caso in cui claude non emette nemmeno la riga `init`).
//  • INATTIVITÀ: nessun output per 3 min DURANTE l'analisi → bloccato.
//    Si resetta ad ogni riga ricevuta, quindi le analisi lunghe ma
//    "vive" (molte tool call) non vengono più tagliate ingiustamente.
//  • ASSOLUTO: backstop finale a 15 min contro loop patologici.
const STARTUP_TIMEOUT_MS    = 30000;
const INACTIVITY_TIMEOUT_MS = 180000;
const ABSOLUTE_TIMEOUT_MS   = 900000;

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
function ensureLogDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}
function log(msg) {
  try {
    ensureLogDir();
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

// ── Capacità del binario claude (versione + flag supportati) ─────
// Le versioni più vecchie di `claude` non conoscono flag recenti
// come --debug-file o --fallback-model: passarli le farebbe uscire
// subito con "unknown option". Quindi li aggiungiamo SOLO se la
// guida (`--help`) del binario installato li elenca. Cache per path.
let _caps = null;
function claudeCaps(claudeBin) {
  if (_caps && _caps.bin === claudeBin) return _caps;
  _caps = { bin: claudeBin, version: '', help: '' };
  const env = buildEnv();
  try { _caps.version = execSync(`"${claudeBin}" --version`, { encoding: 'utf8', timeout: 5000, env }).trim(); } catch (_) {}
  try { _caps.help    = execSync(`"${claudeBin}" --help`,    { encoding: 'utf8', timeout: 5000, env }); } catch (_) {}
  return _caps;
}
function supportsFlag(claudeBin, flag) {
  try { return claudeCaps(claudeBin).help.includes(flag); } catch (_) { return false; }
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
    state.sawInit = true;
    if (msg.session_id) { sessionId = msg.session_id; log(`INIT session=${msg.session_id}`); }
    return;
  }

  // messaggi dell'assistente: testo + chiamate strumenti
  if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        // Accumula sempre il grezzo (serve a estrarre lezioni/previsioni),
        // ma considera "testo mostrato" SOLO se resta qualcosa dopo lo strip:
        // un blocco fatto di soli marker non deve far sembrare la risposta
        // riuscita mentre l'utente vede il vuoto.
        state.rawAnswer += block.text;
        const shown = stripLessons(block.text);
        if (shown.trim()) { state.gotText = true; handlers.onText(shown); }
      } else if (block.type === 'tool_use') {
        state.toolCount++;
        log(`TOOL ${block.name}`);
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
      state.rawAnswer += msg.result;
      const shown = stripLessons(msg.result);
      if (shown.trim()) { state.gotText = true; handlers.onText(shown); }
    }
    return;
  }

  // altri tipi utili in diagnostica (rate limit, errori di sistema, ecc.)
  if (msg.type && msg.type !== 'user' && msg.type !== 'stream_event') {
    log(`MSG ${msg.type}${msg.subtype ? '/' + msg.subtype : ''}`);
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

  ensureLogDir();

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

  // Se sovraccarico/limitato sul modello scelto, degrada invece di
  // inchiodarsi (aggiunto solo se il binario lo supporta).
  const fallbackModel = currentModel === 'sonnet' ? 'haiku' : 'sonnet';
  if (supportsFlag(claude, '--fallback-model')) {
    args.push('--fallback-model', fallbackModel);
  }

  // Traccia interna di claude (MCP/API/streaming) su file dedicato:
  // in stream-json lo stderr è vuoto per design, quindi senza questo
  // un blocco resta invisibile. Aggiunto solo se supportato.
  const dbgFile = path.join(LOG_DIR, `claude-debug-${Date.now()}.log`);
  if (supportsFlag(claude, '--debug-file')) {
    args.push('--debug-file', dbgFile);
    log(`DEBUG-FILE ${dbgFile}`);
  }

  // Persona personalizzata (append: mantiene la consapevolezza degli strumenti)
  try {
    let pf = personaFileFor(currentLang);
    if (!fs.existsSync(pf)) pf = personaFileFor('it'); // fallback
    if (fs.existsSync(pf)) {
      const persona = fs.readFileSync(pf, 'utf8');
      if (persona.trim()) args.push('--append-system-prompt', persona);
    }
  } catch (_) {}

  const caps = claudeCaps(claude);
  log(`SPAWN ${claude} v${caps.version || '?'} model=${currentModel} (sessione: ${sessionId || 'nuova'})`);

  let child;
  try {
    // stdio: stdin su 'ignore' → EOF immediato. `claude -p` legge lo
    // stdin quando è una pipe (anche col prompt passato come argomento):
    // lasciandolo aperto, alcune build restano appese all'infinito in
    // attesa di dati che non arrivano mai. Questo è il fix di root-cause.
    child = spawn(claude, args, { cwd: HOME, env: buildEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`ERRORE spawn: ${e.message}`);
    handlers.onError('Impossibile avviare il motore di analisi.');
    return;
  }

  const state = {
    gotText: false, sawInit: false, toolCount: 0,
    resultError: null, finished: false, rawAnswer: '',
    killReason: null, firstOutputMs: null,
  };
  const spawnTs = Date.now();
  let stdoutBuf = '';
  let stderrBuf = '';

  // ── Guardie temporali ──────────────────────────────────────────
  let startupTimer = null, idleTimer = null, hardTimer = null;
  function clearTimers() {
    clearTimeout(startupTimer); clearTimeout(idleTimer); clearTimeout(hardTimer);
  }
  function killWith(reason) {
    if (state.finished || state.killReason) return;
    state.killReason = reason;
    log(`TIMEOUT(${reason}) sawInit=${state.sawInit} gotText=${state.gotText} firstOutput=${state.firstOutputMs != null ? state.firstOutputMs + 'ms' : 'NONE'} — vedi ${dbgFile}`);
    try { child.kill('SIGTERM'); } catch (_) {}
    // Se ignora il SIGTERM, forza la chiusura così 'close' scatta comunque.
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
  }
  function armIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killWith('inactivity'), INACTIVITY_TIMEOUT_MS);
  }
  startupTimer = setTimeout(() => { if (state.firstOutputMs == null) killWith('startup'); }, STARTUP_TIMEOUT_MS);
  hardTimer    = setTimeout(() => killWith('absolute'), ABSOLUTE_TIMEOUT_MS);

  function finish(errMsg) {
    if (state.finished) return;
    state.finished = true;
    clearTimers();
    log(`SUMMARY firstOutput=${state.firstOutputMs != null ? state.firstOutputMs + 'ms' : 'NONE'} sawInit=${state.sawInit} tools=${state.toolCount} gotText=${state.gotText} killReason=${state.killReason || '-'}`);
    if (errMsg) {
      handlers.onError(errMsg);
      return;
    }
    // Successo → salva l'analisi nel vault, estrai lezioni e previsioni
    if (state.rawAnswer.trim()) {
      try {
        memory.extractLessons(state.rawAnswer);
        memory.extractPredictions(state.rawAnswer);
        const cleaned = stripLessons(state.rawAnswer).trim();
        if (cleaned) memory.saveNote(userMessage, cleaned); // niente note vuote
      } catch (e) { log('memory save error: ' + e.message); }
    }
    handlers.onDone();
  }

  child.stdout.on('data', (d) => {
    if (state.firstOutputMs == null) {
      state.firstOutputMs = Date.now() - spawnTs;
      clearTimeout(startupTimer);
      log(`FIRST-OUTPUT ${state.firstOutputMs}ms`);
    }
    armIdle();
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
    log(`CHIUSO code=${code} gotText=${state.gotText} kill=${state.killReason || '-'}`);
    if (stderrBuf.trim()) log(`STDERR: ${stderrBuf.trim().slice(0, 4000)}`);

    if (state.killReason && state.gotText) {
      // Abbiamo interrotto noi ma parte dell'analisi è già stata mostrata:
      // conservala e segnala solo che è stata troncata.
      const note = currentLang === 'en'
        ? '\n\n_(analysis interrupted: time limit reached)_'
        : '\n\n_(analisi interrotta: tempo massimo superato)_';
      handlers.onText(note);
      finish(null);
    } else if (state.killReason === 'startup') {
      finish(currentLang === 'en'
        ? 'The analysis engine did not respond on startup. Check your connection and try again.'
        : 'Il motore di analisi non ha risposto all\'avvio. Controlla la connessione e riprova.');
    } else if (state.killReason) {
      finish(currentLang === 'en'
        ? 'The analysis took too long. Try again, or switch to a faster model.'
        : 'L\'analisi ha superato il tempo massimo. Riprova, magari con un modello più veloce.');
    } else if (state.resultError && !state.gotText) {
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
  if (/login|auth|unauthor|not logged|credential|401|oauth|token has expired|re-authenticate/.test(t)) {
    return 'Devi accedere a Claude per usare l\'assistente. Apri il Terminale, esegui "claude" e digita /login, poi riprova.';
  }
  if (/network|econn|timeout|fetch failed|enotfound|proxy|socket/.test(t)) {
    return 'Connessione assente o instabile. Controlla la rete (VPN/proxy/firewall) e riprova.';
  }
  if (/rate limit|overloaded|529|429|usage limit|quota/.test(t)) {
    return 'Servizio momentaneamente sovraccarico o limite raggiunto. Riprova tra poco.';
  }
  return 'Si è verificato un problema durante l\'analisi. Riprova.';
}

// ── Azzera la conversazione (per una "nuova chat") ───────────────
function reset() {
  sessionId = null;
  log('Sessione azzerata');
}

module.exports = { ask, reset, setModel, setLang, findClaudeBinary };
