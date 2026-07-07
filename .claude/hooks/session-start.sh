#!/bin/bash
set -euo pipefail

# Claude Code on the Web のセッション開始時に依存関係をインストールする。
# ローカル実行時は何もしない（冪等・非対話）。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
