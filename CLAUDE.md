# food-logistics-chatbot

食品物流センター向けQ&Aチャットボット（Express + @anthropic-ai/sdk）。PoC段階。

## 起動

- `npm install` → `npm start`（http://localhost:3000）
- `ANTHROPIC_API_KEY` 未設定なら自動でデモモード（キーワードマッチ回答）。`.env.example` 参照
- ヘルスチェック: `GET /api/knowledge-count`（KB件数と mode を返す）

## ナレッジベース（KB）の運用ルール

- **正は `qa_knowledge.xlsx`**（カテゴリ／質問／回答／キーワードの4列）。編集後は `POST /api/reload` か再起動で反映
- `npm run setup`（scripts/create_sample_excel.js）は**初期サンプル生成専用**。既存の xlsx があると中断する。上書き復元は `--force` が必要 — 実行前に必ずユーザーに確認すること

## 構成

- `server.js` — API本体。`/api/chat` はSSEストリーミング。bigram＋キーワードの簡易RAGで関連Q&Aを抽出
- `public/index.html` — フロント一式（1ファイル）
- テスト・lint は未整備（PoC）。動作確認はサーバー起動＋APIレスポンスで行う

## サブエージェント運用

`.claude/agents/` に4役を定義済み。設計判断・レビューは architect（fable）、実装は builder（opus）、テスト・定型修正は runner（sonnet）、要約・分類は triage（haiku）へ委譲する。
