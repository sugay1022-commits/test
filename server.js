const express = require('express');
const XLSX = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const USE_CLAUDE = !!process.env.ANTHROPIC_API_KEY;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let knowledgeBase = [];

function loadKnowledgeBase() {
  const xlsxPath = path.join(__dirname, 'qa_knowledge.xlsx');
  if (!fs.existsSync(xlsxPath)) {
    console.warn('[警告] qa_knowledge.xlsx が見つかりません');
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
      keywords: row['キーワード']
        ? String(row['キーワード']).split(/[,、]/).map(k => k.trim()).filter(Boolean)
        : [],
    }));
  console.log(`[KB] ${knowledge.length} 件読み込み完了`);
  return knowledge;
}

// スコアリング（bigram + キーワード + カテゴリ）
function bigramSet(text) {
  const set = new Set();
  const t = text.replace(/\s/g, '');
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function retrieveRelevantQA(userQuestion, topK = 6) {
  const query = userQuestion.toLowerCase();
  const queryBigrams = bigramSet(query);

  const scored = knowledgeBase.map(item => {
    let score = 0;

    // キーワード完全一致（高スコア）
    for (const kw of item.keywords) {
      if (query.includes(kw.toLowerCase())) score += 5;
    }

    // カテゴリ一致
    if (query.includes(item.category.toLowerCase())) score += 3;

    // 質問文 bigram 類似度
    const qBigrams = bigramSet(item.question.toLowerCase());
    let common = 0;
    for (const bg of queryBigrams) { if (qBigrams.has(bg)) common++; }
    const denom = Math.max(queryBigrams.size + qBigrams.size - common, 1);
    score += (common / denom) * 10;

    // 回答文 bigram (補助)
    const aBigrams = bigramSet(item.answer.toLowerCase());
    let aCommon = 0;
    for (const bg of queryBigrams) { if (aBigrams.has(bg)) aCommon++; }
    const aDenom = Math.max(queryBigrams.size + aBigrams.size - aCommon, 1);
    score += (aCommon / aDenom) * 4;

    return { ...item, score };
  });

  return scored
    .filter(item => item.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function formatAllKnowledge() {
  const byCategory = {};
  for (const item of knowledgeBase) {
    if (!byCategory[item.category]) byCategory[item.category] = [];
    byCategory[item.category].push(item);
  }
  return Object.entries(byCategory)
    .map(([cat, items]) =>
      `【${cat}】\n` + items.map(i => `Q: ${i.question}\nA: ${i.answer}`).join('\n\n')
    )
    .join('\n\n');
}

// デモモード: Claudeなしでキーワードマッチ回答
function demoAnswer(message) {
  const relevant = retrieveRelevantQA(message, 3);
  if (relevant.length === 0) {
    return 'ナレッジベースに該当情報が見つかりませんでした。担当者にお問い合わせください。';
  }
  const top = relevant[0];
  let response = `【${top.category}】\n\n${top.answer}`;
  if (relevant.length > 1) {
    response += '\n\n---\n関連する情報もあります：';
    for (const r of relevant.slice(1)) {
      response += `\n\n▶ **${r.question}**\n${r.answer}`;
    }
  }
  return response;
}

// SSEヘルパー
function sseChunk(res, text) {
  res.write(`data: ${JSON.stringify({ text })}\n\n`);
}
function sseDone(res) {
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  res.end();
}
function sseError(res, msg) {
  res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
  res.end();
}

// チャットAPI
app.post('/api/chat', async (req, res) => {
  const { message, history } = req.body;
  if (!message) return res.status(400).json({ error: 'メッセージが必要です' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // デモモード（APIキーなし）
  if (!USE_CLAUDE) {
    const answer = demoAnswer(message);
    // 疑似ストリーミング（30文字ずつ）
    const chunks = [];
    for (let i = 0; i < answer.length; i += 30) chunks.push(answer.slice(i, i + 30));
    for (const chunk of chunks) {
      sseChunk(res, chunk);
      await new Promise(r => setTimeout(r, 30));
    }
    sseDone(res);
    return;
  }

  // Claude RAGモード
  const relevant = retrieveRelevantQA(message);
  const ragContext = relevant.length > 0
    ? relevant.map(i => `【${i.category}】\nQ: ${i.question}\nA: ${i.answer}`).join('\n\n')
    : formatAllKnowledge();

  const systemPrompt = `あなたは食品物流センター（50人規模）のQ&Aサポートスタッフです。
以下のナレッジベースに基づいて、従業員からの質問に丁寧かつ正確に回答してください。

【ナレッジベース】
${ragContext}

【回答ルール】
- ナレッジベースに記載のある内容を優先して回答すること
- 手順は番号付きリストで分かりやすく示すこと
- 内線番号や担当部署が記載されている場合は必ず含めること
- 回答が見つからない場合は「ナレッジベースに該当情報がありません。担当者にお問い合わせください」と伝えること
- 日本語で回答し、簡潔かつ具体的に答えること`;

  const messages = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (turn.role === 'user' || turn.role === 'assistant') {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        sseChunk(res, event.delta.text);
      }
    }
    sseDone(res);
  } catch (err) {
    console.error('[Claude Error]', err.message);
    sseError(res, 'AI応答の生成に失敗しました: ' + err.message);
  }
});

// カテゴリ一覧API
app.get('/api/categories', (req, res) => {
  const categories = [...new Set(knowledgeBase.map(i => i.category))];
  res.json({ categories });
});

// カテゴリ別Q&A取得API
app.get('/api/qa', (req, res) => {
  const { category } = req.query;
  const items = category
    ? knowledgeBase.filter(i => i.category === category)
    : knowledgeBase;
  res.json({ items: items.map(({ category, question, answer }) => ({ category, question, answer })) });
});

// ナレッジベース件数確認API
app.get('/api/knowledge-count', (req, res) => {
  res.json({
    count: knowledgeBase.length,
    mode: USE_CLAUDE ? 'claude' : 'demo',
  });
});

// ナレッジベース再読み込みAPI
app.post('/api/reload', (req, res) => {
  knowledgeBase = loadKnowledgeBase();
  res.json({ count: knowledgeBase.length, message: `${knowledgeBase.length} 件読み込みました` });
});

knowledgeBase = loadKnowledgeBase();

app.listen(PORT, () => {
  console.log(`\n🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`📋 モード: ${USE_CLAUDE ? '✅ Claude RAGモード' : '🔶 デモモード（APIキーなし）'}`);
  console.log(`📚 ナレッジベース: ${knowledgeBase.length} 件\n`);
});
