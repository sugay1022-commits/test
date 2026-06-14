/**
 * 活動報告ログをスプレッドシート(xlsx)へ出力する
 * 実行: node scripts/export_logs.js
 */
const path = require('path');
const XLSX = require('xlsx');
const { buildWorkbook } = require('../lib/exportLogs');

const outputPath = path.join(__dirname, '..', 'data', 'export.xlsx');
const workbook = buildWorkbook();
XLSX.writeFile(workbook, outputPath);
console.log(`✅ ログを出力しました: ${outputPath}`);
