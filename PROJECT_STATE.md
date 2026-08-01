# PROJECT_STATE — TradingView2Claude Connector (dev / v2.0)

Ultimo aggiornamento: 2026-08-01

---

## 1. Obiettivo del progetto

**TradingView2Claude Connector** è un'app Electron per macOS che fornisce a un trader retail un assistente AI di analisi tecnica (Claude) integrato in un'unica finestra con il grafico TradingView Web. Il cliente usa il **proprio abbonamento Claude** (no API key, headless via binario `claude`). Distribuzione via **curl one-liner** (`bit.ly/tv2cdashboard`) dal repo dev pubblico.

Repo dev: `itsmanuelbaby/tradingview2claude-connector-mac-dev` (pubblica)
Repo prod (v1.0, intoccata): repo separata, NON modificare.

---

## 2. Stato attuale — versione 2.0 rilasciata

**Release v1.0.0 sul repo dev** aggiornata e verificata (build CI 26328395245).
- `TradingView2Claude-Dev-arm64.dmg` — 162.118.507 byte
- `TradingView2Claude-Dev-x64.dmg` — 167.200.303 byte
- Comando distribuzione: `curl -fsSL https://bit.ly/tv2cdashboard | bash`

### Cosa è già fatto

**Modifica 1 — Dashboard unificata (5 fasi)**
- Unica finestra: chat su misura + `<webview>` TradingView + divisore trascinabile
- Eliminato launcher `.command`, eliminata finestra setup post-install
- Auto-recupero webview (crashed / render-process-gone / unresponsive) + pulsante ↻ dorato
- Motore Claude headless via `claude -p ... --output-format stream-json --verbose`

**Modifica 2 — Memoria persistente (vault Obsidian)**
- `~/Documents/TradingView2Claude Vault/` con `Analisi/`, `Lezioni.md`, `Previsioni.md`, `Leggimi.md`
- Auto-salvataggio analisi, retrieval pesato per ticker+keyword+recenza (top 5, max 900 char/nota)
- Marker `[LEZIONE]` / `[PREVISIONE]` emessi dall'agente, estratti, **strippati** dalla chat, reiniettati al turno successivo

**8 feature aggiuntive (tutte completate)**
- #3 Multi-lingua IT/EN (selettore in header, dizionario inline, persona EN, label memory localizzati)
- #5 Alert proattivi
- #6 Briefing programmati (scheduler 60s, `briefings.json` in userData, gate `engineBusy`)
- #7 News via WebSearch
- #8 Indicatori Pine
- #9 Tracciamento previsioni (con auto-calibrazione su Previsioni.md)
- #10 RAG pratico
- #12 Report diagnostico (escluso chiave licenza)

**Selettore modello** Opus / Sonnet / Haiku (default **opus**).

### Task differiti per scelta utente
- #1 Firma Apple + notarizzazione (per ultimo)
- #2 Sito vetrina + video demo (lo fa l'utente)
- #11 Auto-update electron-updater (solo quando build stabile)
- Porting Windows (doc tecnico già fornito)

---

## 3. File chiave

| File | Ruolo |
|---|---|
| `src/main.js` | Orchestrazione Electron, 2 finestre (setup + dashboard), `--remote-debugging-port=9222`, IPC, scheduler briefing, registrazione MCP bundled |
| `src/claude-engine.js` | Spawn `claude` headless, NDJSON parser, `setModel`/`setLang`/`reset`, `sessionId` module-level, `stripLessons` regex `[LEZIONE]`/`[PREVISIONE]` |
| `src/memory.js` | Vault Obsidian, `buildContext(userMessage, lang)`, `extractLessons`, `extractPredictions`, `saveNote`, retrieval pesato, JARGON blocklist ticker |
| `src/persona.txt` / `src/persona-en.txt` | Istruzioni assistente IT/EN (i marker restano in italiano in entrambi) |
| `src/dashboard.html` | UI unica (chat + webview TV + divider), `<webview src="https://www.tradingview.com/chart/" partition="persist:tradingview">`, i18n inline, brief modal |
| `src/index.html` | Setup screen, license screen (NON cancella chiave su sospensione) |
| `.github/workflows/build.yml` | Clone MCP + `sed` patch type==webview + `rm -rf bundled-mcp/.git` + npm install |
| `package.json` | appId `com.tv2claude.connector.dev`, productName "TradingView2Claude Connector Dev", artifactName con `-Dev-`, `writeUpdateInfo: false` |
| `install.sh` | curl one-liner installer, scarica DMG arch-specific, `xattr -cr`, open |

