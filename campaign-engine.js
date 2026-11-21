/*
 * 云策 2027 campaign planning engine.
 * Quantity means simultaneous physical buses / metro points in the full queried period.
 * CNY integers only; no daily proration, discount, tax, audience or traffic inference.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CampaignEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MEDIA = new Set(['bus', 'metro']);
  const MONEY_FIELDS = ['monthlyLow', 'monthlyHigh', 'productionLow', 'productionHigh'];
  const ANCHOR_TEXT_FIELDS = ['id', 'name', 'district', 'address', 'landmarkSearch', 'cluster', 'role', 'coordinateSystem', 'coordinateSource', 'sourceUrl', 'sourceKind', 'verification'];
  const RESOURCE_TEXT_FIELDS = ['id', 'name', 'mediaType', 'grade', 'district', 'operator', 'routeName', 'address', 'coordinateSystem', 'sourceRef', 'sourceFile', 'sourceUrl', 'priceSourceRef', 'priceSourceFile', 'coverageSourceRef', 'coverageSourceUrl', 'checkedAt', 'evidence', 'pricingNote'];
  const METHOD = '覆盖优先、费用上界约束的贪心启发式；不保证全局最优';
  const COMMERCIAL_WARNING = '刊例区间估算；税费、折扣、计费月定义及其他收费待业务确认。计费月数独立输入，不按天折算。';

  function quantity(selection, id) {
    return selection && typeof selection === 'object' && !Array.isArray(selection) && Object.hasOwn(selection, id) ? selection[id] : 0;
  }

  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
    const result = Date.parse(value + 'T00:00:00Z');
    return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : NaN;
  }

  function text(value, label, errors, max = 1000, required = false) {
    if ((value === undefined || value === null) && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      errors.push(label + ' 须为' + (required ? '非空' : '') + '文本，最多 ' + max + ' 字');
      return '';
    }
    return value;
  }

  function url(value, label, errors) {
    const result = text(value, label, errors, 2000);
    if (result && !/^https?:\/\//.test(result)) errors.push(label + ' 只允许 http(s) 链接');
    return result;
  }

  function coordinate(raw, label, low, high, errors) {
    if (raw === undefined || raw === null) return null;
    if (!Number.isFinite(raw) || raw < low || raw > high) {
      errors.push(label + ' 坐标值无效');
      return null;
    }
    return raw;
  }

  function ids(raw, label, errors, max = 500) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > max) {
      errors.push(label + ' 须为不超过 ' + max + ' 项的 ID 数组');
      return [];
    }
    const result = [];
    const seen = new Set();
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim() || item.length > 120) errors.push(label + ' 含无效 ID');
      else if (seen.has(item)) errors.push(label + ' 含重复 ID：' + item);
      else { seen.add(item); result.push(item); }
    }
    return result;
  }

  function period(raw, label, errors, required = true) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(label + ' 须包含完整库存查询区间');
      return { start: '', end: '', checkedAt: '', source: '' };
    }
    const result = {
      start: text(raw.start, label + '.start', errors, 10, true),
      end: text(raw.end, label + '.end', errors, 10, true),
      checkedAt: text(raw.checkedAt, label + '.checkedAt', errors, 100, required),
      source: text(raw.source, label + '.source', errors, 1000, required)
    };
    if (!Number.isFinite(date(result.start)) || !Number.isFinite(date(result.end)) || date(result.end) < date(result.start)) errors.push(label + ' 起止日期无效');
    if (result.checkedAt && !Number.isFinite(Date.parse(result.checkedAt))) errors.push(label + '.checkedAt 查询时间无效');
    return result;
  }

  function coverageEvidence(raw, label, errors) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 500) {
      errors.push(label + ' 须为覆盖分析证据数组，最多 500 项');
      return [];
    }
    return raw.map((item, index) => {
      const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
      const prefix = label + '[' + index + ']';
      const result = {};
      for (const key of ['anchorId', 'source', 'sourceRef', 'checkedAt', 'coordinateSystem', 'coordinateSource']) result[key] = text(source[key], prefix + '.' + key, errors, 1000);
      result.sourceUrl = url(source.sourceUrl, prefix + '.sourceUrl', errors);
      result.longitude = coordinate(source.longitude, prefix + '.longitude', -180, 180, errors);
      result.latitude = coordinate(source.latitude, prefix + '.latitude', -90, 90, errors);
      if (source.radiusMeters !== undefined && (!Number.isFinite(source.radiusMeters) || source.radiusMeters <= 0 || source.radiusMeters > 100000)) errors.push(prefix + '.radiusMeters 覆盖半径无效');
      else if (source.radiusMeters !== undefined) result.radiusMeters = source.radiusMeters;
      return result;
    });
  }

  function validate(raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['数据集须为对象'], dataset: null };
    const dataset = {
      version: text(raw.version, 'version', errors, 200, true),
      inventoryPeriod: period(raw.inventoryPeriod, 'inventoryPeriod', errors),
      anchors: [],
      resources: []
    };
    if (!Array.isArray(raw.anchors) || raw.anchors.length > 500) errors.push('anchors 须为最多 500 项的锚点数组');
    else {
      const seen = new Set();
      dataset.anchors = raw.anchors.map((item, index) => {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        const prefix = 'anchors[' + index + ']';
        const result = {};
        for (const key of ANCHOR_TEXT_FIELDS) result[key] = key === 'sourceUrl' ? url(source[key], prefix + '.' + key, errors) : text(source[key], prefix + '.' + key, errors, key === 'id' ? 120 : 1000, key === 'id' || key === 'name');
        result.longitude = coordinate(source.longitude, prefix + '.longitude', -180, 180, errors);
        result.latitude = coordinate(source.latitude, prefix + '.latitude', -90, 90, errors);
        if (seen.has(result.id)) errors.push(prefix + ' 锚点 ID 重复');
        seen.add(result.id);
        return result;
      });
    }
    if (!Array.isArray(raw.resources) || raw.resources.length > 5000) errors.push('resources 须为最多 5000 项的资源数组');
    else {
      const seen = new Set();
      dataset.resources = raw.resources.map((item, index) => {
        const source = item && typeof item === 'object' && !Array.isArray(item) ? item : {};
        const prefix = 'resources[' + index + ']';
        const result = {};
        for (const key of RESOURCE_TEXT_FIELDS) {
          result[key] = key.endsWith('Url') ? url(source[key], prefix + '.' + key, errors) : text(source[key], prefix + '.' + key, errors, key === 'id' ? 120 : key === 'evidence' ? 4000 : 1000, ['id', 'name', 'mediaType', 'sourceRef'].includes(key));
        }
        if (seen.has(result.id)) errors.push(prefix + ' 资源 ID 重复');
        seen.add(result.id);
        if (!MEDIA.has(result.mediaType)) errors.push(prefix + '.mediaType 须为 bus 或 metro');
        result.available = source.available === undefined ? null : source.available;
        if (result.available !== null && (!Number.isSafeInteger(result.available) || result.available < 0 || result.available > 5000)) errors.push(prefix + '.available 须为 0–5000 整数或 null（未知）');
        result.coverageAnchorIds = ids(source.coverageAnchorIds, prefix + '.coverageAnchorIds', errors);
        const price = source.price && typeof source.price === 'object' && !Array.isArray(source.price) ? source.price : {};
        result.price = {};
        for (const key of MONEY_FIELDS) {
          result.price[key] = price[key] === undefined ? null : price[key];
          if (result.price[key] !== null && (!Number.isSafeInteger(result.price[key]) || result.price[key] < 0)) errors.push(prefix + '.price.' + key + ' 须为非负整数元或 null');
        }
        for (const [low, high] of [['monthlyLow', 'monthlyHigh'], ['productionLow', 'productionHigh']]) if (Number.isSafeInteger(result.price[low]) && Number.isSafeInteger(result.price[high]) && result.price[low] > result.price[high]) errors.push(prefix + '.price 的下界不能高于上界');
        result.longitude = coordinate(source.longitude, prefix + '.longitude', -180, 180, errors);
        result.latitude = coordinate(source.latitude, prefix + '.latitude', -90, 90, errors);
        result.coverageEvidence = coverageEvidence(source.coverageEvidence, prefix + '.coverageEvidence', errors);
        if (source.inventoryPeriod !== undefined) result.inventoryPeriod = period(source.inventoryPeriod, prefix + '.inventoryPeriod', errors, false);
        return result;
      });
    }
    return { errors, dataset };
  }

  function quote(resource, count, months = 1) {
    const errors = [];
    if (!Number.isSafeInteger(count) || count < 0 || count > 5000) errors.push('物理媒介数量须为 0–5000 整数');
    if (!Number.isSafeInteger(months) || months < 1 || months > 12) errors.push('计费月数须为 1–12 整数');
    if (errors.length) return { low: null, high: null, complete: false, errors };
    if (count === 0) return { low: 0, high: 0, complete: true, errors: [] };
    const price = resource && resource.price ? resource.price : {};
    const validMoney = value => Number.isSafeInteger(value) && value >= 0;
    const total = (monthly, production) => validMoney(monthly) && validMoney(production) && Number.isSafeInteger(count * (monthly * months + production)) ? count * (monthly * months + production) : null;
    const low = total(price.monthlyLow, price.productionLow);
    const high = total(price.monthlyHigh, price.productionHigh);
    if (low === null || high === null) errors.push('月刊例或制作费区间不完整（面积/映射待核实），不可按零元补齐');
    for (const [lower, upper] of [['monthlyLow', 'monthlyHigh'], ['productionLow', 'productionHigh']]) if (validMoney(price[lower]) && validMoney(price[upper]) && price[lower] > price[upper]) errors.push('月刊例或制作费的下界高于上界');
    if (low !== null && high !== null && low > high) errors.push('费用下界高于上界');
    return { low, high, complete: errors.length === 0, errors };
  }

  function validateBrief(dataset, raw) {
    const errors = [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: ['Brief 须为对象'], brief: null };
    const brief = {
      budget: raw.budget,
      months: raw.months === undefined ? 1 : raw.months,
      mediaTypes: ids(raw.mediaTypes, 'mediaTypes', errors, 2),
      anchorIds: ids(raw.anchorIds, 'anchorIds', errors),
      start: raw.start,
      end: raw.end
    };
    if (!Number.isSafeInteger(brief.budget) || brief.budget < 1000000 || brief.budget > 5000000) errors.push('预算须为 100–500 万元之间的整数元');
    if (!Number.isSafeInteger(brief.months) || brief.months < 1 || brief.months > 12) errors.push('计费月数须为 1–12 整数');
    if (!brief.mediaTypes.length || brief.mediaTypes.some(type => !MEDIA.has(type))) errors.push('请至少选择公交车身或地铁出入口之一');
    if (!Number.isFinite(date(brief.start)) || !Number.isFinite(date(brief.end)) || date(brief.end) < date(brief.start) || !/^2027-/.test(brief.start) || !/^2027-/.test(brief.end)) errors.push('投放起止日期须为有效的 2027 年内完整档期');
    if (brief.start !== dataset.inventoryPeriod.start || brief.end !== dataset.inventoryPeriod.end) errors.push('投放日期必须与红豆库存完整查询档期完全一致，不可跨档期沿用库存');
    const anchorIds = new Set(dataset.anchors.map(anchor => anchor.id));
    if (!brief.anchorIds.length) errors.push('请至少选择一个门店或地标锚点');
    for (const id of brief.anchorIds) if (!anchorIds.has(id)) errors.push('未知门店或地标锚点：' + id);
    return { errors, brief };
  }

  function periodMatches(resource, dataset) {
    const p = resource.inventoryPeriod;
    return !p || (p.start === dataset.inventoryPeriod.start && p.end === dataset.inventoryPeriod.end);
  }

  function matchingAnchors(resource, brief) {
    const requested = new Set(brief.anchorIds);
    return resource.coverageAnchorIds.filter(id => requested.has(id));
  }

  function selectionErrors(dataset, selection, brief) {
    const errors = [];
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return ['资源选择须为 ID 到整数数量的对象'];
    const byId = new Map(dataset.resources.map(resource => [resource.id, resource]));
    let knownHigh = 0;
    for (const id of Object.keys(selection)) {
      const count = quantity(selection, id);
      if (!byId.has(id)) { errors.push('未知资源：' + id); continue; }
      const resource = byId.get(id);
      if (!Number.isSafeInteger(count) || count < 0 || count > 5000) { errors.push(resource.name + ' 的物理媒介数量无效'); continue; }
      if (count === 0) continue;
      if (resource.available === null) errors.push(resource.name + ' 缺少同档期可售数量');
      else if (count > resource.available) errors.push(resource.name + ' 数量超过同档期可售上限');
      if (!periodMatches(resource, dataset)) errors.push(resource.name + ' 的库存档期与当前查询不符');
      if (!brief.mediaTypes.includes(resource.mediaType)) errors.push(resource.name + ' 不符合已选媒体类型');
      if (!matchingAnchors(resource, brief).length) errors.push(resource.name + ' 缺少已选锚点的覆盖依据');
      const subtotal = quote(resource, count, brief.months);
      if (!subtotal.complete) errors.push(resource.name + ' 报价不完整：' + subtotal.errors.join('；'));
      if (subtotal.high !== null) knownHigh += subtotal.high;
    }
    if (knownHigh > brief.budget) errors.push('已知费用上界超过预算');
    return errors;
  }

  function checkSelection(rawDataset, selection, rawBrief) {
    const input = validate(rawDataset);
    if (input.errors.length) return input.errors;
    const result = validateBrief(input.dataset, rawBrief);
    if (result.errors.length) return result.errors;
    return selectionErrors(input.dataset, selection, result.brief);
  }

  function summarize(rawDataset, selection, rawBrief) {
    const empty = { low: null, high: null, knownLow: 0, knownHigh: 0, complete: false, quantity: 0, resourceCount: 0, busUnits: 0, metroUnits: 0, coveredAnchorIds: [], uncoveredAnchorIds: [], remainingHigh: null, rows: [], feasible: false, errors: [], commercialWarning: COMMERCIAL_WARNING };
    const input = validate(rawDataset);
    if (input.errors.length) return { ...empty, errors: input.errors };
    const result = validateBrief(input.dataset, rawBrief);
    if (result.errors.length) return { ...empty, errors: result.errors };
    const dataset = input.dataset, brief = result.brief;
    const errors = selectionErrors(dataset, selection, brief);
    const summary = { ...empty, low: 0, high: 0, complete: true, errors, rows: [] };
    const covered = new Set();
    for (const resource of dataset.resources) {
      const count = quantity(selection, resource.id);
      if (!Number.isSafeInteger(count) || count <= 0 || count > 5000) continue;
      const subtotal = quote(resource, count, brief.months);
      summary.quantity += count;
      summary.resourceCount++;
      if (resource.mediaType === 'bus') summary.busUnits += count;
      if (resource.mediaType === 'metro') summary.metroUnits += count;
      if (subtotal.low === null) summary.low = null;
      else { summary.knownLow += subtotal.low; if (summary.low !== null) summary.low += subtotal.low; }
      if (subtotal.high === null) summary.high = null;
      else { summary.knownHigh += subtotal.high; if (summary.high !== null) summary.high += subtotal.high; }
      summary.complete = summary.complete && subtotal.complete;
      const validStock = resource.available !== null && count <= resource.available && periodMatches(resource, dataset) && brief.mediaTypes.includes(resource.mediaType);
      if (validStock) for (const id of matchingAnchors(resource, brief)) covered.add(id);
      summary.rows.push({ ...resource, quantity: count, months: brief.months, low: subtotal.low, high: subtotal.high, complete: subtotal.complete, start: brief.start, end: brief.end });
    }
    summary.coveredAnchorIds = brief.anchorIds.filter(id => covered.has(id));
    summary.uncoveredAnchorIds = brief.anchorIds.filter(id => !covered.has(id));
    summary.remainingHigh = summary.high === null ? null : brief.budget - summary.high;
    summary.feasible = summary.quantity > 0 && !errors.length && summary.complete;
    return summary;
  }

  function plan(rawDataset, rawBrief, excluded = [], constraints = {}) {
    const selection = Object.create(null);
    const excludedStats = { total: 0, eligible: 0, excludedByUser: 0, mediaTypeMismatch: 0, periodMismatch: 0, unknownAvailability: 0, soldOut: 0, missingCoverage: 0, incompletePrice: 0, unitOverBudget: 0, budgetLimited: 0 };
    const base = { selection, errors: [], excludedStats, method: METHOD, coveredAnchorIds: [], uncoveredAnchorIds: [], warnings: [COMMERCIAL_WARNING] };
    const input = validate(rawDataset);
    if (input.errors.length) return { ...base, errors: input.errors };
    const result = validateBrief(input.dataset, rawBrief);
    if (result.errors.length) return { ...base, errors: result.errors };
    if (!Array.isArray(excluded) || excluded.some(id => typeof id !== 'string')) return { ...base, errors: ['excluded 须为资源 ID 数组'] };
    const dataset = input.dataset, brief = result.brief, blocked = new Set(excluded), candidates = [];
    const budgetLimit = constraints.spendLimit ?? brief.budget, busLimit = constraints.maxBusUnits ?? 5000;
    if (!Number.isSafeInteger(budgetLimit) || budgetLimit < 0 || budgetLimit > brief.budget || !Number.isSafeInteger(busLimit) || busLimit < 0 || busLimit > 5000) return { ...base, errors: ['执行约束的预算或公交数量上限无效'] };
    excludedStats.total = dataset.resources.length;
    for (const resource of dataset.resources) {
      let reason;
      const unit = quote(resource, 1, brief.months);
      const matches = matchingAnchors(resource, brief);
      if (blocked.has(resource.id)) reason = 'excludedByUser';
      else if (!brief.mediaTypes.includes(resource.mediaType)) reason = 'mediaTypeMismatch';
      else if (!periodMatches(resource, dataset)) reason = 'periodMismatch';
      else if (resource.available === null) reason = 'unknownAvailability';
      else if (resource.available === 0) reason = 'soldOut';
      else if (!matches.length) reason = 'missingCoverage';
      else if (!unit.complete) reason = 'incompletePrice';
      else if (unit.high > brief.budget) reason = 'unitOverBudget';
      if (reason) excludedStats[reason]++;
      else candidates.push({ resource, high: unit.high, matches });
    }
    excludedStats.eligible = candidates.length;
    let spent = 0, busCount = 0;
    const covered = new Set();
    // First add a single physical unit from the resource with the best new-anchor/cost ratio.
    // Stable tie breaks: more new anchors, lower upper cost, then source order.
    while (covered.size < brief.anchorIds.length) {
      let best = null, bestGain = 0, bestRatio = -1;
      for (const item of candidates) {
        if (quantity(selection, item.resource.id) >= item.resource.available || spent + item.high > budgetLimit || (item.resource.mediaType === 'bus' && busCount >= busLimit)) continue;
        const gain = item.matches.filter(id => !covered.has(id)).length;
        if (!gain) continue;
        const ratio = item.high === 0 ? Infinity : gain / item.high;
        if (!best || ratio > bestRatio || (ratio === bestRatio && (gain > bestGain || (gain === bestGain && item.high < best.high)))) { best = item; bestGain = gain; bestRatio = ratio; }
      }
      if (!best) break;
      selection[best.resource.id] = quantity(selection, best.resource.id) + 1;
      if (best.resource.mediaType === 'bus') busCount++;
      spent += best.high;
      for (const id of best.matches) covered.add(id);
    }
    // Only after all requested anchors are covered, add physical media by lowest upper unit cost.
    // Bulk additions are equivalent to repeated lowest-cost increments because cost is linear.
    if (covered.size === brief.anchorIds.length) {
      const sorted = candidates.map((item, index) => ({ ...item, index })).sort((a, b) => a.high - b.high || a.index - b.index);
      for (const item of sorted) {
        const current = quantity(selection, item.resource.id), stock = item.resource.available - current;
        const affordable = item.high === 0 ? stock : Math.floor((budgetLimit - spent) / item.high);
        const add = Math.max(0, Math.min(stock, affordable, item.resource.mediaType === 'bus' ? busLimit - busCount : stock));
        if (!add) continue;
        selection[item.resource.id] = current + add;
        if (item.resource.mediaType === 'bus') busCount += add;
        spent += add * item.high;
      }
    }
    excludedStats.budgetLimited = candidates.filter(item => quantity(selection, item.resource.id) < item.resource.available && spent + item.high > brief.budget).length;
    base.coveredAnchorIds = brief.anchorIds.filter(id => covered.has(id));
    base.uncoveredAnchorIds = brief.anchorIds.filter(id => !covered.has(id));
    if (base.uncoveredAnchorIds.length) base.warnings.push('仍有 ' + base.uncoveredAnchorIds.length + ' 个目标锚点未覆盖；未进入覆盖齐全后的加量阶段。');
    base.errors = selectionErrors(dataset, selection, brief);
    return base;
  }

  return { validate, quote, plan, checkSelection, summarize, quantity };
});
