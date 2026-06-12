const XLSX = require('xlsx');
const { readLogs } = require('./logStore');

// 全ログ・A/B評価用シート・正解マッピングシートを含むワークブックを生成する
function buildWorkbook() {
  const logs = readLogs();
  const workbook = XLSX.utils.book_new();

  // 1. 活動報告ログ全体（FR-61, FR-62）
  const logRows = logs.map(l => ({
    ID: l.id,
    日時: l.timestamp,
    報告者ID: l.reporterId,
    顧客区分: l.customerType,
    活動種別: l.activityType,
    見込み度: l.prospectLevel,
    報告本文: l.reportText,
    往復回数: l.turn,
    AIコーチ応答: l.outputB,
    'A/B比較あり': l.outputA ? 'あり' : 'なし',
    介入要否: l.intervention?.flag ? '要' : '不要',
    介入判定理由: l.intervention?.reason || '',
    参照playbookID: (l.playbookItemsUsed || []).join(', '),
  }));
  const logSheet = XLSX.utils.json_to_sheet(logRows);
  XLSX.utils.book_append_sheet(workbook, logSheet, '活動報告ログ');

  // 2. A/B評価用シート（盲検: FR-51, FR-52）
  const abEntries = logs.filter(l => l.outputA);
  const abRows = [];
  const mappingRows = [];
  for (const l of abEntries) {
    // playbook注入なし(a)/あり(b)をランダムに 出力1/出力2 へ割り当て、評価者には伏せる
    const aIsFirst = Math.random() < 0.5;
    const first = aIsFirst ? l.outputA : l.outputB;
    const second = aIsFirst ? l.outputB : l.outputA;
    abRows.push({
      ID: l.id,
      報告本文: l.reportText,
      出力1: first,
      出力2: second,
      '妥当性(1-5)': '',
      '具体性(1-5)': '',
      '実行可能性(1-5)': '',
      'どちらが良いか(1 or 2)': '',
      コメント: '',
    });
    mappingRows.push({
      ID: l.id,
      'playbook注入あり(b)': aIsFirst ? '出力2' : '出力1',
      'playbook注入なし(a)': aIsFirst ? '出力1' : '出力2',
      参照playbookID: (l.playbookItemsUsed || []).join(', '),
      'ノウハウ反映確認(任意記入)': '',
    });
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(abRows), 'A_B評価用(盲検)');

  // 3. 正解マッピング・ノウハウ反映率確認用（FR-53）
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(mappingRows), '正解マッピング');

  return workbook;
}

module.exports = { buildWorkbook };