---

## 4. Decisioni tecniche prese

- **Embedding via `<webview>`** (non finestra separata): `Browser.setWindowBounds` non esiste in Electron, `window.moveTo/resizeTo` via CDP bloccato. Webview = niente permessi Accessibilità.
- **Patch MCP TradingView**: `sed` in CI sostituisce `t.type === 'page'` con `(t.type === 'page' || t.type === 'webview')` in `bundled-mcp/src/connection.js`.
- **Claude install via native installer** (`curl -fsSL https://claude.ai/install.sh | bash` → `~/.local/bin/claude`), abbandonato `npm install -g @anthropic-ai/claude-code` (fragile per nome `node-arm64`/`node-x64`).
- **bundled-mcp senza .git** (causava `xattr -cr` fail su pack read-only).
- **Distribuzione via curl**: nessuna quarantena macOS → niente "DMG danneggiato".
- **engineBusy flag** in main: serializza chat utente e briefing scheduler.
- **Licenza sospesa**: NON cancella la chiave salvata, solo notice; alla riattivazione l'app riparte sola.

---

## 5. Bug aperti

### RISOLTO (2026-08-01) — Analisi in timeout a 180s con schermata "Si è verificato un problema" (cliente Gabriele Cioffi)
- **Sintomo:** su ogni richiesta l'app spawnava `claude` ma NON riceveva output per 180s, poi lo uccideva col timeout (SIGTERM, `code=143`, `gotText=false`, stderr vuoto, `session_id` mai catturato → log "sessione: nuova" ogni volta). Il tuo Mac invece dava 401 (OAuth scaduto = problema diverso, risolto con re-login `/login`).
- **Causa root (verificata riproducendo il meccanismo):** in `claude-engine.js` lo spawn usava lo `stdio` di default ('pipe') e non chiudeva mai lo stdin. `claude -p` legge lo stdin quando è una pipe: su alcune build resta appeso all'infinito in attesa di dati. Contorno: l'app era "cieca" (scartava `system/init`, troncava stderr a 500, niente `--debug-file`, niente log delle tool call), quindi il report non bastava a distinguere le cause.
- **Fix applicati a `src/claude-engine.js` (pacchetto robustezza completo):**
  1. `stdio: ['ignore','pipe','pipe']` → stdin a EOF immediato (fix di root-cause, version-independent).
  2. Timeout ripensato: watchdog di avvio 30s (nessun output → messaggio "non risponde all'avvio") + timeout di INATTIVITÀ 180s che si resetta ad ogni output (le analisi lunghe ma vive non vengono più tagliate) + backstop assoluto 15 min. `killReason` traccia chi ha ucciso.
  3. Output parziale preservato: se interrotti a metà con testo già mostrato, si conserva e si aggiunge "_(analisi interrotta: tempo massimo superato)_" invece dell'errore generico.
  4. Logging diagnostico: `INIT session`, ogni `TOOL`, `FIRST-OUTPUT`, `SUMMARY`, stderr fino a 4000 char, versione claude allo spawn, `--debug-file` (se supportato).
  5. `--fallback-model` (sonnet, o haiku se già su sonnet) — aggiunto SOLO se il binario lo supporta (feature-detect via `--help`, per non rompere build vecchie con "unknown option").
  6. Bug latente `stripLessons`: `gotText` ora si attiva solo con testo VISIBILE (un messaggio di soli marker non conta come "successo vuoto"); `saveNote` non salva più note vuote.
  7. `humanizeError` ampliato (401/oauth/token expired → invito a `/login`; proxy/firewall; usage limit).
