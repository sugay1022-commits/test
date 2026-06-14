const { ACTIVITY_TYPES, PROSPECT_LEVELS } = require('./coaching');

const UNSPECIFIED = '未指定';

function emptyCounts(keys) {
  const counts = {};
  for (const k of keys) counts[k] = 0;
  counts[UNSPECIFIED] = 0;
  return counts;
}

function reportTextPreview(reportText) {
  const text = reportText || '';
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// 部下の活動報告ログを上長向けダッシュボード用に集計する
// readLogs()呼び出しは毎回ファイル全体を読むが、PoC規模（数百件程度）では問題ない。
// ログが大量になった場合はメモリキャッシュ等を検討する。
function buildDashboardSummary(logs, playbookItems) {
  const playbookById = new Map(playbookItems.map(item => [item.id, item]));

  const repsById = new Map();
  const interventions = [];
  const playbookUsageById = new Map();
  let totalPlaybookItemsUsed = 0;
  let reportsToday = 0;
  const today = new Date().toDateString();

  for (const log of logs) {
    const reporterId = log.reporterId || UNSPECIFIED;

    if (!repsById.has(reporterId)) {
      repsById.set(reporterId, {
        reporterId,
        totalReports: 0,
        lastActivityAt: log.timestamp,
        activityTypeCounts: emptyCounts(ACTIVITY_TYPES),
        prospectLevelCounts: emptyCounts(PROSPECT_LEVELS),
        interventionCount: 0,
        recentActivity: [],
      });
    }
    const rep = repsById.get(reporterId);
    rep.totalReports += 1;
    if (new Date(log.timestamp) > new Date(rep.lastActivityAt)) {
      rep.lastActivityAt = log.timestamp;
    }

    const activityType = log.activityType || UNSPECIFIED;
    if (!(activityType in rep.activityTypeCounts)) rep.activityTypeCounts[UNSPECIFIED] += 1;
    else rep.activityTypeCounts[activityType] += 1;

    const prospectLevel = log.prospectLevel || UNSPECIFIED;
    if (!(prospectLevel in rep.prospectLevelCounts)) rep.prospectLevelCounts[UNSPECIFIED] += 1;
    else rep.prospectLevelCounts[prospectLevel] += 1;

    const intervention = log.intervention || {};
    if (intervention.flag) {
      rep.interventionCount += 1;
      interventions.push({
        id: log.id,
        timestamp: log.timestamp,
        reporterId,
        activityType,
        customerType: log.customerType || UNSPECIFIED,
        prospectLevel,
        reason: intervention.reason || '',
        reportTextPreview: reportTextPreview(log.reportText),
      });
    }

    rep.recentActivity.push({
      id: log.id,
      timestamp: log.timestamp,
      activityType,
      customerType: log.customerType || UNSPECIFIED,
      prospectLevel,
      intervention: { flag: !!intervention.flag, reason: intervention.reason || '' },
      reportTextPreview: reportTextPreview(log.reportText),
    });

    const itemsUsed = log.playbookItemsUsed || [];
    totalPlaybookItemsUsed += itemsUsed.length;
    const seenInThisLog = new Set();
    for (const itemId of itemsUsed) {
      if (!playbookUsageById.has(itemId)) {
        const pbItem = playbookById.get(itemId);
        playbookUsageById.set(itemId, {
          id: itemId,
          type: pbItem ? pbItem.type : '不明',
          title: pbItem ? pbItem.title : itemId,
          usageCount: 0,
          reps: new Set(),
        });
      }
      const usage = playbookUsageById.get(itemId);
      usage.usageCount += 1;
      usage.reps.add(reporterId);
      seenInThisLog.add(itemId);
    }

    if (new Date(log.timestamp).toDateString() === today) reportsToday += 1;
  }

  // 直近5件のみ保持し、新しい順に並べる
  for (const rep of repsById.values()) {
    rep.recentActivity = rep.recentActivity
      .slice()
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 5);
  }

  const reps = Array.from(repsById.values())
    .sort((a, b) => new Date(b.lastActivityAt) - new Date(a.lastActivityAt));

  const activeReps = reps.filter(r => r.reporterId !== UNSPECIFIED).length;

  interventions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const playbookUsage = Array.from(playbookUsageById.values())
    .map(usage => ({
      id: usage.id,
      type: usage.type,
      title: usage.title,
      usageCount: usage.usageCount,
      repsUsing: usage.reps.size,
    }))
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 10);

  const totalReports = logs.length;

  return {
    generatedAt: new Date().toISOString(),
    overview: {
      totalReports,
      activeReps,
      pendingInterventions: interventions.length,
      avgPlaybookItemsPerReport: totalReports === 0 ? 0 : totalPlaybookItemsUsed / totalReports,
      reportsToday,
    },
    reps,
    interventions,
    playbookUsage,
  };
}

module.exports = { buildDashboardSummary };
