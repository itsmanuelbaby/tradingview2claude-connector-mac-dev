# CLAUDE.md — Regole permanenti del progetto

Queste regole valgono per **ogni** modifica al codice di TradingView2Claude Connector. Non derogarle senza esplicito consenso dell'utente.

---

## Architettura e vincoli di prodotto

- **Cliente usa il SUO abbonamento Claude.** Mai introdurre API key Anthropic, mai chiedere credenziali API. Il motore gira headless tramite il binario `claude` installato sul Mac del cliente.
- **Persona NON deve mai rivelare di essere Claude.** I file `src/persona.txt` e `src/persona-en.txt` definiscono un assistente di mercato; non aggiungere riferimenti al modello sottostante.
- **Distribuzione via curl** (`bit.ly/tv2cdashboard`). Mai chiedere al cliente di scaricare DMG dal browser (quarantena → "app danneggiata").
- **Briefing programmati partono solo con app aperta** (v1 della feature). Niente background daemon, niente launchd.

## Universalizzazione

- **Ogni modifica deve essere universale**, non un fix locale al singolo caso. Pensa "come funziona su tutti i Mac del cliente?", non "come faccio funzionare il mio".
- **Non rompere produzione v1.0** (repo separata). Lavora solo nel repo dev.
- **Non togliere cose che servono**, anche se sembrano inutili al primo sguardo: chiedi prima.

## Sicurezza e dati utente

- **Licenza sospesa NON deve cancellare la chiave salvata.** Mostra solo l'avviso. Alla riattivazione l'app deve ripartire da sola senza re-input.
- **Report diagnostico NON deve includere la chiave di licenza.** Filtra esplicitamente.
- **bundled-mcp NON deve contenere `.git`**: `xattr -cr` fallisce sui pack read-only e rompe l'install. La build CI deve fare `rm -rf bundled-mcp/.git` dopo il clone.

## Memoria (vault Obsidian)

- Vault path: `~/Documents/TradingView2Claude Vault/` — non spostarlo, è la home utente.
- Marker `[LEZIONE]` e `[PREVISIONE]` restano **in italiano in entrambe le persona** (sono marker tecnici, non testo localizzato).
- `stripLessons` deve rimuovere entrambi i marker dalla chat ma preservarli in `rawAnswer` per estrazione.

## Build CI

- Workflow su `macos-14`, con **Python 3.12 pinnato** (`actions/setup-python@v5` + `PYTHON_PATH` nello step DMG). Dal 2026-08 le immagini runner hanno Python 3.14, che rompe il `dmgbuild` di electron-builder 24 (`Alias.for_file .background/background.tiff`); il pin Python è il fix. NON usare Python 3.13/3.14. Deve produrre 2 DMG (`-arm64` e `-x64`) con artifactName che contiene `-Dev-`.
- Step "Setup bundled-mcp" deve: clonare LewisWJackson/tradingview-mcp-jackson, applicare il `sed` patch per accettare target `webview` oltre a `page`, `npm install`, rimuovere `.git`.
- Mai aggiungere `window` o `backgroundColor` al blocco `dmg` in package.json (fallisce per .DS_Store).

## Git / Release

- Repo dev: `itsmanuelbaby/tradingview2claude-connector-mac-dev` (pubblica, ok rimanere così).
- Release fissa: `v1.0.0`. Aggiornare gli asset con `gh release upload v1.0.0 --clobber ...`.
- Non creare nuove release senza esplicito ok.

## Workflow

- Prima di modifiche non banali, aggiorna `PROJECT_STATE.md`.
- Per task lunghi, marca chapter con `mark_chapter`.
- Su build CI, monitora ma non fare polling con sleep brevi.

