'use strict';

// ================================================================
//  memory.js — memoria persistente dell'assistente (vault Obsidian)
//  Ogni analisi viene salvata come nota markdown. Prima di ogni
//  domanda le note rilevanti + le "Lezioni" vengono reiniettate
//  nel contesto dell'assistente.
//  Il vault è una semplice cartella di file .md, apribile in Obsidian.
// ================================================================

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const VAULT_DIR        = path.join(os.homedir(), 'Documents', 'TradingView2Claude Vault');
const NOTES_DIR        = path.join(VAULT_DIR, 'Analisi');
const LESSONS_FILE     = path.join(VAULT_DIR, 'Lezioni.md');
const PREVISIONS_FILE  = path.join(VAULT_DIR, 'Previsioni.md');
const README_FILE      = path.join(VAULT_DIR, 'Leggimi.md');

const MAX_NOTES_IN_CONTEXT = 5;   // quante analisi passate reiniettare
const MAX_NOTE_CHARS       = 900; // troncamento per nota nel contesto

// ── Crea il vault se non esiste ──────────────────────────────────
function ensureVault() {
  try {
    if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
    if (!fs.existsSync(LESSONS_FILE)) {
      fs.writeFileSync(LESSONS_FILE,
        '# Lezioni\n\n' +
        'Insegnamenti ed errori da non ripetere. L\'assistente aggiunge qui ' +
        'ciò che impara; puoi modificare o aggiungere note a mano.\n\n');
    }
    if (!fs.existsSync(PREVISIONS_FILE)) {
      fs.writeFileSync(PREVISIONS_FILE,
        '# Previsioni\n\n' +
        'Registro delle previsioni operative formulate dall\'assistente. ' +
        'Ogni nuova previsione viene aggiunta in coda. L\'assistente le rilegge ' +
        'per verificare di volta in volta se ha centrato o sbagliato, e si ' +
        'auto-calibra di conseguenza.\n\n');
    }
    if (!fs.existsSync(README_FILE)) {
      fs.writeFileSync(README_FILE,
        '# TradingView2Claude — Memoria\n\n' +
        'Archivio della memoria dell\'assistente di mercato.\n\n' +
        '- **Analisi/** — una nota per ogni analisi svolta\n' +
        '- **Lezioni.md** — insegnamenti accumulati nel tempo\n' +
        '- **Previsioni.md** — registro delle previsioni operative formulate\n\n' +
        'Apri questa cartella come vault in Obsidian per consultarla.\n');
    }
  } catch (_) {}
}

// ── Lettura "Lezioni" ────────────────────────────────────────────
function readLessons() {
  try { return fs.readFileSync(LESSONS_FILE, 'utf8'); } catch { return ''; }
}

// ── Lettura "Previsioni" ─────────────────────────────────────────
function readPredictions() {
  try { return fs.readFileSync(PREVISIONS_FILE, 'utf8'); } catch { return ''; }
}

