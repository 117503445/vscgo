#!/usr/bin/env bash
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")/../web/static/extensions" && pwd)"
mkdir -p "$EXT_DIR"

# Extension: publisher.name version
# Format: publisher.name version
declare -A EXTS=(
  ["pkief.material-icon-theme"]="5.20.0"
  ["mechatroner.rainbow-csv"]="3.6.0"
  ["iliazeus.vscode-ansi"]="1.1.4"
  ["njzy.stats-bar"]="0.5.2"
  ["tomoki1207.pdf"]="1.2.2"
  ["humao.rest-client"]="0.25.1"
  ["mhutchie.git-graph"]="1.30.0"
)

for ext_name in "${!EXTS[@]}"; do
  version="${EXTS[$ext_name]}"
  vsix="${ext_name}-${version}.vsix"
  if [ -f "$EXT_DIR/$vsix" ]; then
    echo "Already have $vsix, skipping"
    continue
  fi
  echo "Downloading $vsix..."
  publisher="${ext_name%%.*}"
  curl -fsSL -o "$EXT_DIR/$vsix" \
    "https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${publisher}/vsextensions/${ext_name#*.}/${version}/vspackage"
  echo "  -> $(ls -lh "$EXT_DIR/$vsix" | awk '{print $5}')"
done

echo "All extensions downloaded."
