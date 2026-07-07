# 食品物流センター向け Q&A チャットボット

50人規模の食品物流センターの現場ナレッジ（温度管理・入出荷・安全衛生など34問）に回答するチャットボットのPoCです。Excelのナレッジベースを読み込み、Claude APIによるRAG回答、またはAPIキーなしのデモモードで動作します。

## セットアップ

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY を設定（省略可）
npm start              # http://localhost:3000
```

- `ANTHROPIC_API_KEY` を設定 → Claude RAGモード（ナレッジを文脈にした自然な回答）
- 未設定 → デモモード（キーワードマッチによる回答。API課金なしで動作確認可能）

## ナレッジベースの編集

`qa_knowledge.xlsx` がナレッジの正本です。「カテゴリ／質問／回答／キーワード」の4列を編集し、サーバー再起動または `POST /api/reload` で反映されます。

`npm run setup` は**初期サンプルの生成専用**です。既存の `qa_knowledge.xlsx` がある場合は誤上書き防止のため中断します（初期状態に戻したい場合のみ `node scripts/create_sample_excel.js --force`）。

## API

| エンドポイント | 説明 |
|---|---|
| `POST /api/chat` | チャット回答（SSEストリーミング） |
| `GET /api/categories` | カテゴリ一覧 |
| `GET /api/qa?category=` | カテゴリ別Q&A |
| `GET /api/knowledge-count` | KB件数・動作モード確認 |
| `POST /api/reload` | ナレッジベース再読み込み |

## Claude Code での開発

- リポジトリ直下の `CLAUDE.md` にプロジェクトルールを記載
- `.claude/hooks/session-start.sh` により、Claude Code on the Web のセッション開始時に依存関係が自動インストールされます
- `.claude/agents/` にモデル別の役割分担エージェント（architect / builder / runner / triage）を定義しています