// ── Elenco note (più recenti per prime) ──────────────────────────
function listNotes() {
  try {
    return fs.readdirSync(NOTES_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()        // il prefisso data rende l'ordine cronologico
      .reverse();    // più recenti per prime
  } catch {
    return [];
  }
}

// ── Possibili ticker nel testo (3-8 lettere maiuscole) ───────────
// Esclude il gergo di trading per non scambiarlo per un simbolo.
const JARGON = new Set([
  'STOP', 'TARGET', 'ENTRY', 'SHORT', 'LONG', 'BUY', 'SELL', 'HOLD',
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'RSI', 'MACD', 'EMA', 'SMA',
  'ATR', 'ADX', 'VWAP', 'OK', 'TP', 'SL',
]);
function tickersIn(text) {
  const m = String(text || '').match(/\b[A-Z]{3,8}\b/g);
  if (!m) return [];
  return Array.from(new Set(m)).filter(t => !JARGON.has(t));
}

// ── Parole significative per la ricerca leggera nelle note ───────
const STOPWORDS = new Set([
  'il','lo','la','i','gli','le','un','uno','una','di','da','in','con','su','per','tra','fra',
  'e','o','ma','che','non','si','mi','ti','del','dello','della','dei','degli','delle',
  'come','quando','dove','perché','cosa','chi','tutto','tutti','più','meno','già','ora','adesso',
  'anche','solo','molto','poco','questo','questa','questi','queste','quel','quella','quello',
  'analizza','dimmi','fammi','vedi','vedo','sono','hai','abbiamo','potresti','vorrei','potete',
  'the','and','for','with','this','that','what','when','where','from','have','will','your',
]);
function significantWords(text) {
  return Array.from(new Set(
    String(text || '').toLowerCase()
      .replace(/[^\wàèéìòùa-z0-9 ]/gi, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  ));
}

// ── Costruisce il contesto da reiniettare prima di una domanda ───
function buildContext(userMessage, lang) {
  ensureVault();
  const L = (lang === 'en')
    ? {
        lessons: '## Lessons learned — keep them in mind, do not repeat these mistakes',
        predictions: '## Your recent predictions — verify if they were correct',
        notes: '## Your past analyses (for continuity)',
      }
    : {
        lessons: '## Lezioni apprese — tienine conto, non ripetere questi errori',
        predictions: '## Le tue previsioni recenti — verifica se sono state centrate',
        notes: '## Le tue analisi passate (per dare continuità)',
      };

  let ctx = '';

  const lessons = readLessons().trim();
  if (lessons && !/^#\s*Lezioni\s*$/i.test(lessons)) {
    ctx += L.lessons + '\n' + lessons + '\n\n';
  }

  // Previsioni recenti: ultime ~10 voci → l'assistente le rilegge per
  // verificare se ha centrato o sbagliato, e si auto-calibra.
  const predLines = readPredictions().split('\n').filter(l => l.startsWith('- '));
  if (predLines.length) {
    ctx += L.predictions + '\n';
    for (const l of predLines.slice(-10)) ctx += l + '\n';
    ctx += '\n';
  }

  // ── Recupero note: punteggio per ticker + parole-chiave + recenza ──
  const notes = listNotes();
  const candidates = notes.slice(0, 50); // valuta le ~50 più recenti
  const tickers = tickersIn(userMessage);
  const keywords = significantWords(userMessage);

  const scored = candidates.map((f, idx) => {
    let content = '';
    try { content = fs.readFileSync(path.join(NOTES_DIR, f), 'utf8'); } catch (_) {}
    const lc = content.toLowerCase();
    let s = 0;
    if (tickers.some(t => f.includes(t))) s += 3;          // ticker nel nome
    for (const t of tickers) if (content.includes(t)) s += 2;  // ticker nel testo
    for (const k of keywords) if (lc.includes(k)) s += 1;      // parola-chiave
    if (idx < 5) s += 1;                                       // bonus recenza
    return { f, content, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.filter(x => x.score > 0).slice(0, MAX_NOTES_IN_CONTEXT);

  if (picked.length) {
    ctx += L.notes + '\n';
    for (const item of picked) {
      let content = item.content;
      if (content.length > MAX_NOTE_CHARS) content = content.slice(0, MAX_NOTE_CHARS) + '…';
      ctx += '\n— ' + item.f.replace(/\.md$/, '') + ' —\n' + content + '\n';
    }
  }

  return ctx.trim();
}

// ── Salva una nuova analisi come nota ────────────────────────────
function saveNote(userMessage, answer) {
  ensureVault();
  const now = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
              + ` ${p(now.getHours())}${p(now.getMinutes())}`;
  // Il simbolo viene cercato nella domanda; se assente, nella risposta
  let tickers = tickersIn(userMessage);
  if (!tickers.length) tickers = tickersIn(answer);
  const tag = tickers.length ? tickers[0] : 'analisi';

  const base = `${stamp} ${tag}`;
  let file = path.join(NOTES_DIR, base + '.md');
  let i = 2;
  while (fs.existsSync(file)) { file = path.join(NOTES_DIR, `${base} (${i++}).md`); }

  const body =
    '---\n' +
    `data: ${now.toISOString()}\n` +
    `simbolo: ${tag}\n` +
    '---\n\n' +
    `# ${tag} — ${stamp}\n\n` +
    '## Domanda\n' + String(userMessage || '').trim() + '\n\n' +
    '## Analisi\n' + String(answer || '').trim() + '\n';

  try { fs.writeFileSync(file, body); } catch (_) {}
}

// ── Estrae righe [LEZIONE] dalla risposta e le aggiunge a Lezioni ─
function extractLessons(answer) {
  const found = [];
  String(answer || '').split('\n').forEach(line => {
    const m = line.match(/\[LEZIONE\]\s*(.+)/i);
    if (m && m[1].trim()) found.push(m[1].trim());
  });
  if (!found.length) return 0;

  ensureVault();
  const day = new Date().toISOString().slice(0, 10);
  let add = '';
  for (const l of found) add += `- (${day}) ${l}\n`;
  try { fs.appendFileSync(LESSONS_FILE, add); } catch (_) {}
  return found.length;
}

// ── Estrae righe [PREVISIONE] e le aggiunge a Previsioni.md ──────
function extractPredictions(answer) {
  const found = [];
  String(answer || '').split('\n').forEach(line => {
    const m = line.match(/\[PREVISIONE\]\s*(.+)/i);
    if (m && m[1].trim()) found.push(m[1].trim());
  });
  if (!found.length) return 0;
  ensureVault();
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  let add = '';
  for (const p of found) add += `- (${stamp}) ${p}\n`;
  try { fs.appendFileSync(PREVISIONS_FILE, add); } catch (_) {}
  return found.length;
}

module.exports = {
  VAULT_DIR,
  ensureVault,
  buildContext,
  saveNote,
  extractLessons,
  extractPredictions,
};
