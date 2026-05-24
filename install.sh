#!/bin/bash

REPO="itsmanuelbaby/tradingview2claude-connector-mac-dev"
APP_NAME="TradingView2Claude Connector Dev"

clear
echo ""
echo "  +==============================================+"
echo "  |    TradingView2Claude Connector  [DEV]      |"
echo "  |    Installazione automatica                 |"
echo "  +==============================================+"
echo ""

# Controllo macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "  ERRORE: Questo installer funziona solo su macOS."
  exit 1
fi

# Architettura
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  DMG_NAME="TradingView2Claude-Dev-arm64.dmg"
else
  DMG_NAME="TradingView2Claude-Dev-x64.dmg"
fi
echo "  Architettura rilevata: $ARCH"
echo ""

# ── Disinstallazione versione precedente (se presente) ──────────
# Garantisce che il cliente esegua davvero la nuova build,
# senza il rischio di confusione tra vecchia e nuova versione.
# Licenza, vault Obsidian e config Claude restano intatti
# (vivono in $HOME, non in /Applications).
TARGET="/Applications/${APP_NAME}.app"
if [ -d "$TARGET" ] || pgrep -f "$APP_NAME" > /dev/null 2>&1; then
  echo "  [0/4] Rimozione versione precedente..."
  # Chiude l'app se è aperta (più garbo possibile, poi forza)
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
  sleep 1
  pkill -f "$APP_NAME" 2>/dev/null || true
  sleep 1
  if [ -d "$TARGET" ]; then
    rm -rf "$TARGET" 2>/dev/null || sudo rm -rf "$TARGET"
  fi
  echo "         Versione precedente rimossa."
  echo "         (Licenza, memoria e login Claude preservati)"
  echo ""
fi

# Download
DMG_URL="https://github.com/${REPO}/releases/latest/download/${DMG_NAME}"
TMP_DMG="/tmp/${DMG_NAME}"

echo "  [1/4] Download in corso..."
if ! curl -fsSL --progress-bar "$DMG_URL" -o "$TMP_DMG"; then
  echo "  ERRORE: Download fallito. Controlla la connessione."
  exit 1
fi
echo ""

# Mount
echo "  [2/4] Apertura pacchetto..."
MOUNT_OUTPUT=$(hdiutil attach "$TMP_DMG" -nobrowse -noautoopen -plist 2>/dev/null)
MOUNT_POINT=$(echo "$MOUNT_OUTPUT" | grep -A1 '<key>mount-point</key>' | grep '<string>' | sed 's/.*<string>\(.*\)<\/string>.*/\1/' | head -1)

if [ -z "$MOUNT_POINT" ] || [ ! -d "$MOUNT_POINT" ]; then
  echo "  ERRORE: Impossibile aprire il pacchetto di installazione."
  rm -f "$TMP_DMG"
  exit 1
fi

APP_IN_DMG=$(find "$MOUNT_POINT" -name "*.app" -maxdepth 2 | head -1)
if [ -z "$APP_IN_DMG" ]; then
  echo "  ERRORE: File app non trovato."
  hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  rm -f "$TMP_DMG"
  exit 1
fi

# Installa
echo "  [3/4] Installazione in /Applications..."
TARGET="/Applications/${APP_NAME}.app"
if [ -d "$TARGET" ]; then
  rm -rf "$TARGET"
fi

if ! cp -R "$APP_IN_DMG" /Applications/ 2>/dev/null; then
  sudo cp -R "$APP_IN_DMG" /Applications/
fi
xattr -cr "$TARGET" 2>/dev/null || sudo xattr -cr "$TARGET" 2>/dev/null || true

# Cleanup
hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
rm -f "$TMP_DMG"

echo "  [4/4] Pulizia completata."
echo ""
echo "  ✓ TradingView2Claude Connector Dev installato!"
echo ""
echo "  Avvio in corso..."
sleep 1
open "$TARGET"
