const express = require('express');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ナレッジベースをメモリにキャッシュ
let knowledgeBase = [];

function loadKnowledgeBase() {
  const xlsxPath = path.join(__dirname, 'qa_knowledge.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    console.error('qa_knowledge.xlsx が見つかりません。scripts/create_sample_excel.js を実行してサンプルを作成してください。');
    return [];
  }
  const workbook = XLSX.readFile(xlsxPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet);

  const knowledge = rows
    .filter(row => row['質問'] && row['回答'])
    .map(row => ({
      category: row['カテゴリ'] || '一般',
      question: String(row['質問']).trim(),
      answer: String(row['回答']).trim(),
      keywords: row['キーワード'] ? String(row['キーワード']).split(/[,、]/).map(k => k.trim()) : [],
    }));

  console.log(`ナレッジベース読み込み完了: ${knowledge.length} 件`);
  return knowledge;
}

// RAG: ユーザーの質問に関連するQ&Aを取得
function retrieveRelevantQA(userQuestion, topK = 5) {
  const query = userQuestion.toLowerCase();

  const scored = knowledgeBase.map(item => {
    let score = 0;
    const questionText = item.question.toLowerCase();
    const answerText = item.answer.toLowerCase();

    // キーワードマッチ（キーワード列）
    for (const kw of item.keywords) {
      if (query.includes(kw.toLowerCase())) {
        score += 3;
      }
    }

    // カテゴリマッチ
    if (query.includes(item.category.toLowerCase())) {
      score += 2;
    }

    // 質問テキスト部分マッチ
    const questionWords = questionText.split(/[\s、。？！]/);
    for (const word of questionWords) {
      if (word.length >= 2 && query.includes(word)) {
        score += 2;
      }
    }

    // 回答テキスト部分マッチ（補助）
    const answerWords = answerText.split(/[\s、。]/);
    for (const word of answerWords) {
      if (word.length >= 2 && query.includes(word)) {
        score += 1;
      }
    }

    return { ...item, score };
  });

  return scored
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ナレッジベース全体をコンテキストとして整形（フォールバック用）
function formatAllKnowledge() {
  const byCategory = {};
  for (const item of knowledgeBase) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }
  let text = '';
  for (const [cat, items] of Object.entries(byCategory)) {
    text += `\n【${cat}】\n`;
    for (const item of items) {
      text += `Q: ${item.question}\nA: ${item.answer}\n\n`;
    }
  }
  return text;
}

// チャットAPI
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'メッセージが必要です' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  const client = new Anthropic({ apiKey });

  // RAGで関連Q&Aを取得
  const relevant = retrieveRelevantQA(message);
  let ragContext = '';
  if (relevant.length > 0) {
    ragContext = relevant
      .map(item => `【${item.category}】\nQ: ${item.question}\nA: ${item.answer}`)
      .join('\n\n');
  } else {
    // 関連するものがなければ全件を渡す（件数が少ない場合を想定）
    ragContext = formatAllKnowledge();
  }

  const systemPrompt = `あなたは食品物流センター（50人規模）のQ&Aサポートスタッフです。
以下のナレッジベースに基づいて、従業員からの質問に丁寧かつ正確に回答してください。

【ナレッジベース】
${ragContext}

【回答ルール】
- ナレッジベースに記載のある内容を優先して回答すること
- 専門用語は分かりやすく説明すること
- 回答が見つからない場合は「ナレッジベースに該当情報がありません。担当者にお問い合わせください」と伝えること
- 日本語で回答すること
- 簡潔かつ具体的に答えること`;

  // 会話履歴を構築
  const messages = [];
  if (history && Array.isArray(history)) {
    for (const turn of history) {
      if (turn.role === 'user' || turn.role === 'assistant') {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Claude API エラー:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'AI応答の生成に失敗しました: ' + err.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ナレッジベース再読み込みAPI
app.post('/api/reload', (req, res) => {
  knowledgeBase = loadKnowledgeBase();
  res.json({ count: knowledgeBase.length, message: `${knowledgeBase.length} 件読み込みました` });
});

// ナレッジベース件数確認API
app.get('/api/knowledge-count', (req, res) => {
  res.json({ count: knowledgeBase.length });
});

// 起動時にナレッジベースを読み込む
knowledgeBase = loadKnowledgeBase();

app.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});
