const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const XLSX = require('xlsx');

const {
  EVALUATION_AXES,
  loadPlaybook,
  flattenPlaybook,
  retrieveRelevantPlaybookItems,
  buildSystemPrompt,
  checkIntervention,
  demoFeedback,
} = require('./lib/coaching');
const { appendLog, readLogs } = require('./lib/logStore');
const { buildWorkbook } = require('./lib/exportLogs');
const { buildDashboardSummary } = require('./lib/dashboard');

const app = express();
const PORT = process.env.PORT || 3000;
const USE_CLAUDE = !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const playbook = loadPlaybook();
const playbookItems = flattenPlaybook(playbook);

let client = null;
if (USE_CLAUDE) {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function generateFeedback({ withPlaybook, relevantItems, reportInput, history }) {
  const systemPrompt = buildSystemPrompt({ withPlaybook, relevantItems, reportInput });

  if (!USE_CLAUDE) {
    return demoFeedback({ withPlaybook, relevantItems, reportInput });
  }

  const messages = [];
  for (const turn of history || []) {
    if (turn.role === 'user' || turn.role === 'assistant') {
      messages.push({ role: turn.role, content: turn.content });
    }
  }
  messages.push({ role: 'user', content: reportInput.message });

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

// メタ情報API
app.get('/api/meta', (req, res) => {
  res.json({
    mode: USE_CLAUDE ? 'claude' : 'demo',
    evaluationAxes: EVALUATION_AXES,
  });
});

// playbook参照API（監査・透明性確認用）
app.get('/api/playbook', (req, res) => {
  res.json(playbook);
});

// 活動報告 / 相談 投稿API
app.post('/api/report', async (req, res) => {
  const {
    reporterId,
    customerType,
    activityType,
    prospectLevel,
    message,
    history,
  } = req.body;

  if (!message) return res.status(400).json({ error: 'message is required' });

  const reportInput = { message, customerType, activityType, prospectLevel };
  const isFirstTurn = !Array.isArray(history) || history.length === 0;
  const relevantItems = retrieveRelevantPlaybookItems(message, playbookItems, 3);

  try {
    let outputA = null;
    let outputB;

    if (isFirstTurn) {
      // 案2: A/B比較用に playbook 注入なし(a) / あり(b) の両方を生成
      [outputA, outputB] = await Promise.all([
        generateFeedback({ withPlaybook: false, relevantItems: [], reportInput, history }),
        generateFeedback({ withPlaybook: true, relevantItems, reportInput, history }),
      ]);
    } else {
      // 案1: 2回目以降の相談は文脈を保持して playbook 注入ありで応答
      outputB = await generateFeedback({ withPlaybook: true, relevantItems, reportInput, history });
    }

    const intervention = checkIntervention(message);

    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      reporterId: reporterId || '未指定',
      customerType: customerType || '未指定',
      activityType: activityType || '未指定',
      prospectLevel: prospectLevel || '未指定',
      reportText: message,
      turn: (history || []).filter(h => h.role === 'user').length + 1,
      outputA,
      outputB,
      playbookItemsUsed: relevantItems.map(i => i.id),
      intervention,
    };
    appendLog(logEntry);

    res.json({
      reply: outputB,
      intervention,
      playbookItemsUsed: relevantItems.map(i => ({ id: i.id, type: i.type, title: i.title })),
    });
  } catch (err) {
    console.error('[Coach Error]', err.message);
    res.status(500).json({ error: 'AI応答の生成に失敗しました: ' + err.message });
  }
});

// ログ一覧API（簡易確認用）
app.get('/api/logs', (req, res) => {
  res.json({ logs: readLogs() });
});

// 上長向け進捗ダッシュボード集計API
app.get('/api/dashboard/summary', (req, res) => {
  res.json(buildDashboardSummary(readLogs(), playbookItems));
});

// ログ・A/B評価用シートのエクスポートAPI
app.get('/api/logs/export', (req, res) => {
  const workbook = buildWorkbook();
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="coaching_logs_export.xlsx"');
  res.send(buffer);
});

app.listen(PORT, () => {
  console.log(`\n🚀 サーバー起動: http://localhost:${PORT}`);
  console.log(`📋 モード: ${USE_CLAUDE ? '✅ Claude コーチングモード' : '🔶 デモモード（APIキーなし）'}`);
  console.log(`📚 playbook項目: ${playbookItems.length} 件\n`);
});
