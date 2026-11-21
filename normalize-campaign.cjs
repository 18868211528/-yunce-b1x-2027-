'use strict';
/* Official campaign data adapter. No credentials, network calls or stock extrapolation. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const COORDINATE_NOTE = '平台百度地图原始坐标口径（坐标系未单独确证；未作转换）';
const COMMERCIAL_NOTE = '刊例区间估算；税费、折扣、计费月定义及其他收费待业务确认。制作费按每辆本轮制作计入，不按月重复计。';
const EMPTY_PRICE = { monthlyLow: null, monthlyHigh: null, productionLow: null, productionHigh: null };

function normalizeRouteName(value) {
  const name = String(value ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')');
  return /^[\u4e00-\u9fff]*\d+路$/.test(name) ? name.slice(0, -1) : name;
}

function rowsFromExport(input, preferredSheet = '数据') {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object' && Array.isArray(input[preferredSheet])) return input[preferredSheet];
  throw new Error('导出数据须为包含表头的二维数组，或 {数据:二维数组}');
}

function checkedPeriod(query) {
  if (!query || !/^2027-\d{2}-\d{2}$/.test(query.start || '') || !/^2027-\d{2}-\d{2}$/.test(query.end || '') || !Number.isFinite(Date.parse(query.checkedAt || ''))) {
    throw new Error('必须提供有效2027完整查询起止日及实际checkedAt');
  }
  return { start: query.start, end: query.end, checkedAt: query.checkedAt, source: query.source || '红豆公交媒体库比赛专户' };
}

function idFor(prefix, value) {
  return prefix + crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function cleanCoverageEvidence(evidence) {
  // Explicit public fields: no server filesystem paths or login/request headers.
  return {
    anchorId: evidence.anchorId,
    source: '新云大数据可视化平台',
    sourceRef: evidence.sourceRef,
    sourceUrl: evidence.sourceUrl || 'https://flairmedia.com.cn:38880/',
    checkedAt: evidence.checkedAt,
    radiusMeters: evidence.radiusMeters,
    longitude: evidence.longitude,
    latitude: evidence.latitude,
    coordinateSystem: evidence.coordinateSystem || COORDINATE_NOTE,
    coordinateSource: '比赛可视化平台geocode中心；建筑/地标定位而非门店门口测绘。最近轨迹距离与最近站点距离由平台分别返回，不能等同店门步行距离。',
    lineId: evidence.lineId,
    rawRouteName: evidence.routeName,
    mediaType: evidence.mediaType,
    geocodeLevel: evidence.geocodeLevel,
    geocodeConfidence: evidence.geocodeConfidence,
    platformComputedDistanceMeters: evidence.platformComputedDistanceMeters,
    platformComputedStationDistanceMeters: evidence.platformComputedStationDistanceMeters,
    nearestStationWithinQueryRadius: evidence.nearestStationWithinQueryRadius,
    nearestPoint: evidence.nearestPoint,
    nearestStation: evidence.nearestStation,
    coordinateSystemVerified: false,
    coordinateTransformed: false
  };
}

function getReportedTotal(query) {
  const values = (query.queryResponses || []).map(response => response?.data?.data?.total).filter(Number.isFinite);
  return values.length ? values[values.length - 1] : null;
}

function buildDataset(inputs) {
  const {
    brandInfo, coverageNormalized, busExportRows, busQuery,
    metroExportRows, metroQuery, pricingRules,
    busSourceFile = '红豆公交库存_2027-03-01_2027-03-31.xlsx',
    metroSourceFile = '红豆地铁库存_2027-03-01_2027-03-31.xlsx',
    busSourceSheet = '数据'
  } = inputs;
  if (!brandInfo || !Array.isArray(brandInfo.anchors) || !coverageNormalized || !Array.isArray(coverageNormalized.queries) || !Array.isArray(coverageNormalized.busCandidates)) {
    throw new Error('须提供品牌锚点、规范化覆盖查询及公交候选');
  }
  if (!pricingRules || !Array.isArray(pricingRules.standardRates)) throw new Error('须提供经过核验的区间刊例规则');
  const inventoryPeriod = checkedPeriod(busQuery);
  const rows = rowsFromExport(busExportRows, busSourceSheet);
  const header = rows[0];
  const column = label => {
    const at = header.indexOf(label);
    if (at < 0) throw new Error('公交导出缺少字段：' + label);
    return at;
  };
  const columns = { route: column('线路'), operator: column('运营公司'), grade: column('线路等级'), form: column('媒体类型'), available: column('空位数') };
  const inventoryIndex = new Map();
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index];
    const route = String(row[columns.route] ?? '').trim();
    if (!route) continue;
    const key = normalizeRouteName(route);
    const item = { rowNumber: index + 1, route, operator: String(row[columns.operator] ?? ''), grade: String(row[columns.grade] ?? ''), mediaForm: String(row[columns.form] ?? ''), available: row[columns.available] };
    if (!Number.isSafeInteger(item.available) || item.available < 0 || item.available > 5000) throw new Error('公交导出空位数不是有效整数：第 ' + item.rowNumber + ' 行');
    if (!inventoryIndex.has(key)) inventoryIndex.set(key, []);
    inventoryIndex.get(key).push(item);
  }
  const queryByAnchor = new Map(coverageNormalized.queries.map(query => [query.anchorId, query]));
  const originalByAnchor = new Map(brandInfo.anchors.map(anchor => [anchor.id, anchor]));
  const anchors = brandInfo.anchors.map(anchor => {
    const query = queryByAnchor.get(anchor.id);
    if (!query || !query.center) throw new Error('品牌锚点缺少实际平台geocode：' + anchor.id);
    return {
      id: anchor.id, name: anchor.name, district: anchor.district || '',
      address: anchor.address, landmarkSearch: anchor.landmarkSearch || query.query,
      cluster: anchor.cluster || '', role: anchor.role || '',
      longitude: query.center.longitude, latitude: query.center.latitude,
      coordinateSystem: query.center.coordinateSystem || COORDINATE_NOTE,
      coordinateSource: '新云可视化平台geocode：' + query.center.level + '级，置信度' + query.center.confidence + '；建筑/地标中心，不是门店门口或入口测绘；' + query.center.sourceRef,
      sourceUrl: anchor.sourceUrl, sourceKind: anchor.sourceKind || '品牌官方门店信息',
      verification: anchor.verification + '；平台定位核对时间：' + query.checkedAt,
      geocodeLevel: query.center.level, geocodeConfidence: query.center.confidence,
      geocodePrecise: query.center.precise, geocodeComprehension: query.center.comprehension,
      geocodeSourceRef: query.center.sourceRef, geocodeCheckedAt: query.checkedAt,
      isExactStoreEntranceConfirmed: false, coordinateSystemVerified: false,
      coordinateTransformed: false,
      officialAddress: anchor.address,
      queryCenterName: query.query
    };
  });
  const availableRates = new Map(pricingRules.standardRates.filter(rate => rate.medium === '公交车身').map(rate => [rate.grade, rate]));
  const unresolvedBusRoutes = [], duplicateRouteDecisions = [];
  const resources = coverageNormalized.busCandidates.map(candidate => {
    const matches = inventoryIndex.get(candidate.normalizedRouteName) || [];
    let chosen = matches.length === 1 ? matches[0] : null;
    let duplicateNote = '';
    if (matches.length > 1) {
      const identity = new Set(matches.map(item => item.operator + '\u0000' + item.grade));
      const normalForms = matches.filter(item => ['大三侧', '车身三侧'].includes(item.mediaForm));
      if (identity.size === 1 && normalForms.length) {
        chosen = [...normalForms].sort((a, b) => (a.mediaForm === '大三侧' ? 0 : 1) - (b.mediaForm === '大三侧' ? 0 : 1) || a.rowNumber - b.rowNumber)[0];
        duplicateNote = '同名线路存在多个媒体形式；共享容量未确证，本次保守只采用' + chosen.mediaForm + '这一导出行，不累加其他形式。';
      } else duplicateNote = '同名线路对应多个运营公司或等级，资源身份未唯一确证，暂不计可售与报价。';
      duplicateRouteDecisions.push({ routeName: candidate.routeName, normalizedRouteName: candidate.normalizedRouteName, chosenSourceRow: chosen?.rowNumber ?? null, alternativeRows: matches.map(item => ({ sourceRow: item.rowNumber, operator: item.operator, grade: item.grade, mediaForm: item.mediaForm })), decision: duplicateNote });
    }
    const rate = chosen && ['大三侧', '车身三侧'].includes(chosen.mediaForm) ? availableRates.get(chosen.grade) : null;
    const price = rate ? { monthlyLow: rate.mediaPriceLowCny, monthlyHigh: rate.mediaPriceHighCny, productionLow: rate.production.lowCny, productionHigh: rate.production.highCny } : { ...EMPTY_PRICE };
    const evidence = candidate.coverageEvidence.map(cleanCoverageEvidence);
    const affectedAnchors = candidate.coverageAnchorIds.map(id => originalByAnchor.get(id)).filter(Boolean);
    const outside = evidence.filter(item => item.nearestStationWithinQueryRadius === false).length;
    let stockNote;
    if (chosen) stockNote = '红豆按' + inventoryPeriod.start + '至' + inventoryPeriod.end + '完整档期查询，读取时间' + inventoryPeriod.checkedAt + '；空位数' + chosen.available + '辆，来源导出' + busSourceSheet + '第' + chosen.rowNumber + '行。';
    else {
      stockNote = '未在当前' + (rows.length - 1) + '行公交导出范围内取得唯一精确线路匹配；不等于整个系统不存在该线路，可售、等级与报价保持未知。';
      unresolvedBusRoutes.push(candidate.routeName);
    }
    return {
      id: idFor('BUS-', candidate.normalizedRouteName + '|' + (chosen?.operator || '') + '|' + (chosen?.mediaForm || 'unresolved')),
      name: candidate.routeName + (chosen ? ' · ' + chosen.mediaForm : ' · 库存待匹配'),
      mediaType: 'bus', grade: chosen?.grade || '待核实',
      district: '锚点区：' + [...new Set(affectedAnchors.map(anchor => anchor.district))].join(' / '),
      operator: chosen?.operator || '待匹配', routeName: candidate.routeName,
      address: '公交线路轨迹覆盖，非固定门店门口广告位',
      available: chosen ? chosen.available : null,
      coverageAnchorIds: [...candidate.coverageAnchorIds], price,
      longitude: null, latitude: null, coordinateSystem: COORDINATE_NOTE,
      sourceFile: busSourceFile,
      sourceRef: chosen ? busSourceSheet + '!A' + chosen.rowNumber + ':K' + chosen.rowNumber : busSourceSheet + '（' + (rows.length - 1) + '条导出范围内未找到唯一规范化名称精确匹配）',
      sourceUrl: busQuery.pageUrl || 'https://flairmedia.com.cn:881/medium/inventory/inventory-bus',
      priceSourceFile: '07-媒体刊例价.xlsx',
      priceSourceRef: rate ? pricingRules.source.sheet + '!' + rate.sourceRef : '未取得对应普通公交等级/车型的适用刊例；未套用其他等级或特殊旅游线价格',
      coverageSourceRef: evidence.map(item => item.sourceRef).join('；'),
      coverageSourceUrl: 'https://flairmedia.com.cn:38880/',
      checkedAt: inventoryPeriod.checkedAt,
      inventoryPeriod: { ...inventoryPeriod },
      evidence: stockNote + duplicateNote + '覆盖来源为新云自身媒体、500米轨迹/站点分析，命中' + affectedAnchors.map(anchor => anchor.name).join('、') + '。' + (outside ? '其中' + outside + '条匹配的最近站点距离超过500米；' : '') + '线路轨迹近不等于最近站点或店门步行近，不代表广告接触、锁档或2027曝光。' + COMMERCIAL_NOTE,
      pricingNote: rate ? COMMERCIAL_NOTE : '未获得适用刊例，自动方案不选入；' + COMMERCIAL_NOTE,
      coverageEvidence: evidence,
      inventoryMatch: chosen ? { status: 'normalized_exact', normalizedRouteName: candidate.normalizedRouteName, rawRouteName: chosen.route, sourceRow: chosen.rowNumber, mediaForm: chosen.mediaForm, duplicateVariantsSummed: false } : { status: 'unresolved', normalizedRouteName: candidate.normalizedRouteName, duplicateVariantsSummed: false },
      normalizedRouteName: candidate.normalizedRouteName,
      sourceNature: '2027目标档期实时查询后的导出快照，非2026静态台账',
      priceNature: '官方脱敏刊例区间，非精确或全包报价'
    };
  });
  const metroPeriod = metroQuery ? checkedPeriod(metroQuery) : { ...inventoryPeriod };
  // Keep the original metro date as evidence. A bus refresh must never relabel old metro stock.
  const metroPeriodMismatch = metroPeriod.start !== inventoryPeriod.start || metroPeriod.end !== inventoryPeriod.end;
  for (const [index, candidate] of (coverageNormalized.separateCandidates || []).entries()) {
    const evidence = candidate.coverageEvidence.map(cleanCoverageEvidence);
    resources.push({
      id: 'METRO-CAND-' + String(index + 1).padStart(2, '0'),
      name: candidate.routeName + ' · ' + candidate.stationName + '（具体出口待核）',
      mediaType: 'metro', grade: '未匹配具体点位',
      district: '锚点区：' + [...new Set(candidate.coverageAnchorIds.map(id => originalByAnchor.get(id)?.district).filter(Boolean))].join(' / '),
      operator: '', routeName: candidate.routeName, address: candidate.stationName + '站（线路-站点层候选，非具体出口）',
      available: null, coverageAnchorIds: [], price: { ...EMPTY_PRICE },
      longitude: null, latitude: null, coordinateSystem: COORDINATE_NOTE,
      sourceFile: 'coverage-normalized.json', sourceRef: 'separateCandidates[' + index + ']；尚未确证红豆具体出口行',
      sourceUrl: 'https://flairmedia.com.cn:38880/',
      priceSourceFile: '07-媒体刊例价.xlsx', priceSourceRef: 'A8:F9及B27:F30（适用点位未确证，未套价）',
      coverageSourceRef: evidence.map(item => item.sourceRef).join('；'), coverageSourceUrl: 'https://flairmedia.com.cn:38880/',
      checkedAt: evidence[0]?.checkedAt || metroPeriod.checkedAt,
      inventoryPeriod: { ...metroPeriod },
      evidence: (metroPeriodMismatch ? '地铁资料仍为' + metroPeriod.start + '至' + metroPeriod.end + '，与当前公交查询不同档期，不沿用为当前库存。' : '') + '平台只返回' + candidate.routeName + '-' + candidate.stationName + '线路/最近站点层候选。需匹配具体出口、面积、2027完整档期可售及专门点位价格；站点处于500米内不能证明具体出口在500米内。已取得地铁库存导出' + metroSourceFile + '，但本条尚未完成精确点位关联，因此可售与四项价格均保持未知，不进入自动成案。',
      pricingNote: '具体出口、制作面积、可售与适用刊例均待核实；不可按0元填补。',
      coverageEvidence: evidence,
      requiresExactExitMatch: true, originalCoverageAnchorIds: [...candidate.coverageAnchorIds],
      inventoryMatch: { status: 'station_only_requires_exact_exit' }
    });
  }
  const campaign = brandInfo.campaign || {};
  const brand = {
    brand: brandInfo.brand || '星巴克', industry: brandInfo.industry || '食品饮料',
    campaignTitle: campaign.title || '下一站，附近的一杯',
    campaignStatus: campaign.status || '参赛团队策划假设，非品牌已公布活动',
    audience: campaign.audience || '上海日常通勤与核心商圈休闲消费人群（策略假设）',
    brandSources: brandInfo.brandSources || [],
    brandUnderstanding: '以品牌官网确认的上海线下门店为锚点，把门店体验与日常通勤、核心商圈消费场景连接。提案选择“下一站，附近的一杯”作为2027年策划设想；先做门店所在建筑/地标500米轨迹覆盖，再核对同档期公交可售与刊例区间，不把品牌事实、策划假设、覆盖候选和投放结果混为一谈。',
    verifiedAsOf: brandInfo.verifiedAsOf,
    limitations: '门店营业及2027入口定位需在正式投放前复核；本方案不是品牌已授权或已公布的商业活动。'
  };
  const busResources = resources.filter(resource => resource.mediaType === 'bus');
  const matched = busResources.filter(resource => resource.inventoryMatch.status === 'normalized_exact');
  const priced = matched.filter(resource => Object.values(resource.price).every(Number.isSafeInteger));
  const busTotal = getReportedTotal(busQuery);
  const metroRows = metroExportRows ? rowsFromExport(metroExportRows) : [];
  const coverageTimes = coverageNormalized.queries.map(query => query.checkedAt).sort();
  const counts = {
    anchorCount: anchors.length,
    busCoverageCandidateCount: busResources.length,
    busExportRowCount: rows.length - 1,
    busSystemReportedTotal: busTotal,
    busExportEqualsSystemReportedTotal: busTotal === null ? null : rows.length - 1 === busTotal,
    busExactlyMatchedRouteCount: matched.length,
    busUnmatchedRouteCount: busResources.length - matched.length,
    busIntervalPricedCount: priced.length,
    busPositiveAvailabilityCount: matched.filter(resource => resource.available > 0).length,
    busZeroAvailabilityCount: matched.filter(resource => resource.available === 0).length,
    busPriceCompletePositiveAvailabilityCount: priced.filter(resource => resource.available > 0).length,
    busKnownAvailableVehicleCount: matched.reduce((total, resource) => total + resource.available, 0),
    metroExportRowCount: Math.max(0, metroRows.length - 1),
    pendingMetroCandidateCount: resources.length - busResources.length,
    duplicateRouteDecisionCount: duplicateRouteDecisions.length
  };
  const data = {
    version: 'official-campaign-' + inventoryPeriod.start + '_' + inventoryPeriod.end + '-snapshot-' + inventoryPeriod.checkedAt,
    brand, brandInfo: brand, inventoryPeriod, anchors, resources,
    defaultBrief: { brand: brand.brand, industry: brand.industry, campaign: brand.campaignTitle, campaignTitle: brand.campaignTitle, audience: brand.audience, budget: 2000000, months: 1, mediaTypes: ['bus'], anchorIds: anchors.map(anchor => anchor.id), start: inventoryPeriod.start, end: inventoryPeriod.end },
    evidenceStatus: {
      brandVerifiedCount: anchors.length,
      coverageQueryCount: coverageNormalized.queries.length,
      coverageSource: '新云大数据可视化平台 · 新云自身媒体 · 500米覆盖分析',
      coverageCheckedAt: coverageTimes.at(-1) || '',
      coverageEarliestCheckedAt: coverageTimes[0] || '',
      inventorySource: inventoryPeriod.source,
      inventoryCheckedAt: inventoryPeriod.checkedAt,
      priceSource: '07-媒体刊例价.xlsx · 区间化脱敏刊例',
      liveInventoryQueried: true,
      exactQuoteConfirmed: false,
      sourceCountDiscrepancy: busTotal !== null && busTotal !== rows.length - 1,
      sourceCountDiscrepancyNote: busTotal === null ? '系统列表总数未记录，不声称导出全量。' : '红豆列表返回总数' + busTotal + '，本次Excel导出' + (rows.length - 1) + '行；只在实际导出范围内精确匹配，不声称' + busTotal + '条全量已纳入。',
      unresolvedBusRoutes,
      unresolvedSourceCount: unresolvedBusRoutes.length + counts.pendingMetroCandidateCount,
      pendingMetroExitMatchCount: counts.pendingMetroCandidateCount,
      ...counts
    },
    sourceCounts: counts,
    pendingMetroCandidateIds: resources.filter(resource => resource.mediaType === 'metro').map(resource => resource.id),
    duplicateRouteDecisions,
    sourceDocuments: [
      { file: busSourceFile, sheet: busSourceSheet, role: '按2027目标完整档期查询的公交可售导出', sourceUrl: busQuery.pageUrl || 'https://flairmedia.com.cn:881/medium/inventory/inventory-bus', checkedAt: inventoryPeriod.checkedAt },
      { file: metroSourceFile, sheet: '数据', role: '按2027目标完整档期查询的地铁导出；尚未用于具体出口成案', sourceUrl: metroQuery?.pageUrl || 'https://flairmedia.com.cn:881/medium/inventory/inventory-metro', checkedAt: metroPeriod.checkedAt },
      { file: 'coverage-all.json', role: '逐锚点覆盖分析与原始geocode/轨迹距离证据', sourceUrl: 'https://flairmedia.com.cn:38880/' },
      { file: '07-媒体刊例价.xlsx', sheet: pricingRules.source.sheet, role: '公交月度刊例与每辆本轮制作费的区间依据' }
    ],
    commercialTerms: { ...pricingRules.commercialTerms, warning: COMMERCIAL_NOTE },
    limitations: [
      '当前公交库存是按实际查询时刻取得的' + inventoryPeriod.start + '至' + inventoryPeriod.end + '完整档期快照，不代表已锁位；地铁保留各自原始档期，日期变化或正式采购前必须重新核对。',
      '只将54条覆盖命中公交候选与实际导出范围精确关联，未匹配旅游线不进行模糊替换。',
      busTotal === null ? '公交系统总量未记载。' : '列表总数' + busTotal + '与实际导出' + (rows.length - 1) + '行存在差异，不声称全量库存已接入。',
      '地图中心是品牌门店地址对应的建筑/商场/地标定位，不是店门精确测绘；坐标使用平台百度地图原始口径，未单独确证坐标系、未作转换。',
      '覆盖是线路轨迹或最近站点层的关系，不等同店门步行可达、实际广告接触、独立触达、到店或销售。',
      '14个地铁线路-站点候选尚未匹配具体出口、面积、库存与专价，可见但不自动成案。',
      '报价是官方脱敏区间；税费、折扣、计费月定义及其他费用待确认，不标为精确含税全包价。',
      '没有把2026-11-13静态台账空位用于2027可售，也没有把2023历史人流外推为2027曝光。',
      '库存和报价来自确定性数据适配；未在本数据文件中声称已调用比赛模型。'
    ]
  };
  return data;
}

function cli() {
  const official = path.join(__dirname, 'official');
  const read = name => JSON.parse(fs.readFileSync(path.join(official, name), 'utf8'));
  const data = buildDataset({
    brandInfo: read('brand-anchors.json'), coverageNormalized: read('coverage-normalized.json'),
    busExportRows: read('红豆公交库存_2027-03-01_2027-03-31.json'), busQuery: read('redbean-bus-query.json'),
    metroExportRows: read('红豆地铁库存_2027-03-01_2027-03-31.json'), metroQuery: read('redbean-metro-query.json'),
    pricingRules: read('pricing-rules.json')
  });
  const engine = require('./studio/campaign-engine.js');
  const validated = engine.validate(data);
  if (validated.errors.length) throw new Error('数据未通过CampaignEngine.validate：\n' + validated.errors.join('\n'));
  const budgetChecks = [];
  for (const budget of [1000000, 2000000, 5000000]) {
    const brief = { ...data.defaultBrief, budget };
    const result = engine.plan(data, brief);
    const summary = engine.summarize(data, result.selection, brief);
    if (result.errors.length || summary.errors.length || !summary.feasible || summary.high > budget) throw new Error('预算验证失败：' + budget + ' / ' + [...result.errors, ...summary.errors].join('；'));
    budgetChecks.push({ budget, low: summary.low, high: summary.high, remainingHigh: summary.remainingHigh, busUnits: summary.busUnits, resourceCount: summary.resourceCount, coveredAnchorIds: summary.coveredAnchorIds, uncoveredAnchorIds: summary.uncoveredAnchorIds, planWarnings: result.warnings, excludedStats: result.excludedStats });
  }
  data.verification = { schemaValidation: 'passed', budgetChecks };
  fs.writeFileSync(path.join(official, 'campaign-dataset.json'), JSON.stringify(data, null, 2) + '\n');
  fs.writeFileSync(path.join(__dirname, 'studio/campaign-data.js'), '/* Official competition snapshot; no login credentials. See evidenceStatus and limitations. */\nglobalThis.CAMPAIGN_DATA = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n');
  console.log(JSON.stringify({ validation: 'PASS', counts: data.sourceCounts, budgetChecks }, null, 2));
}

module.exports = { buildDataset, normalizeRouteName, rowsFromExport };
if (require.main === module) cli();
