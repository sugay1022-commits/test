const fs = require('fs');
const path = require('path');

const PLAYBOOK_PATH = path.join(__dirname, '..', 'playbook.json');

const EVALUATION_AXES = [
  '顧客理解（ニーズ・状況の引き出し）',
  '提案の具体性・適合度',
  '関係構築・信頼形成',
  '次のアクションの明確さ',
  '反論対応・粘り強さ',
];

const INTERVENTION_KEYWORDS = [
  'クレーム', '苦情', '失注', '解約', '契約見送り', 'キャンセル',
  '炎上', 'トラブル', '怒っ', '行き詰', '自信がない', '辞めたい', '限界',
];

const ACTIVITY_TYPES = [
  'コール(架電)', '初回面談(初訪)', 'アポ・再訪', '提案',
  '既契約の見直し提案', '契約・成約', 'フォロー',
];

const PROSPECT_LEVELS = ['高', '中', '低'];

function loadPlaybook() {
  if (!fs.existsSync(PLAYBOOK_PATH)) return { winningPatterns: [], talkScripts: [], objectionHandling: [] };
  return JSON.parse(fs.readFileSync(PLAYBOOK_PATH, 'utf-8'));
}

// playbookをRAG検索用にフラット化
function flattenPlaybook(playbook) {
  const items = [];
  for (const wp of playbook.winningPatterns || []) {
    items.push({
      id: wp.id,
      type: '勝ちパターン',
      title: wp.title,
      text: `状況: ${wp.situation}\nアプローチ: ${wp.approach}\nポイント: ${(wp.keyPoints || []).join(' / ')}`,
    });
  }
  for (const ts of playbook.talkScripts || []) {
    items.push({
      id: ts.id,
      type: 'トークスクリプト',
      title: ts.scene,
      text: ts.script,
    });
  }
  for (const ob of playbook.objectionHandling || []) {
    items.push({
      id: ob.id,
      type: '反論対応',
      title: ob.objection,
      text: ob.response,
    });
  }
  return items;
}

function bigramSet(text) {
  const set = new Set();
  const t = String(text).replace(/\s/g, '');
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function bigramSimilarity(a, b) {
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  let common = 0;
  for (const bg of setA) if (setB.has(bg)) common++;
  const denom = Math.max(setA.size + setB.size - common, 1);
  return common / denom;
}

// reportTextに関連するplaybook項目をtopK件抽出する
function retrieveRelevantPlaybookItems(reportText, items, topK = 3) {
  const scored = items.map(item => ({
    ...item,
    score: bigramSimilarity(reportText, `${item.title} ${item.text}`),
  }));
  return scored
    .filter(i => i.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function formatPlaybookItems(items) {
  if (items.length === 0) return '（関連するノウハウは見つかりませんでした）';
  return items
    .map(i => `■ [${i.id}] ${i.type}: ${i.title}\n${i.text}`)
    .join('\n\n');
}

// 助言生成用のsystemプロンプトを構築する
// withPlaybook=falseの場合は汎用LLM相当（playbook未注入）の出力(a)
// withPlaybook=trueの場合はplaybook注入後の出力(b)
function buildSystemPrompt({ withPlaybook, relevantItems, reportInput }) {
  const base = `あなたは保険代理店で20年の経験を持つベテラン営業マネージャーであり、AI営業コーチです。
部下である営業担当者から日々の活動報告・相談を受け、上長視点でフィードバックを行います。

【報告情報】
- 顧客区分: ${reportInput.customerType || '未指定'}
- 活動種別: ${reportInput.activityType || '未指定'}
- 見込み度: ${reportInput.prospectLevel || '未指定'}

【フィードバックの評価軸】
${EVALUATION_AXES.map(a => `- ${a}`).join('\n')}

【出力フォーマット】
以下の見出しで日本語、簡潔に回答してください。
【良かった点】
...
【改善点】
...
【次のアクション】
...`;

  if (!withPlaybook) {
    return base;
  }

  return `${base}

【当代理店のトップ営業ノウハウ（playbook）】
以下は当代理店のトップ営業の勝ちパターン・トークスクリプト・反論対応事例です。
報告内容と関連する場合は、これらの考え方や言い回しを具体的に踏まえてフィードバックしてください。

${formatPlaybookItems(relevantItems)}`;
}

// 介入要否（上長エスカレーション相当）の簡易判定
function checkIntervention(reportText) {
  const matched = INTERVENTION_KEYWORDS.filter(kw => reportText.includes(kw));
  if (matched.length > 0) {
    return { flag: true, reason: `要注意キーワード検出: ${matched.join(', ')}` };
  }
  return { flag: false, reason: '' };
}

// デモモード（APIキーなし）用のフィードバック生成
function demoFeedback({ withPlaybook, relevantItems, reportInput }) {
  const lines = [];
  lines.push('【良かった点】');
  lines.push(`${reportInput.activityType || '活動'}について、状況を具体的に報告できている点は良いです。`);
  lines.push('');
  lines.push('【改善点】');
  if (reportInput.prospectLevel === '低') {
    lines.push('見込み度が低い顧客に対して、その場での即決を狙いすぎていないか振り返りましょう。');
  } else {
    lines.push('顧客のニーズをもう一段掘り下げる質問ができると、提案の精度が上がります。');
  }
  lines.push('');
  lines.push('【次のアクション】');
  if (withPlaybook && relevantItems.length > 0) {
    const top = relevantItems[0];
    lines.push(`「${top.title}」の考え方を参考に、次回のアクションを設計しましょう。`);
    lines.push(`具体的には: ${top.text.split('\n')[0]}`);
  } else {
    lines.push('次回の接点（日時・手段）を必ず確保し、次回までに準備する資料を明確にしましょう。');
  }
  lines.push('');
  lines.push('（※デモモード: ANTHROPIC_API_KEY未設定のため、簡易テンプレート出力です）');
  return lines.join('\n');
}

module.exports = {
  EVALUATION_AXES,
  ACTIVITY_TYPES,
  PROSPECT_LEVELS,
  loadPlaybook,
  flattenPlaybook,
  retrieveRelevantPlaybookItems,
  buildSystemPrompt,
  checkIntervention,
  demoFeedback,
};