- **Feature-detect flag:** i flag recenti (`--debug-file`, `--fallback-model`) si aggiungono solo se compaiono in `claude --help` (cache per binario).
- **DA FARE per chiudere:** rebuild DMG (CI), aggiornare asset su release, e far girare al cliente il comando di diagnosi (`claude ... < /dev/null`) per confermare la causa esatta (stdin vs limite Opus vs rete).

### CI (2026-08-01) — build DMG fallita: Python 3.14 sul runner rompe dmgbuild
- Sintomo: step "Build Mac DMG" → `dmgbuild core.py:257 Alias.for_file(background_file)` → `FileNotFoundError .background/background.tiff` + `hdiutil: attach failed - no mountable file systems`. Falliva su `macos-latest` E `macos-14`.
- **Causa root (verificata con ricerca sugli issue e sui sorgenti electron-builder):** electron-builder 24.13.3 esegue il suo `dmgbuild` bundlato col **python di sistema del runner**. A metà 2026 le immagini GitHub sono passate a **Python 3.14**, che rompe il vecchio `mac_alias`/`biplist` di dmgbuild → l'alias dello sfondo di default fallisce. Non è un problema di config: il repo prod buildò a maggio con config identica (solo il Python del runner è cambiato). `"dmg": {"background": null}` NON aiuta su v24 (torna allo sfondo di default → stesso errore).
- **Fix applicato (CI-only, nessuna modifica a package.json):** in `.github/workflows/build.yml`, step `actions/setup-python@v5` con `python-version: '3.12'` (id `py`) prima del build, e `PYTHON_PATH: ${{ steps.py.outputs.python-path }}` nell'env dello step "Build Mac DMG" (electron-builder 24 legge PYTHON_PATH direttamente). NON usare Python 3.13/3.14.
- Runner: lasciato pinnato a `macos-14` come base stabile (non era la causa del fail, ma è un ambiente più prevedibile di `macos-latest`).
- Fix di lungo termine (separato, non ora): upgrade a electron-builder 26.15.3 (bundla il proprio Python per dmgbuild → indipendente dal runner). Major bump 24→26 con breaking changes: richiede retest firma/notarizzazione.
- Nota distribuzione: la CI carica i DMG solo come artifact `installer-mac`; NON aggiorna la release. Per i clienti: scaricare l'artifact e `gh release upload v1.0.0 <dmg> --clobber`.
- NB storico: lo stato git del repo dev era rotto (index.lock orfano del 15/06, indice vuoto) — riparato con `rm .git/index.lock` + `git reset` (working tree intatto).

### In attesa
- Feedback dal cliente test (Riccardo).

---

## 6. Prossimi step (priorità)

1. **Attesa feedback cliente test** sulla 2.0 distribuita.
2. **#11 Auto-update electron-updater** quando la pipeline build è considerata stabile.
3. **#1 Firma Apple + notarizzazione** (richiede Developer ID; per ultimo).
4. **Porting Windows** (doc già scritto, separata).
5. **#2 Sito vetrina + demo** (lato utente).

---

## 7. Prompt per la prossima sessione

```
Sto continuando lo sviluppo di TradingView2Claude Connector v2.0 (repo dev:
itsmanuelbaby/tradingview2claude-connector-mac-dev, pubblica). Leggi
PROJECT_STATE.md e CLAUDE.md nella root del progetto per stato e regole.

La 2.0 è già rilasciata su v1.0.0 del repo dev (DMG arm64 + x64) e distribuita
via `curl -fsSL https://bit.ly/tv2cdashboard | bash`. Tutte le 8 feature
richieste e le Modifiche 1+2 (dashboard unificata + memoria Obsidian) sono in
produzione dev.

Regole permanenti (vedi CLAUDE.md): ogni modifica deve essere universale (no
fix locali), non rompere produzione v1.0, non togliere ciò che serve, la
persona non rivela mai di essere Claude, licenza sospesa non cancella chiave,
diagnostico non include chiave, cliente usa SUO abbonamento Claude,
bundled-mcp senza .git, briefing solo con app aperta.

Dimmi su cosa lavoriamo.
```

