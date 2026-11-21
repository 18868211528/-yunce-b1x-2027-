/* Cloud-free planning UI. Model credentials stay in this page's memory only. */
(function () {
  'use strict';
  const E = globalThis.CampaignEngine;
  const P = globalThis.CampaignPlanning;
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const mediaName = type => type === 'bus' ? '公交车身' : type === 'metro' ? '地铁出入口' : '未知媒介';
  const unitName = type => type === 'bus' ? '辆' : '点';
  const money = value => Number.isSafeInteger(value) ? '¥' + value.toLocaleString('zh-CN') : '待报价';
  const wan = value => Number.isSafeInteger(value) ? (value / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '待核';
  const interval = (low, high, suffix = '') => low === null || high === null ? '报价待补齐' : (low === high ? money(low) : money(low) + '–' + money(high)) + suffix;
  const INDUSTRIES = ['银行保险', '食品饮料', '保健品', '私立医院', '乐园（主题公园）'];
  const COMMERCIAL = '刊例区间估算；税费、折扣、计费月定义及其他收费待业务确认。制作费按每辆/每点本次制作计入一次，不重复按月计费。';
  let data, brief, selection = Object.create(null), excluded = [], baseline = null, lastPlan = null, aiNarrative = null;
  let toastTimer, revision = 0, aiEverSucceeded = false, aiReceipt = null, serviceHealth = null;
  const build = globalThis.CAMPAIGN_BUILD || {};
  let planning = P.defaults(), executionMode = false;
  let strategies;
  const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录';

  function toast(message) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 5500);
  }
  function publicText(value, field, max = 1000) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.length > max) throw Error(field + ' 必须为最多 ' + max + ' 字的文本');
    return value;
  }
  function publicLink(value, field) {
    const result = publicText(value, field, 2000);
    if (result && !/^https?:\/\//.test(result)) throw Error(field + ' 仅允许 http(s) 链接');
    return result;
  }
  function sanitizeBrand(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('数据需要公开品牌元数据 brand 对象');
    const result = {};
    for (const field of ['brand', 'industry', 'campaignTitle', 'campaignStatus', 'audience', 'brandUnderstanding']) result[field] = publicText(raw[field], 'brand.' + field, field === 'brandUnderstanding' ? 3000 : 1000);
    if (!result.brand.trim() || !INDUSTRIES.includes(result.industry)) throw Error('品牌名称不能为空，行业必须属于赛题指定五类');
    if (!Array.isArray(raw.brandSources ?? []) || (raw.brandSources ?? []).length > 40) throw Error('brandSources 须为最多 40 项的公开来源数组');
    result.brandSources = (raw.brandSources ?? []).map((source, index) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) throw Error('brandSources[' + index + '] 格式错误');
      return { title: publicText(source.title, '品牌来源标题'), url: publicLink(source.url, '品牌来源链接'), use: publicText(source.use, '品牌来源用途') };
    });
    return result;
  }
  function normalizeData(raw) {
    const checked = E.validate(raw);
    if (checked.errors.length) throw Error(checked.errors.slice(0, 8).join('；'));
    const result = { ...checked.dataset, brand: sanitizeBrand(raw.brand || raw.brandInfo) };
    // Only public, factual evidence counters are retained; these never create availability.
    const source = raw.evidenceStatus;
    if (source && typeof source === 'object' && !Array.isArray(source)) {
      result.evidenceStatus = {};
      for (const field of ['brandVerifiedCount', 'coverageQueryCount']) if (Number.isSafeInteger(source[field]) && source[field] >= 0 && source[field] <= 500) result.evidenceStatus[field] = source[field];
      for (const field of ['coverageSource', 'coverageCheckedAt']) if (typeof source[field] === 'string') result.evidenceStatus[field] = publicText(source[field], 'evidenceStatus.' + field);
    }
    return result;
  }
  function copySelection(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('项目资源选择格式错误');
    const next = Object.create(null), ids = new Set(data.resources.map(resource => resource.id));
    for (const id of Object.keys(raw)) {
      if (!ids.has(id) || !Number.isSafeInteger(raw[id]) || raw[id] < 0 || raw[id] > 5000) throw Error('项目包含未知资源或非法物理数量');
      if (raw[id]) next[id] = raw[id];
    }
    return next;
  }
  function defaultBrief(dataset) {
    return { brand: dataset.brand.brand, industry: dataset.brand.industry, campaign: dataset.brand.campaignTitle, audience: dataset.brand.audience, budget: 2000000, months: 1, start: dataset.inventoryPeriod.start, end: dataset.inventoryPeriod.end, mediaTypes: ['bus'], anchorIds: dataset.anchors.map(anchor => anchor.id) };
  }
  function planningFor(dataset) { const p = P.defaults(); if (dataset.brand.brand !== '星巴克' || dataset.brand.industry !== '食品饮料') { p.clientAlias = '某' + dataset.brand.industry + '品牌上海市场'; p.businessGoal = '待客户经营资料确认后定义具体生意问题；当前仅建立门店周边媒体规划假设，不继承原研究样本的经营需求。'; } return p; }
  function brandMatches() { return brief.brand.trim() === data.brand.brand.trim() && brief.industry === data.brand.industry; }
  function periodMatches(resource) {
    const period = resource.inventoryPeriod || data.inventoryPeriod;
    return brief.start === data.inventoryPeriod.start && brief.end === data.inventoryPeriod.end && period.start === brief.start && period.end === brief.end;
  }
  function matchingAnchors(resource) { return resource.coverageAnchorIds.filter(id => brief.anchorIds.includes(id)); }
  function stateFor(resource) {
    if (!brandMatches()) return { canAdd: false, reason: '品牌已变更，须接入对应门店与覆盖' };
    if (!periodMatches(resource)) return { canAdd: false, reason: '库存查询档期不符' };
    if (!brief.mediaTypes.includes(resource.mediaType)) return { canAdd: false, reason: '未选择该媒介类型' };
    if (!matchingAnchors(resource).length) return { canAdd: false, reason: '未匹配所选门店覆盖' };
    if (resource.available === null) return { canAdd: false, reason: '同档期可售数量未知' };
    if (!resource.available) return { canAdd: false, reason: '同档期无可售数量' };
    return { canAdd: true, reason: E.quote(resource, 1, brief.months).complete ? '同档期已知数量，来源须复核' : '报价不完整，可试选但不能导出' };
  }
  function summary() { return E.summarize(data, selection, brief); }
  function invalidate() { aiNarrative = null; revision++; }
  function go(page) {
    if (!['workspace', 'planning', 'proposal', 'sources', 'progress'].includes(page)) return;
    $$('.page').forEach(el => el.classList.toggle('active', el.id === page));
    $$('.nav').forEach(el => el.classList.toggle('active', el.dataset.page === page));
    const label = $('#pageLabel');
    if (label) label.textContent = { workspace: '提案工作台', planning: '需求与执行', proposal: '客户方案', sources: '数据与证据', progress: '交付进度' }[page];
    if (page === 'proposal') renderProposal();
    history.replaceState(null, '', '#' + page);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function syncFields() {
    for (const id of ['brand', 'industry', 'audience', 'campaign', 'start', 'end', 'months']) if ($('#' + id)) $('#' + id).value = brief[id];
    $('#budget').value = brief.budget / 10000;
    $('#budgetNumber').value = brief.budget / 10000;
    $('#mediaBus').checked = brief.mediaTypes.includes('bus');
    $('#mediaMetro').checked = brief.mediaTypes.includes('metro');
    for (const key of Object.keys(planning)) if ($('#' + key)) $('#' + key).value = key === 'executionReserve' ? planning[key] / 10000 : planning[key];
  }
  function runPlan(showToast = true) {
    const result = P.strategyPlan(E, data, brief, excluded, planning, executionMode);
    lastPlan = result;
    selection = result.selection;
    invalidate();
    render();
    if (showToast) {
      if (result.errors.length) toast(result.errors.slice(0, 2).join('；'));
      else if (!Object.keys(selection).length) toast('没有可成案资源：请核对同档期可售数量、完整报价及门店覆盖');
      else toast('已按门店覆盖优先生成组合；上界预算受控，结果为启发式方案');
    }
    return result;
  }
  function explanation(result) {
    if (!brandMatches()) return '品牌或行业已经变化。原品牌门店圈选已清空；请导入该客户的门店与覆盖分析，再使用当前库存核对可售并成案。';
    if (result.errors.length && !result.resourceCount) return result.errors.slice(0, 3).join('；') + '。当前未生成可执行组合。';
    if (!result.resourceCount) return '品牌门店与覆盖依据已接入，但当前筛选下尚无可成案组合。未知可售数量、档期不符或报价缺失不会被当成可售或零成本。请查询红豆完整档期并补齐必要报价。';
    return '当前配置 ' + result.busUnits + ' 辆公交、' + result.metroUnits + ' 个地铁点位，涉及 ' + result.resourceCount + ' 条线路/点位，匹配 ' + result.coveredAnchorIds.length + '/' + brief.anchorIds.length + ' 个所选门店锚点。刊例区间 ' + interval(result.low, result.high) + '；' + (result.high === null ? '报价不完整，不能确认预算余量。' : result.high > brief.budget ? '已知费用上界超过预算 ' + money(result.high - brief.budget) + '。' : '已知费用上界余量 ' + money(brief.budget - result.high) + '。') + (lastPlan ? '采用先覆盖新增锚点、再按最低上界单价加量的贪心策略，不保证全局最优。' : '这是人工调整后的组合，须逐项审阅。') + '不推算2027曝光、到店或销售提升。';
  }
  function renderAnchors() {
    const locked = !brandMatches();
    $('#anchorGrid').innerHTML = data.anchors.map((anchor, index) => '<div class="anchor-choice' + (brief.anchorIds.includes(anchor.id) ? ' selected' : '') + '"><label><input type="checkbox" data-anchor="' + index + '" ' + (brief.anchorIds.includes(anchor.id) ? 'checked ' : '') + (locked ? 'disabled' : '') + '><span><strong>' + esc(anchor.name) + '</strong><small>' + esc(anchor.cluster || anchor.district || '商圈未提供') + '</small></span></label><button class="text-btn" data-anchor-source="' + index + '">来源</button></div>').join('') || '<p class="empty">暂无门店锚点，请导入对应品牌数据。</p>';
  }
  function renderMatrix(result) {
    const anchors = data.anchors.filter(anchor => brief.anchorIds.includes(anchor.id));
    const types = brief.mediaTypes.length ? brief.mediaTypes : ['bus', 'metro'];
    let html = '<div class="matrix" style="--cols:' + types.length + '"><div class="matrix-label">匹配物理量</div>' + types.map(type => '<div class="matrix-label">' + mediaName(type) + '</div>').join('');
    for (const anchor of anchors) {
      html += '<div class="matrix-label row" title="' + esc(anchor.name) + '">' + esc(anchor.cluster || anchor.name) + '</div>';
      for (const type of types) {
        const count = result.rows.filter(resource => resource.mediaType === type && periodMatches(resource) && resource.available !== null && resource.quantity <= resource.available && resource.coverageAnchorIds.includes(anchor.id)).reduce((sum, resource) => sum + resource.quantity, 0);
        html += '<div class="matrix-cell' + (count ? ' active' : '') + '" style="--intensity:' + (count ? Math.min(count / Math.max(1, result.quantity), 1) : 0) + ';--cell-color:#173e37" title="' + esc(anchor.name + ' / ' + mediaName(type) + ' / ' + count + unitName(type)) + '">' + (count ? count + ' ' + unitName(type) : '—') + '</div>';
      }
    }
    html += '</div><div class="matrix-foot">仅计有覆盖分析映射的所选物理媒体；同一线路可匹配多个门店，不可跨行相加当作独立媒体。</div>';
    $('#matrix').innerHTML = anchors.length ? html : '<p class="empty">请选择该品牌的门店锚点。</p>';
  }
  function renderAllocation(result) {
    $('#allocation').innerHTML = ['bus', 'metro'].map(type => {
      const rows = result.rows.filter(resource => resource.mediaType === type);
      const known = rows.every(resource => resource.high !== null);
      const total = rows.reduce((sum, resource) => sum + (resource.high ?? 0), 0);
      return '<div class="alloc-item"><div class="alloc-label"><span>' + mediaName(type) + '</span><span>' + (known ? wan(total) + ' 万' : '待补报价') + '</span></div><div class="bar-track"><div class="bar-fill" style="width:' + (result.high > 0 && known ? total / result.high * 100 : 0) + '%"></div></div></div>';
    }).join('');
    $('#balance').innerHTML = result.high === null ? '预算余量<b>暂无法确认</b>' : (result.high > brief.budget ? '已知费用上界超出预算' : '已知费用上界余量') + '<b class="' + (result.high > brief.budget ? 'error-text' : '') + '">' + money(Math.abs(brief.budget - result.high)) + '</b>';
  }
  function renderInventory() {
    const query = ($('#resourceSearch')?.value || '').trim().toLowerCase(), type = $('#resourceMedia')?.value || 'all';
    const rows = data.resources.map((resource, index) => ({ resource, index })).filter(({ resource }) => (type === 'all' || resource.mediaType === type) && (!query || [resource.id, resource.name, resource.grade, resource.district, resource.operator].some(value => String(value || '').toLowerCase().includes(query))));
    $('#inventoryCount').textContent = ' / ' + rows.length + ' 条显示 · ' + data.resources.length + ' 条资料';
    $('#inventoryRows').innerHTML = rows.map(({ resource: resource, index }) => {
      const count = E.quantity(selection, resource.id), state = stateFor(resource), cost = E.quote(resource, count, brief.months), blocked = excluded.includes(resource.id);
      const cap = state.canAdd ? resource.available : 0;
      return '<tr class="' + (count ? 'selected-row' : blocked ? 'excluded-row' : '') + '"><td><strong>' + esc(resource.name) + '</strong><small>' + esc(resource.id) + ' · <button class="text-btn" data-source="' + index + '">查看依据</button></small></td><td>' + mediaName(resource.mediaType) + '<small>' + esc(resource.grade || '级别待核') + (resource.operator ? ' · ' + esc(resource.operator) : '') + '</small></td><td>' + (resource.available === null ? '<span class="chip amber">未知</span>' : resource.available + ' ' + unitName(resource.mediaType)) + '<small>' + esc(state.reason) + '</small></td><td>' + interval(resource.price.monthlyLow, resource.price.monthlyHigh) + '<small>/ ' + unitName(resource.mediaType) + '/月；制作 ' + interval(resource.price.productionLow, resource.price.productionHigh) + '/' + unitName(resource.mediaType) + '·次</small></td><td><div class="quantity"><button data-qty="' + index + '" data-delta="-1" aria-label="减少 ' + esc(resource.name) + '" ' + (!count ? 'disabled' : '') + '>−</button><input class="physical-quantity" data-count="' + index + '" type="number" min="0" max="' + Math.max(cap, count) + '" step="1" value="' + count + '" aria-label="' + esc(resource.name) + '物理数量" ' + (!state.canAdd && !count ? 'disabled' : '') + '><button data-qty="' + index + '" data-delta="1" aria-label="增加 ' + esc(resource.name) + '" ' + (!state.canAdd || count >= cap ? 'disabled' : '') + '>+</button></div></td><td>' + interval(cost.low, cost.high) + '</td><td><button class="remove-btn" data-remove="' + index + '">' + (blocked ? '恢复候选' : '排除') + '</button></td></tr>';
    }).join('') || '<tr><td colspan="7" class="empty">没有匹配的资源。</td></tr>';
  }
  function coverageDescription(resource) {
    const names = resource.coverageAnchorIds.map(id => data.anchors.find(anchor => anchor.id === id)?.name || id);
    const refs = resource.coverageEvidence.map(item => [data.anchors.find(anchor => anchor.id === item.anchorId)?.name || item.anchorId, item.sourceRef || item.source, item.radiusMeters ? item.radiusMeters + ' 米' : '半径未提供'].filter(Boolean).join(' / '));
    return [names.length ? '映射门店：' + names.join('、') : '未匹配门店', ...refs, resource.coverageSourceRef].filter(Boolean).join('；');
  }
  function renderEvidence() {
    $('#dataVersion').textContent = '版本：' + data.version;
    $('#evidenceRows').innerHTML = data.resources.map((resource, index) => {
      const period = resource.inventoryPeriod || data.inventoryPeriod;
      return '<tr><td><strong>' + esc(resource.name) + '</strong><small>' + esc(resource.id) + ' · <button class="text-btn" data-evidence-source="' + index + '">完整依据</button></small></td><td>' + esc(period.start + ' 至 ' + period.end) + '<small>查询/导出：' + esc(period.checkedAt || resource.checkedAt || '未提供') + '</small><small>' + esc(resource.sourceFile || '文件名未提供') + ' · ' + esc(resource.sourceRef) + '</small><small>可售：' + (resource.available === null ? '未知，不外推' : resource.available + unitName(resource.mediaType)) + '</small></td><td>' + esc(resource.priceSourceFile || '刊例文件名未提供') + '<small>' + esc(resource.priceSourceRef || '单元格定位未提供') + '</small><small>' + esc(resource.pricingNote || '适用媒体与制作口径须复核') + '</small></td><td>' + esc(coverageDescription(resource)) + '</td><td>' + link(resource.sourceUrl, '库存来源') + link(resource.coverageSourceUrl, '覆盖来源') + (!resource.sourceUrl && !resource.coverageSourceUrl ? '由原文件定位' : '') + '</td></tr>';
    }).join('');
  }
  function link(href, label) { return href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a> ' : ''; }
  function detailList(items) { return '<dl>' + items.map(([key, value]) => '<dt>' + esc(key) + '</dt><dd>' + esc(value || '未提供') + '</dd>').join('') + '</dl>'; }
  function showResourceSource(index) {
    const resource = data.resources[index];
    if (!resource) return;
    const period = resource.inventoryPeriod || data.inventoryPeriod;
    $('#sourceDetail').innerHTML = '<h3>' + esc(resource.name) + '</h3><span class="chip ' + (periodMatches(resource) && resource.available !== null ? 'green' : 'amber') + '">' + (periodMatches(resource) && resource.available !== null ? '同档期数量已入库，尚不代表锁档' : '库存档期或数量待核') + '</span>' + detailList([
      ['资源 ID / 媒体 / 等级', resource.id + ' / ' + mediaName(resource.mediaType) + ' / ' + (resource.grade || '未提供')],
      ['完整库存查询区间', period.start + ' 至 ' + period.end], ['查询/导出时间', period.checkedAt || resource.checkedAt], ['库存来源', period.source], ['库存原文件及定位', (resource.sourceFile || '文件名未提供') + ' / ' + resource.sourceRef],
      ['同档期可售物理数量', resource.available === null ? '未知；不使用静态单日空位代替2027完整档期' : resource.available + unitName(resource.mediaType)],
      ['月刊例区间', interval(resource.price.monthlyLow, resource.price.monthlyHigh) + ' / ' + unitName(resource.mediaType) + '/月'], ['制作费区间', interval(resource.price.productionLow, resource.price.productionHigh) + ' / ' + unitName(resource.mediaType) + '·次'],
      ['刊例文件及定位', (resource.priceSourceFile || '未提供') + ' / ' + (resource.priceSourceRef || '未提供')], ['价格适用说明', resource.pricingNote], ['门店覆盖分析', coverageDescription(resource)], ['其他依据', resource.evidence]
    ]) + '<p>' + esc(COMMERCIAL) + '</p>' + link(resource.sourceUrl, '打开库存来源') + link(resource.coverageSourceUrl, '打开覆盖来源');
    $('#sourceDialog').showModal();
  }
  function showAnchorSource(index) {
    const anchor = data.anchors[index];
    if (!anchor) return;
    $('#sourceDetail').innerHTML = '<h3>' + esc(anchor.name) + '</h3>' + detailList([['门店 ID', anchor.id], ['官网地址', anchor.address], ['商圈', anchor.cluster], ['角色', anchor.role], ['定位检索词', anchor.landmarkSearch], ['坐标', anchor.longitude === null || anchor.latitude === null ? '尚无可用坐标，不能据此推算距离' : anchor.longitude + ', ' + anchor.latitude], ['坐标系 / 来源', (anchor.coordinateSystem || '未提供') + ' / ' + (anchor.coordinateSource || '未提供')], ['核对说明', anchor.verification], ['公开来源类型', anchor.sourceKind]]) + link(anchor.sourceUrl, '打开品牌门店原始来源');
    $('#sourceDialog').showModal();
  }
  function renderProgress() {
    const verified = data.evidenceStatus?.brandVerifiedCount ?? data.anchors.filter(anchor => anchor.sourceUrl && anchor.verification).length;
    const coveredQueryIds = new Set(data.resources.flatMap(resource => resource.coverageEvidence.filter(item => item.sourceRef || item.source).map(item => item.anchorId)).filter(Boolean));
    const queries = data.evidenceStatus?.coverageQueryCount ?? coveredQueryIds.size;
    const stock = data.resources.filter(resource => periodMatches(resource) && resource.available !== null).length;
    const steps = [
      ['✓', '赛题与资料包', '已读取完整赛题、系统说明、静态台账与区间刊例；静态2026单日库存不替代2027档期。', '已读取', false],
      [verified >= data.anchors.length && data.anchors.length ? '✓' : '…', '品牌门店依据', verified + ' 个门店有来源核对记录；2027营业与投放入口仍须上线前复核。', verified + '/' + data.anchors.length + ' 个有据', verified < data.anchors.length || !data.anchors.length],
      [queries >= data.anchors.length && data.anchors.length ? '✓' : '…', '门店覆盖分析', queries + ' 个门店查询有记录。仅采用平台映射，不以地址猜测线路覆盖。', queries + ' 次有据', queries < data.anchors.length || !data.anchors.length],
      [stock ? '✓' : '…', '2027 同档期可售核对', stock + '/' + data.resources.length + ' 条资源具有当前完整查询档期的已知可售数量；查询时间与来源逐条可查。', stock ? '已有同档期输入' : '待同步/导入', !stock],
      [aiEverSucceeded || build.ai?.passed ? '✓' : '…', '真实 Flash 接口联调', aiEverSucceeded ? '本页面于' + stamp(aiReceipt?.completedAt) + '取得真实接口返回；AI只解释策略，金额仍由引擎计算。' : build.ai?.passed ? '连接模块于' + stamp(build.verifiedAt) + '使用比赛专户实测成功。当前页面尚未调用；在线模式填写自己的比赛密钥后可生成解读。' : '连接比赛专户后主动生成解读，当前显示规则摘要。', aiEverSucceeded ? '本页已取得返回' : build.ai?.passed ? '接口已实测' : '待连接', !(aiEverSucceeded || build.ai?.passed)],
      [build.inventory?.passed ? '✓' : '…', '实时库存同步', build.inventory?.passed ? '连接模块已实测3月、4月完整档期查询与导出。仅刷新公交库存，地铁保留原始日期和待核状态；登录失效时保留原数据。' : '需在完整版中登录比赛浏览器，再按当前档期重新查询。', build.inventory?.passed ? '已实测' : '待连接', !build.inventory?.passed],
      ['↗', '源码与比赛提交', '源码仓库已发布。本地完整版运行状态见下方；B1X提交状态请在赛事平台确认，最终提交由队长操作。', '以平台为准', false]
    ];
    $('#progressSteps').innerHTML = steps.map(([mark, title, body, status, pending]) => '<article class="step ' + (pending ? 'pending' : '') + '"><div class="step-mark">' + mark + '</div><div><h2>' + esc(title) + '</h2><p>' + esc(body) + '</p></div><span class="chip ' + (pending ? 'amber' : 'green') + '">' + esc(status) + '</span></article>').join('');
    $('#progressSteps').insertAdjacentHTML('beforeend', '<section class="panel"><h2>运行与提交入口</h2><p>' + (location.protocol === 'file:' ? '当前为离线版。需要AI或库存重查时，请先解压交付包，双击“启动完整版.cmd”。' : serviceHealth?.localService ? '本地服务已连接。比赛浏览器：' + (serviceHealth.inventory.browser ? '已连接，登录情况在同步时检查' : '请通过启动器打开') + '；库存读取依赖：' + (serviceHealth.inventory.python && serviceHealth.inventory.dependency ? '已就绪' : '请按说明书安装') + '。' : '正在检查本地服务。') + '</p><div class="inline-actions"><a class="btn" target="_blank" rel="noopener noreferrer" href="https://github.com/18868211528/-yunce-b1x-2027-">打开源码仓库</a><a class="btn dark" target="_blank" rel="noopener noreferrer" href="https://b1x.work/events/competitions/cmp_d76ad4530fe1447d8707d3247ce5c7ad?tab=work">到B1X查看提交</a></div><p>本地运行不等于公网部署，赛事最终状态以B1X显示为准。</p></section>');
  }
  function render() {
    const result = summary(), known = data.resources.filter(resource => periodMatches(resource) && resource.available !== null).length;
    const heading = $('#workspace .page-heading h1'), description = $('#workspace .heading-description'), tags = $('#workspace .heading-tags');
    if (heading) heading.innerHTML = esc(brief.campaign || '上海户外媒介投放方案') + '<span class="teal">。</span>';
    if (description) description.textContent = brief.brand + '上海区域投放提案 · 从有来源的门店，走到可售媒介与预算。';
    if (tags) tags.innerHTML = [brief.industry, brief.mediaTypes.map(mediaName).join(' / ') || '未选择媒介', '团队策划假设，非品牌委托'].map(value => '<span>' + esc(value) + '</span>').join('');
    $$('.budget-preset').forEach(button => { const selected = Number(button.dataset.budget) * 10000 === brief.budget; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
    const brandSourcePanel = $('.source-links li:last-child');
    if (brandSourcePanel) brandSourcePanel.innerHTML = '<b>已入库品牌与上海门店：' + esc(data.brand.brand) + '</b>' + data.brand.brandSources.map(source => link(source.url, source.title)).join('') + '<p>' + (brandMatches() ? '来源仍须在2027正式投放前复核；门店地址不等于已完成媒介覆盖判断。' : '当前Brief已换品牌，以上来源不能作为新品牌的门店或覆盖依据。') + '</p>';
    $('#modeBadge').textContent = known ? '同档期已知库存 ' + known + ' 条 · 非锁档承诺' : '2027可售待核 · 不以静态台账替代';
    $('#modeBadge').classList.toggle('real', known > 0);
    const notice = $('#sourceNotice');
    if (notice) {
      const badge = notice.querySelector('span'), paragraph = notice.querySelector('p');
      if (badge) badge.textContent = known ? '来源可追溯' : '真实资料，库存待核';
      if (paragraph) paragraph.textContent = !brandMatches() ? '品牌或行业已变更，原门店与覆盖不能沿用。请导入对应客户资料。' : known ? COMMERCIAL : '已接入带来源的门店与覆盖输入；当前未核定资源的2027完整档期可售数量，系统保持待核，不生成虚假可售或曝光。';
      notice.classList.toggle('real', known > 0);
    }
    $('#spendMetric').innerHTML = result.low === null || result.high === null ? '待补齐<em>报价</em>' : wan(result.low) + (result.low === result.high ? '' : '–' + wan(result.high)) + '<em>万元</em>';
    $('#spendMetric').classList.toggle('error-text', result.high !== null && result.high > brief.budget);
    $('#budgetUse').textContent = result.high === null ? '费用有缺项，不能确认预算内' : '已知费用上界占预算 ' + (result.high / brief.budget * 100).toFixed(1) + '% · 税费待确认';
    $('#coveredMetric').innerHTML = result.coveredAnchorIds.length + '<em>/ ' + brief.anchorIds.length + ' 个锚点</em>';
    $('#coverageMetric').textContent = '覆盖映射来自比赛平台，不代表去重触达人群';
    $('#resourceMetric').innerHTML = result.resourceCount + '<em>条线路/点位</em>';
    $('#unitsDetail').textContent = result.busUnits + ' 辆公交 / ' + result.metroUnits + ' 个地铁点位';
    $('#reasoning').textContent = aiNarrative?.strategy || explanation(result);
    $('#aiStatus').textContent = aiNarrative ? 'Flash 策略解读 · 需审阅' : '规则摘要 · 未调用AI';
    const stats = lastPlan?.excludedStats;
    $('#methodLine').textContent = lastPlan ? lastPlan.method + (stats ? '；可用候选 ' + stats.eligible + '；可售未知 ' + stats.unknownAvailability + '；报价不全 ' + stats.incompletePrice + '；覆盖不匹配 ' + stats.missingCoverage : '') : '手动调整 · 按物理数量与已知刊例区间重算；不保证组合最优';
    $('#exportButton').disabled = !result.feasible || !brandMatches();
    $('#exportButton').title = result.errors.slice(0, 4).join('；') || (!result.quantity ? '尚无可成案组合' : '');
    renderAnchors(); renderMatrix(result); renderAllocation(result); renderInventory(); renderEvidence(); renderProgress();
    strategies = brandMatches() ? P.strategyComparison(E, data, brief, excluded, planning) : null;
    const comparison = strategyComparisonHTML(strategies, brief, planning, 'workbench', selectedStrategy());
    $('#workspaceComparison').innerHTML = comparison;
    $('#planningComparison').innerHTML = comparison;
    if ($('#planningReport')) $('#planningReport').innerHTML = planningReport(result);
    if (baseline) {
      const low = result.low !== null && baseline.low !== null ? result.low - baseline.low : null, high = result.high !== null && baseline.high !== null ? result.high - baseline.high : null;
      const signed = value => value === null ? '无法确认' : (value >= 0 ? '+' : '−') + money(Math.abs(value));
      $('#changeSummary').textContent = '相对基线：费用下界 ' + signed(low) + '，上界 ' + signed(high) + '；物理数量 ' + (result.quantity - baseline.quantity >= 0 ? '+' : '') + (result.quantity - baseline.quantity) + '；所选锚点覆盖 ' + result.coveredAnchorIds.length + '/' + brief.anchorIds.length + '。' + (baseline.start !== brief.start || baseline.end !== brief.end || baseline.months !== brief.months ? '注意：档期或计费月数与基线不同。' : '');
    } else $('#changeSummary').textContent = '保存一份对比基线后，增减实际物理媒体，查看费用区间和门店覆盖变化。';
    if ($('#proposal')?.classList.contains('active')) renderProposal();
  }

  function selectedStrategy() {
    const key = executionMode ? 'schedule' : 'budget';
    const automatic = strategies?.[key]?.selection;
    if (!automatic || Object.keys(automatic).length !== Object.keys(selection).length) return null;
    return Object.keys(automatic).every(id => automatic[id] === E.quantity(selection, id)) ? key : null;
  }
  // Used unchanged by the standalone customer document, with the same planning engine.
  function strategyComparisonHTML(pair, context, cfg, view, selected) {
    const explainer = view === 'snapshot' ? '导出时的两种自动建议，供对照正文采用的组合。' :
      view === 'client' ? '随试算预算重新计算。采用建议会填入下方调整表。' :
      '同一份库存与门店覆盖依据。采用建议会替换当前手选数量。';
    const header = '<header><h3>双方案对比</h3><p>' + explainer + '</p></header>';
    if (!pair) return '<section class="panel strategy-comparison">' + header + '<p>请先导入与客户匹配的门店和覆盖资料。</p></section>';
    function card(key) {
      const option = pair[key], isSchedule = key === 'schedule';
      const title = isSchedule ? '档期优先' : '预算优先';
      const label = isSchedule ? '扣除执行预留，按最低共同发布天数配置公交' + (context.mediaTypes.includes('metro') ? '；地铁工期待核' : '') : '先覆盖门店，再按预算与库存增加媒介数量';
      let content = '<p class="strategy-empty">' + esc(option.reason || '') + '</p>';
      if (option.result) {
        const r = option.result, x = option.window;
        const days = x.metroPending ? '待核' : x.publishDays + ' 天';
        const status = x.metroPending ? '地铁施工待核' : x.feasible ? '达到目标' : '未达目标';
        const cost = wan(r.low) + '–' + wan(r.high) + ' 万元';
        const uptake = '<span data-metric="buses">' + r.busUnits + ' 辆</span>' + (r.metroUnits ? ' / ' + r.metroUnits + ' 点' : '');
        let timeline = '';
        if (!x.metroPending) {
          const before = Math.min(x.days, x.upNights + cfg.weatherBuffer);
          const band = (n, cls) => n ? '<i class="' + cls + '" style="width:' + (n / x.days * 100) + '%"></i>' : '';
          timeline = '<div class="strategy-timeline" aria-hidden="true">' + band(before, 'setup') + band(x.publishDays, 'on-air') + band(x.days - before - x.publishDays, 'setup') + '</div>';
        }
        const dates = x.metroPending ? '含地铁点位，整组共同窗口待核。' : x.publishDays ? '共同在刊 ' + x.releaseStart.slice(5) + ' 至 ' + x.releaseEnd.slice(5) : '当前组合没有共同在刊日';
        const work = x.metroPending ? '' : '<small>上刊 ' + x.upNights + ' 夜 · 下刊 ' + x.downNights + ' 夜 · 缓冲共 ' + x.bufferNights + ' 夜</small>';
        content = '<div class="strategy-figures"><div><span>公交配置' + (r.metroUnits ? ' / 地铁' : '') + '</span><b>' + uptake + '</b></div><div><span>共同发布</span><b data-metric="days">' + days + '</b></div></div>' +
          timeline + '<div class="strategy-window"><span>' + dates + '</span><em class="' + (x.feasible ? 'pass' : 'watch') + '">' + status + '</em></div>' + work +
          '<dl class="strategy-facts"><div><dt>刊例与制作</dt><dd data-metric="cost">' + cost + '</dd></div><div><dt>锚点匹配</dt><dd data-metric="coverage">' + r.coveredAnchorIds.length + ' / ' + context.anchorIds.length + '</dd></div></dl>';
        if (view !== 'snapshot') content += '<button type="button" class="btn small" data-adopt-strategy="' + key + '">采用' + title + '</button>';
      }
      const marker = selected === key ? '<span class="strategy-selected">当前组合</span>' : '';
      return '<article class="strategy-card ' + key + '" data-strategy-card="' + key + '"><h4>' + title + marker + '</h4><p>' + label + '</p>' + content + '</article>';
    }
    const a = pair.budget, b = pair.schedule;
    let conclusion = '';
    if (a.result && b.result && !a.window.metroPending && !b.window.metroPending) {
      const fewer = a.result.busUnits - b.result.busUnits, gained = b.window.publishDays - a.window.publishDays;
      if (fewer > 0 && gained > 0) conclusion = '采用档期优先，公交减少 ' + fewer + ' 辆，全部车辆同时在刊的时间增加 ' + gained + ' 天。';
      else if (fewer === 0 && gained === 0) conclusion = '按当前设置，两种策略给出相同的公交数量与共同发布天数。';
    }
    return '<section class="panel strategy-comparison">' + header + '<div class="strategy-grid">' + card('budget') + card('schedule') + '</div>' +
      (conclusion ? '<p class="strategy-decision">' + conclusion + '</p>' : '') + '<p class="strategy-assumptions">按 ' + wan(context.budget) + ' 万元、' + context.months + ' 个计费月测算。上刊 ' + cfg.upCapacity + ' 辆/夜，下刊 ' + cfg.downCapacity + ' 辆/夜，两端各留 ' + cfg.weatherBuffer + ' 夜；目标至少 ' + cfg.minPublishDays + ' 天，执行预留 ' + wan(cfg.executionReserve) + ' 万元。施工条件待供应商确认。</p></section>';
  }
  function hypothesisRows(result) {
    const x = P.execution(brief, result, planning);
    return [
      ['① 客户与品牌', planning.clientAlias + '；' + brief.industry + '。模拟客户需求；公开研究样本为' + data.brand.brand + '，未使用真实客户委托、成交价或经营规模数据。'],
      ['② 生意目标', planning.businessGoal],
      ['③ campaign 主目标', planning.primaryGoal + '。正文用门店—媒介映射解释选择；传播与生意效果另行验证，不能由库存或地理覆盖直接推出。'],
      ['④ 目标人群与区域', brief.audience + '；所选' + brief.anchorIds.length + '个地标：' + data.anchors.filter(a => brief.anchorIds.includes(a.id)).map(a => a.cluster || a.district).join('、') + '。'],
      ['⑤ 时间与预算', '库存查询/租用候选区间' + brief.start + '至' + brief.end + '；总预算' + wan(brief.budget) + '万元，' + brief.months + '个计费月。施工假设下共同发布' + (x.publishDays > 0 ? x.releaseStart + '至' + x.releaseEnd + '，' + x.publishDays + '天' : '暂无可行窗口') + '；以合同和执行确认结果为准。'],
      ['⑥ 媒体范围', brief.mediaTypes.map(mediaName).join(' / ') + '；当前组合' + result.busUnits + '辆公交、' + result.metroUnits + '个地铁点位。未核清具体出口、面积、价格或可售的地铁只列候选。'],
      ['⑦ 成功衡量与履约证明', planning.successMeasure + '；验收计划：每辆上刊、下刊各一组可定位的监测证据，结案报告1份，按实际合同确认时限；尚未发生2027投放，不存在已实现效果。']
    ];
  }
  function hypothesisHTML(result) {
    try { return '<section class="proposal-section campaign-hypothesis"><h3>Campaign 假设书</h3><p>七要素由需求输入与当前方案共同生成，预算、日期、媒介及数量自动同步。所有经营需求均为可检验的团队假设。</p><table><tbody>' + hypothesisRows(result).map(([k,v]) => '<tr><th scope="row">' + esc(k) + '</th><td>' + esc(v) + '</td></tr>').join('') + '</tbody></table></section>'; } catch(error) { return '<section class="proposal-section"><h3>Campaign 假设书</h3><p>请填写有效档期后生成七要素假设书。</p></section>'; }
  }
  function planningReport(result) {
    if (!brandMatches()) return '<section class="panel"><h2>对应客户证据待接入</h2><p>请先导入匹配品牌的门店与覆盖资料；不沿用原品牌的假设书或执行结论。</p></section>';
    try { const x = P.execution(brief, result, planning), c = P.costs(result, brief.months, planning);
    const scenarios = [100,200,500].map(w => { const b = {...brief,budget:w*10000}, p = P.strategyPlan(E,data,b,excluded,planning,executionMode), r = E.summarize(data,p.selection,b); return {w,r,x:P.execution(b,r,planning)}; });
    const largest = [...result.rows].sort((a,b) => (b.high || 0) - (a.high || 0))[0];
    const scenarioTable = '<div class="table-wrap"><table><thead><tr><th>同一证据链预算</th><th>车辆 / 资源</th><th>已知费用</th><th>地标映射</th><th>共同发布窗口*</th></tr></thead><tbody>' + scenarios.map(v => '<tr><td>' + v.w + '万元</td><td>' + v.r.busUnits + '辆 / ' + v.r.resourceCount + '条</td><td>' + interval(v.r.low,v.r.high) + '</td><td>' + v.r.coveredAnchorIds.length + '/' + brief.anchorIds.length + '</td><td>' + v.x.publishDays + '天 · ' + (v.x.feasible ? '达到设定最低天数' : '需调整执行条件') + '</td></tr>').join('') + '</tbody></table></div>';
    return hypothesisHTML(result) +
      '<section class="proposal-section"><h3>媒体取舍与预算增量</h3><p>需求翻译：主目标“' + esc(planning.primaryGoal) + '”首先要求目标商圈有可核验媒介映射；再考虑增加同一区域的物理投放量。品牌认知及人群匹配仍需客户调研验证，不能仅凭便宜或线路数量判断效果。</p>' + scenarioTable + '<p>*三档共用当前门店、档期、价格、排除项及所选约束模式，执行窗口按下方团队产能假设计算，并非三份固定方案。默认六地标三档均可映射，增加预算主要增加已有地标周边的投放量，不证明新增独立触达；是否值得加量需要频次、认知调查及执行能力共同验证。</p><p>' + (largest && result.high > 0 ? '当前上界费用最高的资源为' + esc(largest.name) + '，占已知费用上界' + (largest.high / result.high * 100).toFixed(1) + '%；重点复核其可售、车况及替换来源，防止预算集中于单项交付风险。' : '尚无有效组合，无法计算资源集中度。') + '</p></section>' +
      '<section class="proposal-section"><h3>费用拆分与执行预留</h3>' + (c.complete ? '<table><thead><tr><th>预算项</th><th>测算口径</th><th>金额</th></tr></thead><tbody><tr><td>媒介月费</td><td>逐辆/点 × 月刊例 × 计费月数</td><td>' + interval(c.mediaLow,c.mediaHigh) + '</td></tr><tr><td>本轮制作费</td><td>逐辆/点 × 一轮制作；不重复按月计</td><td>' + interval(c.productionLow,c.productionHigh) + '</td></tr><tr><td>执行预留</td><td>团队预算额度，非报价</td><td>' + (c.reserve ? money(c.reserve) : '未设置，不能当作0元费用') + '</td></tr><tr><td>税费 / 折扣 / 安装卸刊等费用</td><td>资料未统一确认；制作费不等于全包执行费</td><td>待业务报价</td></tr></tbody></table><p class="' + (c.envelopeHigh > brief.budget ? 'error-text' : '') + '">已知上界加内部预留：' + money(c.envelopeHigh) + '；' + (c.envelopeHigh > brief.budget ? '超过总预算' + money(c.envelopeHigh - brief.budget) + '，请重新组合。' : '总预算内剩余' + money(brief.budget - c.envelopeHigh) + '。') + '未确认费用仍影响完整预算，不表示含税全包价已确认。</p>' : '<p>报价有缺项，不能按0补齐。</p>') + '</section>' +
      '<section class="proposal-section"><h3>夜间分批施工与发布窗口</h3><p>执行依据：02-上下刊流程卡点；设计→定稿→审批→制作→夜间安装，雨天停工、单晚上限、照片可能隔天回传。下列数值是团队假设，未获供应商产能确认。</p><div class="execution-metrics"><div><b>' + x.upNights + '夜</b><span>上刊：' + result.busUnits + '辆 ÷ ' + planning.upCapacity + '辆/夜</span></div><div><b>' + x.downNights + '夜</b><span>下刊：' + result.busUnits + '辆 ÷ ' + planning.downCapacity + '辆/夜</span></div><div><b>' + x.bufferNights + '夜</b><span>两端各留' + planning.weatherBuffer + '夜天气缓冲</span></div><div><b>' + x.publishDays + '天</b><span>全量共同发布；目标至少' + planning.minPublishDays + '天</span></div></div><p class="' + (!x.feasible ? 'error-text' : '') + '">' + (x.metroPending ? '含地铁，地铁施工产能与许可未核，不能套用公交模型。' : x.feasible ? '在上述假设下满足设定窗口，仍待施工许可与合同确认。' : '当前组合不满足设定的共同发布窗口。可减少车辆、增加经供应商确认的产能，或重查更长档期；不默认获得档期外施工权。') + '</p><table><thead><tr><th>阶段</th><th>计划日期</th><th>责任与验收</th></tr></thead><tbody><tr><td>设计、定稿、审批与制作准备</td><td>' + x.prepStart + '起，素材前置' + planning.prepDays + '天</td><td>销售协调客户签字；创意/制作复核版本，不提前占用媒体</td></tr><tr><td>夜间分批上刊</td><td>' + esc(x.installStart) + '至' + esc(x.installEnd || '待组合') + '</td><td>执行按每夜上限派单；以车牌/资源ID、日期、画面版本核对</td></tr><tr><td>共同发布</td><td>' + (x.publishDays ? x.releaseStart + '至' + x.releaseEnd : '无可用窗口') + '</td><td>该窗口区别于整段库存租期；计费仍按输入月数，不按有效天数自动打折</td></tr><tr><td>天气缓冲与分批下刊</td><td>' + esc(x.removalStart || '待组合') + '至' + brief.end + '；另预留' + planning.weatherBuffer + '夜</td><td>同档期内保守安排；跨日窗口、替换与实际工期须业务复核</td></tr></tbody></table></section>' +
      '<section class="proposal-section"><h3>衡量、监测与风险处置</h3><table><thead><tr><th>衡量层次</th><th>目标与取证方法</th><th>当前状态</th></tr></thead><tbody><tr><td>传播主目标：' + esc(planning.primaryGoal) + '</td><td>' + esc(planning.successMeasure) + '</td><td>基线、样本及数值目标待确认；未发生投放，不填虚构达成率</td></tr><tr><td>规划映射</td><td>' + result.coveredAnchorIds.length + '/' + brief.anchorIds.length + '个地标；逐条平台覆盖证据</td><td>仅为地理规划指标，不能当覆盖人次或去重人数</td></tr><tr><td>履约验收</td><td>' + result.busUnits + '辆公交，目标每辆上/下刊各一组证据，共' + result.busUnits*2 + '组；结案报告1份，均为待确认验收计划</td><td>2027实际车牌、监测照片、故障记录及签收尚未取得</td></tr></tbody></table><p>照片台账字段：资源ID、车牌/出口、地点、上下刊时间、画面版本、带日期的全景/近景、异常、修复/替换、客户确认。交付时限由合同约定；样本存在当日或次日与5个工作日等不同条件，不能合并成统一承诺。</p><p>雨天或审批延期：暂停派单并消耗缓冲，超过缓冲则重新确认发布日与库存。车辆维修或调动：从同档期有完整报价、能补齐原锚点的候选替换，重算费用、更新制作/施工/监测单后确认，不静默替换。本站“排除”与重新组合可现场演示替换过程。</p><p>“误一补二”按实际签署合同、归责、通知与举证条件处理；资料中也有“损一补一”样本，2026合同不自动适用于2027。本方案不自动承诺赔付额度。</p></section>';
    } catch(error) { return '<section class="panel"><p>请填写有效的完整档期后查看执行测算。</p></section>'; }
  }
  async function exportHypothesis() {
    if (!brandMatches()) { toast('先导入对应客户资料'); return; }
    const doc = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Campaign假设书</title><style>body{font:15px/1.65 "Microsoft YaHei",sans-serif;color:#153a34;max-width:900px;margin:30px auto;padding:20px}h1{font-size:26px}h3{font-size:19px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d9e3dd;padding:10px;text-align:left;vertical-align:top}th{width:155px;background:#eef5f0}button{padding:10px 20px}@page{size:A4;margin:14mm}@media print{body{font-size:10pt;margin:0;padding:0}button{display:none}td,th{padding:7px}h1{font-size:20pt}}</style><h1>' + esc(planning.clientAlias) + ' Campaign假设书</h1>' + hypothesisHTML(summary()) + '<p>参赛团队策划设定 · 非客户委托 · 数据与执行条件须上线前复核</p><button onclick="window.print()">打印 / 保存PDF</button></html>';
    download('Campaign假设书.html',doc,'text/html;charset=utf-8');
    return doc;
  }

  function proposalHTML() {
    if (!brandMatches()) return '<article class="proposal-doc"><header class="proposal-hero"><div class="eyebrow">CLIENT DATA REQUIRED</div><h2>' + esc(brief.brand) + '<br>门店与覆盖资料待接入</h2></header><div class="proposal-note">原品牌门店圈选已经清空。请导入所选行业与品牌的公开门店来源、比赛平台覆盖分析，以及同档期可售库存；不沿用' + esc(data.brand.brand) + '的数据证明新客户的覆盖。</div><p>现有媒介库存仍可留作候选参考，未经新客户门店覆盖匹配不得自动组合或导出正式方案。</p></article>';
    const result = summary(), selectedAnchors = data.anchors.filter(anchor => brief.anchorIds.includes(anchor.id));
    const brandIntro = data.brand.brandUnderstanding || '以有公开来源的上海线下门店作为需求锚点，将' + brief.audience + '与门店周边媒介组织在同一条策略链路中。门店地理信息来自品牌页面，线路覆盖关系来自比赛平台。';
    const brandSources = data.brand.brandSources.map(source => '<li>' + link(source.url, source.title || '品牌公开来源') + (source.use ? '<small>' + esc(source.use) + '</small>' : '') + '</li>').join('');
    return '<article class="proposal-doc"><header class="proposal-hero"><div class="eyebrow">YUNCE · 2027 MEDIA PROPOSAL</div><span class="chip ' + (result.feasible ? 'green' : 'amber') + '">' + (result.feasible ? '已知口径上界预算内 · 待商务确认' : '资料与策略框架 · 尚无完整可执行报价') + '</span><h2>' + esc(planning.clientAlias) + '<br>' + esc(brief.campaign || '上海户外媒介投放方案') + '</h2><div class="proposal-meta"><span>' + esc(brief.industry) + '</span><span>' + esc(brief.start) + ' — ' + esc(brief.end) + '</span><span>' + brief.months + ' 个计费月（业务确认输入）</span><span>预算 ' + wan(brief.budget) + ' 万元</span></div></header><div class="proposal-note">策划性质：' + esc(data.brand.campaignStatus || '团队策划假设，非品牌已公布活动') + '。' + esc(COMMERCIAL) + '</div><div class="metrics"><div><span>刊例费用区间</span><strong>' + (result.low === null || result.high === null ? '待报价' : wan(result.low) + '–' + wan(result.high)) + '<em>' + (result.high === null ? '' : '万元') + '</em></strong><small>不是含税全包精确报价</small></div><div><span>所选门店锚点匹配</span><strong>' + result.coveredAnchorIds.length + '<em>/ ' + brief.anchorIds.length + ' 个</em></strong><small>不是独立触达人数</small></div><div><span>物理媒介配置</span><strong>' + result.busUnits + '<em>辆公交</em></strong><small>' + result.metroUnits + ' 个地铁点位 · ' + result.resourceCount + ' 条资源</small></div></div>' +
      strategyComparisonHTML(strategies, brief, planning, 'snapshot', selectedStrategy()) + planningReport(result) + '<section class="proposal-section"><h3>公开研究样本与策略依据</h3><p>' + esc(brandIntro) + '</p><p>本次策略人群：' + esc(brief.audience) + '。campaign 文案及传播方向由参赛团队策划，不代表客户委托或品牌已公布计划。</p><ul class="proposal-sources">' + brandSources + '</ul></section>' +
      '<section class="proposal-section"><h3>从门店到媒介的选择逻辑</h3><p>先选择有品牌公开来源的门店/地标，再使用比赛可视化平台的覆盖分析映射线路与点位；逐条核对相同完整档期的红豆可售数量，匹配媒体形式及刊例等级。自动组合先争取新增门店锚点覆盖，覆盖齐后按较低费用上界加量，采用可解释的贪心启发式，不保证全局最优。</p><div class="table-wrap"><table><thead><tr><th>门店 / 商圈</th><th>官网地址与来源</th><th>覆盖匹配情况</th></tr></thead><tbody>' + selectedAnchors.map(anchor => '<tr><td>' + esc(anchor.name) + '<small>' + esc(anchor.cluster || anchor.district) + '</small></td><td>' + esc(anchor.address) + '<small>' + link(anchor.sourceUrl, '品牌门店来源') + esc(anchor.verification) + '</small></td><td>' + (result.coveredAnchorIds.includes(anchor.id) ? '所选媒介有平台覆盖映射' : '当前组合未覆盖') + '<small>' + esc(anchor.coordinateSource || '坐标来源未提供') + '</small></td></tr>').join('') + '</tbody></table></div></section>' +
      '<section class="proposal-section"><h3>媒介组合、排期与区间报价</h3><p>' + esc(aiNarrative?.strategy || explanation(result)) + '</p><p class="quiet">' + (aiNarrative ? '策略文字由 Flash 生成，需人工审阅；库存、数量与报价仍由本地引擎计算。' : '本段为确定性规则摘要，未冒充模型生成。') + '</p><div class="table-wrap"><table><thead><tr><th>线路 / 点位</th><th>媒体 / 等级</th><th>物理数量 / 月数</th><th>月刊例与制作</th><th>本项费用区间</th></tr></thead><tbody>' + (result.rows.map(resource => '<tr><td>' + esc(resource.name) + '<small>' + esc(resource.id) + '</small></td><td>' + mediaName(resource.mediaType) + '<small>' + esc(resource.grade || '待核') + '</small></td><td>' + resource.quantity + unitName(resource.mediaType) + ' × ' + brief.months + '月<small>' + esc(brief.start + ' 至 ' + brief.end) + '</small></td><td>' + interval(resource.price.monthlyLow, resource.price.monthlyHigh) + '/' + unitName(resource.mediaType) + '/月<small>制作：' + interval(resource.price.productionLow, resource.price.productionHigh) + '/' + unitName(resource.mediaType) + '·次</small></td><td>' + interval(resource.low, resource.high) + '</td></tr>').join('') || '<tr><td colspan="5">尚无可成案组合。当前未确认可售的资源不会出现在正式报价清单中。</td></tr>') + '</tbody><tfoot><tr><td colspan="4"><b>已知口径费用区间</b></td><td><b>' + interval(result.low, result.high) + '</b></td></tr></tfoot></table></div><p>计算：物理数量 ×（月刊例 × 计费月数 + 每物理媒体本次制作费）。数量为0时费用为0。换稿、换车、换点或重新施工的额外制作须另行核实；计费月与非整月折算不自行按28/30天推算。</p></section>' +
      '<section class="proposal-section"><h3>库存、价格与覆盖证据</h3><p>数据版本：' + esc(data.version) + '。库存完整查询区间：' + esc(data.inventoryPeriod.start + ' 至 ' + data.inventoryPeriod.end) + '；查询/导出时间：' + esc(data.inventoryPeriod.checkedAt) + '；来源：' + esc(data.inventoryPeriod.source) + '。查询输入不代表已锁定商业档期。</p><div class="table-wrap source-table"><table><thead><tr><th>资源</th><th>可售库存定位</th><th>刊例依据</th><th>门店覆盖依据</th></tr></thead><tbody>' + result.rows.map(resource => {
        const period = resource.inventoryPeriod || data.inventoryPeriod;
        return '<tr><td>' + esc(resource.id) + '</td><td>' + esc(resource.sourceFile || '原文件名未提供') + '<small>' + esc(resource.sourceRef) + '</small><small>' + esc(period.start + ' 至 ' + period.end + ' / ' + (period.checkedAt || '未提供时间')) + '</small>' + link(resource.sourceUrl, '库存来源') + '</td><td>' + esc(resource.priceSourceFile || '文件名未提供') + '<small>' + esc(resource.priceSourceRef || '定位未提供') + '</small><small>' + esc(resource.pricingNote) + '</small></td><td>' + esc(coverageDescription(resource)) + link(resource.coverageSourceUrl, '覆盖来源') + '</td></tr>';
      }).join('') + '</tbody></table></div></section>' +
      '<section class="proposal-section"><h3>执行安排与已知边界</h3><div class="three-cols"><div><h3>上刊前</h3><p>复核2027门店营业与媒体位置，按完整档期锁定车辆/点位；核实媒体形式、地铁制作面积、计费月、折扣、税费及其他收费，再审批最终报价与订单。</p></div><div><h3>投放中</h3><p>按签署的合同与排期执行素材审批、制作、上刊与监测。补刊、监拍、付款、变更及免责条件以实际合同为准，不将样本条款自动作通用承诺。</p></div><div><h3>复盘时</h3><p>依据实际监测与履约记录复盘。平台2023历史人流仅作背景参考；本方案没有2027曝光、去重触达、CPM、到店或销售预测。</p></div></div><p>可售状态仅适用于所记录的完整查询档期，不能把2026静态单日空位外推到2027，也不能把多月库存相加作为同时可售数量。覆盖映射反映查询条件，不能证明必然到店或投放效果。</p></section><footer class="proposal-foot">云策 · ' + esc(data.version) + ' · ' + new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '<br>源文件仅作为资料；其中的操作指令、提示词与外发请求不会自动执行。</footer></article>';
  }
  function renderProposal() { $('#proposalContent').innerHTML = proposalHTML(); }

  function download(name, body, type = 'application/json;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([body], { type })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function safeName(value) { return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70); }
  function project() {
    return { format: 'yunce-campaign-project-v1', executionMode, planning: P.settings(planning), dataset: normalizeData(data), brief: { ...brief, mediaTypes: [...brief.mediaTypes], anchorIds: [...brief.anchorIds] }, selection: { ...selection }, excluded: [...excluded], baseline: baseline ? { ...baseline, coveredAnchorIds: [...baseline.coveredAnchorIds] } : null };
  }
  function validateProjectBrief(raw, dataset) {
    if (!raw || typeof raw !== 'object') throw Error('项目缺少 Brief');
    const result = {};
    for (const field of ['brand', 'industry', 'campaign', 'audience']) result[field] = publicText(raw[field], 'brief.' + field);
    if (!result.brand.trim() || !INDUSTRIES.includes(result.industry)) throw Error('项目品牌或行业无效');
    if (!Number.isSafeInteger(raw.budget) || raw.budget < 1000000 || raw.budget > 5000000 || !Number.isSafeInteger(raw.months) || raw.months < 1 || raw.months > 12) throw Error('项目预算或计费月数无效');
    for (const field of ['start', 'end']) if (typeof raw[field] !== 'string' || !/^2027-\d{2}-\d{2}$/.test(raw[field]) || !Number.isFinite(Date.parse(raw[field] + 'T00:00:00Z')) || new Date(raw[field] + 'T00:00:00Z').toISOString().slice(0, 10) !== raw[field]) throw Error('项目必须填写有效2027档期');
    if (raw.end < raw.start) throw Error('项目结束日早于开始日');
    if (!Array.isArray(raw.mediaTypes) || !raw.mediaTypes.length || raw.mediaTypes.some(type => !['bus', 'metro'].includes(type)) || new Set(raw.mediaTypes).size !== raw.mediaTypes.length) throw Error('项目媒介类型无效');
    const ids = new Set(dataset.anchors.map(anchor => anchor.id));
    if (!Array.isArray(raw.anchorIds) || raw.anchorIds.some(id => !ids.has(id)) || new Set(raw.anchorIds).size !== raw.anchorIds.length) throw Error('项目含未知门店锚点');
    return { ...result, budget: raw.budget, months: raw.months, start: raw.start, end: raw.end, mediaTypes: [...raw.mediaTypes], anchorIds: [...raw.anchorIds] };
  }
  function normalizeBaseline(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const result = {};
    for (const field of ['low', 'high']) { if (raw[field] !== null && (!Number.isSafeInteger(raw[field]) || raw[field] < 0)) return null; result[field] = raw[field]; }
    for (const field of ['quantity', 'resourceCount', 'months']) { if (!Number.isSafeInteger(raw[field]) || raw[field] < 0) return null; result[field] = raw[field]; }
    if (!Array.isArray(raw.coveredAnchorIds) || raw.coveredAnchorIds.some(id => typeof id !== 'string')) return null;
    result.coveredAnchorIds = raw.coveredAnchorIds.slice(0, 500);
    result.start = publicText(raw.start, 'baseline.start', 10); result.end = publicText(raw.end, 'baseline.end', 10);
    return result;
  }
  async function openProject(file) {
    if (!file) return;
    try {
      if (file.size > 20000000) throw Error('项目文件不能超过20 MB');
      const raw = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      if (raw.format !== 'yunce-campaign-project-v1') throw Error('项目格式不匹配');
      const next = normalizeData(raw.dataset), nextBrief = validateProjectBrief(raw.brief, next);
      if (!raw.selection || typeof raw.selection !== 'object' || Array.isArray(raw.selection) || !Array.isArray(raw.excluded) || raw.excluded.some(id => typeof id !== 'string')) throw Error('项目资源选择格式无效');
      const ids = new Set(next.resources.map(resource => resource.id)), nextSelection = Object.create(null);
      for (const id of Object.keys(raw.selection)) { if (!ids.has(id) || !Number.isSafeInteger(raw.selection[id]) || raw.selection[id] < 0 || raw.selection[id] > 5000) throw Error('项目包含未知资源或非法物理数量'); if (raw.selection[id]) nextSelection[id] = raw.selection[id]; }
      const nextBaseline = normalizeBaseline(raw.baseline), nextPlanning = P.settings(raw.planning || planningFor(next));
      if (nextBrief.brand.trim() !== next.brand.brand.trim() || nextBrief.industry !== next.brand.industry) { nextBrief.anchorIds = []; for (const id of Object.keys(nextSelection)) delete nextSelection[id]; }
      data = next; brief = nextBrief; planning = nextPlanning; executionMode = raw.executionMode === true; selection = nextSelection; excluded = raw.excluded.filter(id => ids.has(id)); baseline = nextBaseline; lastPlan = null; invalidate(); syncFields(); render();
      toast('项目已恢复；密钥与AI文字未从文件载入，未通过约束的草稿仍不可导出');
    } catch (error) { toast('未打开项目，原数据保留：' + error.message); }
  }
  function applyDataset(raw) {
    const next = normalizeData(raw);
    data = next; planning = planningFor(next); executionMode = false; brief = defaultBrief(next); selection = Object.create(null); excluded = []; baseline = null; lastPlan = null; invalidate(); syncFields(); runPlan(false);
    return next;
  }
  async function importData(file) {
    if (!file) return;
    try {
      if (file.size > 20000000) throw Error('资源文件不能超过20 MB');
      const raw = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
      applyDataset(raw);
      $('#importResult').textContent = '已导入 ' + data.resources.length + ' 条资源；只保留公开白名单字段。结构校验不代表原始数据已获真实性验证。';
      toast('数据已接入；请核对品牌、档期与来源时间');
    } catch (error) { $('#importResult').textContent = '未导入，原数据保留：' + error.message; toast('导入失败，当前项目未更改'); }
  }
  function template() {
    return { version: '填写真实查询导出版本', inventoryPeriod: { start: '2027-03-01', end: '2027-03-31', checkedAt: new Date().toISOString(), source: '填写红豆比赛专户完整档期查询来源，勿填账户密码' }, brand: { brand: brief.brand, industry: brief.industry, campaignTitle: brief.campaign, campaignStatus: '团队策划假设，非品牌已公布活动', audience: brief.audience, brandSources: data.brand.brandSources }, anchors: data.anchors, resources: [{ id: 'REPLACE-WITH-SOURCE-ID', name: '请替换为官方资源名称', mediaType: 'bus', grade: '待匹配', available: null, coverageAnchorIds: [], price: { monthlyLow: null, monthlyHigh: null, productionLow: null, productionHigh: null }, sourceRef: '填写真实系统原始行定位；未知不得填0', priceSourceFile: '07-媒体刊例价.xlsx', priceSourceRef: '待媒体形式与刊例适用行核实', coverageEvidence: [] }] };
  }

  async function generateAI() {
    const key = $('#apiKey').value.trim(), result = summary();
    if (!key) { $('#settingsDialog').showModal(); return; }
    if (location.protocol === 'file:') { toast('请通过本地启动器运行，再连接比赛Flash接口'); return; }
    if (!result.feasible || !brandMatches()) { toast('先取得同档期可售、覆盖与完整报价，生成有效组合后再调用模型'); return; }
    const requestRevision = revision, button = $('#aiButton'); button.disabled = true; button.textContent = 'Flash 正在解读当前组合…';
    try {
      const response = await fetch('/api/strategy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(65000), body: JSON.stringify({ key, model: $('#modelName').value.trim(), brief: { ...brief, campaignStatus: data.brand.campaignStatus, clientAlias: planning.clientAlias, businessGoal: planning.businessGoal, primaryGoal: planning.primaryGoal, successMeasure: planning.successMeasure, execution: P.execution(brief, result, planning) }, summary: { low: result.low, high: result.high, quantity: result.quantity, busUnits: result.busUnits, metroUnits: result.metroUnits, coveredAnchorIds: result.coveredAnchorIds, remainingHigh: result.remainingHigh, commercialWarning: COMMERCIAL, noExposurePrediction: true }, resources: result.rows.map(resource => ({ id: resource.id, name: resource.name, mediaType: resource.mediaType, grade: resource.grade, quantity: resource.quantity, months: brief.months, low: resource.low, high: resource.high, coverageAnchorIds: resource.coverageAnchorIds, inventoryPeriod: resource.inventoryPeriod || data.inventoryPeriod, sourceRef: resource.sourceRef, priceSourceRef: resource.priceSourceRef, coverageSourceRef: resource.coverageSourceRef, evidence: resource.evidence })) }) });
      const body = await response.json();
      if (!response.ok) throw Error(body.error || 'Flash 接口未成功返回');
      if (requestRevision !== revision) { toast('输入或组合已经变化，未应用过期的AI解读'); return; }
      if (typeof body.strategy !== 'string' || !body.strategy.trim()) throw Error('模型没有返回可用的策略文字');
      aiNarrative = { strategy: body.strategy.slice(0, 6000) }; aiEverSucceeded = true; aiReceipt = body.receipt || { completedAt: new Date().toISOString() }; render(); toast('已取得模型解读，请人工审阅；计算金额未被AI修改');
    } catch (error) { toast(error.name === 'TimeoutError' ? 'Flash请求超时，规则摘要与当前组合已保留' : error.message); }
    finally { button.disabled = false; button.textContent = '使用 Flash 生成策略解读'; }
  }
  async function syncLive() {
    if (location.protocol === 'file:') { toast('实时同步需要通过本地启动器运行，并在比赛浏览器登录'); return; }
    if (!brandMatches() || !brief.anchorIds.length) { toast('请先导入匹配品牌的门店并选择覆盖锚点'); return; }
    const button = $('#liveSyncButton'), status = $('#syncStatus'), requestRevision = revision;
    if (button) { button.disabled = true; button.textContent = '正在核对比赛系统…'; }
    if (status) status.textContent = '需要已登录本机比赛浏览器；只查询当前完整档期，不修改业务系统。';
    try {
      const response = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000), body: JSON.stringify({ start: brief.start, end: brief.end, months: brief.months, anchorIds: [...brief.anchorIds], mediaTypes: [...brief.mediaTypes], brand: brief.brand }) });
      const body = await response.json();
      if (!response.ok) throw Error(body.error || '比赛系统同步未成功');
      if (requestRevision !== revision) throw Error('同步期间输入已变更，未应用过期查询；请用当前档期重试');
      const raw = body.dataset || (body.resources ? { ...data, ...body, brand: data.brand } : null);
      if (!raw) throw Error('同步未返回可校验的数据集，请核对本地比赛浏览器登录状态');
      const next = normalizeData({ ...raw, brand: raw.brand || data.brand });
      if (next.inventoryPeriod.start !== brief.start || next.inventoryPeriod.end !== brief.end) throw Error('同步返回的库存档期与请求不一致，已拒绝替换');
      data = next; selection = Object.create(null); lastPlan = null; invalidate(); runPlan(false);
      if (status) status.textContent = '已接入同档期查询结果；请查看各资源的查询时间、可售数量与报价来源。';
      toast('同步结果已通过结构校验，已重新生成当前组合');
    } catch (error) { const message = error.name === 'TimeoutError' ? '同步超时，原数据保留；请检查已登录比赛浏览器与系统连接' : error.message; if (status) status.textContent = message; toast(message); }
    finally { if (button) { button.disabled = false; button.textContent = '同步当前档期可售库存'; } }
  }

  async function loadStyles() {
    if (typeof globalThis.BUNDLED_CSS === 'string') return globalThis.BUNDLED_CSS;
    try {
      const results = await Promise.all(['style.css', 'campaign.css'].map(async file => { const response = await fetch(file); if (!response.ok) throw Error('样式读取失败'); return response.text(); }));
      return results.join('\n');
    } catch {
      return ':root{font-family:"Microsoft YaHei",sans-serif;color:#142e31;line-height:1.8}.proposal-doc{max-width:1100px;margin:auto;padding:24px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #ddd;text-align:left}small{display:block;color:#62736c}.metrics,.three-cols{display:flex;gap:30px;flex-wrap:wrap}.proposal-note{padding:14px;background:#fff3dc}.proposal-section{margin-top:30px}.proposal-foot{margin-top:28px;border-top:1px solid #ddd;padding-top:15px}.table-wrap{overflow:auto}';
    }
  }
  function exportCandidates() {
    return data.resources.filter(resource => brandMatches() && periodMatches(resource) && brief.mediaTypes.includes(resource.mediaType) && matchingAnchors(resource).length);
  }
  async function buildExportHTML() {
    const result = summary();
    if (!result.feasible || !brandMatches()) throw Error(result.errors.slice(0, 3).join('；') || '请先生成符合库存、报价与预算约束的组合');
    const candidates = exportCandidates();
    // Deliberately no spread of imported records: only public quantities, prices and matching IDs.
    const payload = {
      version: data.version, inventoryPeriod: data.inventoryPeriod, excluded, mediaTypes: brief.mediaTypes,
      planning: P.settings(planning), periodDays: P.execution(brief, result, planning).days,
      periodStart: brief.start, periodEnd: brief.end, budget: brief.budget, months: brief.months,
      anchors: data.anchors.filter(anchor => brief.anchorIds.includes(anchor.id)).map(anchor => ({id:anchor.id, name:anchor.name})),
      rows: candidates.map(resource => ({
        id: resource.id, name: resource.name, mediaType: resource.mediaType, available: resource.available,
        sourceRef: resource.sourceRef, coverageAnchorIds: matchingAnchors(resource),
        price: {monthlyLow:resource.price.monthlyLow, monthlyHigh:resource.price.monthlyHigh, productionLow:resource.price.productionLow, productionHigh:resource.price.productionHigh},
        originalQuantity: E.quantity(selection, resource.id)
      }))
    };
    const encoded = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const script = `const data=${encoded};
const $=id=>document.getElementById(id);const money=n=>'¥'+n.toLocaleString('zh-CN');
const engine=(${E.createEngine.toString()})(), planner=(${P.createPlanning.toString()})();
const esc=${esc.toString()}, wan=${wan.toString()};
${strategyComparisonHTML.toString()}
const dataset={version:data.version, inventoryPeriod:data.inventoryPeriod, anchors:data.anchors, resources:data.rows};
let trialBudget, trialPair;
function refreshClientStrategies() {
  const amount = Number($('clientBudget').value);
  if (amount === trialBudget) return;
  trialBudget = amount;
  if (!Number.isInteger(amount) || amount < 100 || amount > 500) {
    trialPair = null;
    $('clientComparison').textContent = '请输入100–500之间的整数万元以查看两种建议。';
    return;
  }
  const brief = {budget:amount*10000, months:data.months, start:data.periodStart, end:data.periodEnd,
    mediaTypes:data.mediaTypes, anchorIds:data.anchors.map(anchor => anchor.id)};
  trialPair = planner.strategyComparison(engine, dataset, brief, data.excluded, data.planning);
  $('clientComparison').innerHTML = strategyComparisonHTML(trialPair, brief, data.planning, 'client');
}
$('clientComparison').addEventListener('click', event => {
  const key = event.target.closest('button[data-adopt-strategy]')?.dataset.adoptStrategy;
  const selected = trialPair?.[key]?.selection;
  if (!selected) return;
  data.rows.forEach((row, index) => { $('clientQ'+index).value = engine.quantity(selected, row.id); });
  calc();
});
function calc(){refreshClientStrategies();let low=0,high=0,buses=0,metro=0,complete=true;const covered=new Set();const entered=Number($('clientBudget').value);if(!Number.isInteger(entered)||entered<100||entered>500){$('clientResult').textContent='预算请输入100–500之间的整数万元';$('clientResult').classList.add('error-text');return;}for(let i=0;i<data.rows.length;i++){const r=data.rows[i],input=$('clientQ'+i),q=Number(input.value),cap=r.available===null?0:r.available;if(!Number.isInteger(q)||q<0||q>cap){$('clientResult').textContent='数量必须是0至同档期可售上限之间的整数；未知库存不能增加。';$('clientResult').classList.add('error-text');return;}if(!q){$('clientCost'+i).textContent=money(0);continue;}if(r.mediaType==='bus')buses+=q;else metro+=q;r.coverageAnchorIds.forEach(id=>covered.add(id));const p=r.price,valid=['monthlyLow','monthlyHigh','productionLow','productionHigh'].every(k=>Number.isSafeInteger(p[k])&&p[k]>=0);if(!valid){complete=false;$('clientCost'+i).textContent='报价不完整（未按0补齐）';continue;}const a=q*(p.monthlyLow*data.months+p.productionLow),b=q*(p.monthlyHigh*data.months+p.productionHigh);low+=a;high+=b;$('clientCost'+i).textContent=money(a)+'–'+money(b);}const budget=entered*10000;$('clientResult').textContent='调整后：'+buses+'辆公交 / '+metro+'个地铁点位；匹配'+covered.size+'/'+data.anchors.length+'个锚点；'+(complete?'已知费用区间 '+money(low)+'–'+money(high)+'；'+(high>budget?'上界超预算 '+money(high-budget):'上界余量 '+money(budget-high)):'有报价缺项，无法确认总额和预算余量')+'。税费及其他收费待确认；原方案不随此区更新。';const cfg=data.planning,up=Math.ceil(buses/cfg.upCapacity),down=Math.ceil(buses/cfg.downCapacity),publish=buses>0?Math.max(0,data.periodDays-up-down-2*cfg.weatherBuffer):0,start=new Date(Date.parse(data.periodStart+'T00:00:00Z')+(up+cfg.weatherBuffer)*86400000).toISOString().slice(0,10),end=new Date(Date.parse(data.periodEnd+'T00:00:00Z')-(down+cfg.weatherBuffer)*86400000).toISOString().slice(0,10);$('clientResult').textContent+=' 按团队施工假设：上下刊'+up+'/'+down+'夜，两端共'+2*cfg.weatherBuffer+'夜缓冲，'+(metro?'整组共同发布窗口待核，地铁没有已确认的施工产能':'共同发布'+publish+'天'+(publish?'（'+start+'至'+end+'）':''))+'，目标至少'+cfg.minPublishDays+'天；'+(complete?'执行预留'+money(cfg.executionReserve)+'后预算占用上界'+money(high+cfg.executionReserve):'报价有缺项，含预留的预算占用上界待核')+'。'+'上方为原始方案快照；本区仅重算，不代表已确认施工或效果。';$('clientResult').classList.toggle('error-text',!complete||high+cfg.executionReserve>budget||publish<cfg.minPublishDays||metro>0);}
document.querySelectorAll('#interactive input').forEach(input=>{input.addEventListener('input',calc);input.addEventListener('change',()=>{if(input.id==='clientBudget')input.value=Math.min(500,Math.max(100,Math.round(Number(input.value)||100)));else input.value=Math.min(Number(input.max),Math.max(0,Math.floor(Number(input.value)||0)));calc();});});$('restoreOriginal').onclick=()=>{data.rows.forEach((r,i)=>$('clientQ'+i).value=r.originalQuantity);$('clientBudget').value=data.budget/10000;calc();};$('clientPrint').onclick=()=>window.print();calc();`;
    const interactive = '<section id="interactive" class="proposal-section"><h3>现场调整与对比</h3><p>本区与上方原始方案独立，调整不会改写原提案。可增减当前媒体类型、门店覆盖与完整查询档期匹配的所有候选，均以已记录的同档期物理可售数量为上限；未知库存不能增加，未知报价不会补0。调整后仍须由业务核定库存与商业条件。</p><div class="inline-actions"><label class="field">预算（万元）<input type="number" id="clientBudget" min="100" max="500" step="1" value="' + brief.budget / 10000 + '"></label><button class="btn" id="restoreOriginal">恢复原组合</button><button class="btn" id="clientPrint">打印 / 保存PDF</button></div><p>计费月数固定为原方案的 ' + brief.months + ' 月，完整档期为 ' + esc(brief.start + ' 至 ' + brief.end) + '；改变档期须回工作台重新查询库存。</p><div id="clientComparison"></div><div class="table-wrap"><table><thead><tr><th>候选媒介 / 公开来源</th><th>可售上限 / 调整数量</th><th>费用区间</th></tr></thead><tbody>' + candidates.map((resource, index) => '<tr><td>' + esc(resource.name) + '<small>' + esc(resource.id) + ' / ' + mediaName(resource.mediaType) + ' / ' + esc(resource.grade) + '</small><small>库存：' + esc(resource.sourceFile || '原文件') + ' / ' + esc(resource.sourceRef) + '</small><small>刊例：' + esc(resource.priceSourceFile || '原文件') + ' / ' + esc(resource.priceSourceRef || '定位未提供') + '</small><small>覆盖：' + esc(coverageDescription(resource)) + '</small></td><td>' + (resource.available === null ? '可售未知' : '最多' + resource.available + unitName(resource.mediaType)) + '<br><input id="clientQ' + index + '" aria-label="' + esc(resource.name) + '数量" type="number" min="0" max="' + (resource.available ?? 0) + '" step="1" value="' + E.quantity(selection, resource.id) + '" ' + (resource.available === null ? 'disabled' : '') + '></td><td id="clientCost' + index + '"></td></tr>').join('') + '</tbody></table></div><p id="clientResult" aria-live="polite"></p></section>';
    const css = await loadStyles(), title = planning.clientAlias + ' · 2027上海户外投放方案';
    const doc = proposalHTML().replace('<footer class="proposal-foot">', interactive + '<footer class="proposal-foot">');
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title><style>' + css + '\nbody{padding:30px 16px}#interactive input{padding:7px;border:1px solid #cad9d1;border-radius:6px;width:100px}#interactive .inline-actions{align-items:center}#interactive .field{margin:0}#interactive p{white-space:normal}.proposal-sources{font-size:13px}.proposal-sources small{display:block}#interactive td{white-space:normal}@media print{body{padding:0}#interactive button{display:none}}</style></head><body class="campaign-studio client-export">' + doc + '<script>' + script + '<\/script></body></html>';
  }
  async function exportHTML() {
    try { const html = await buildExportHTML(); download(safeName(planning.clientAlias + '·2027上海户外投放方案') + '.html', html, 'text/html;charset=utf-8'); toast('已导出独立HTML，包含全部匹配候选的离线调整区'); }
    catch (error) { toast(error.message); }
  }
  function exportCSV() {
    const rows = [['资源ID', '资源名称', '媒体类型', '等级', '物理数量', '计费月数', '费用下界元', '费用上界元', '开始日期', '结束日期', '库存来源', '刊例定位'], ...summary().rows.map(resource => [resource.id, resource.name, mediaName(resource.mediaType), resource.grade, resource.quantity, brief.months, resource.low ?? '待报价', resource.high ?? '待报价', brief.start, brief.end, resource.sourceRef, resource.priceSourceRef])];
    const cell = value => '"' + String(value ?? '').replace(/^[=+\-@]/, char => "'" + char).replace(/"/g, '""') + '"';
    download(safeName(brief.brand + '·媒介清单') + '.csv', '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }

  function setCount(index, raw) {
    const resource = data.resources[index]; if (!resource) return;
    const count = Number(raw), previous = E.quantity(selection, resource.id), state = stateFor(resource);
    if (!Number.isSafeInteger(count) || count < 0 || count > 5000 || (count > previous && (!state.canAdd || count > resource.available))) { toast('请输入当前同档期可售上限内的整数物理数量'); renderInventory(); return; }
    if (count) { selection[resource.id] = count; excluded = excluded.filter(id => id !== resource.id); } else delete selection[resource.id];
    lastPlan = null; invalidate(); render();
  }
  function setBudget(raw) {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 100 || value > 500) { toast('预算请输入100–500之间的整数万元'); syncFields(); return; }
    brief.budget = value * 10000; syncFields(); runPlan(false);
  }
  function onBrandChanged(field) {
    brief[field] = $('#' + field).value;
    if (!brandMatches()) { brief.anchorIds = []; selection = Object.create(null); lastPlan = null; }
    invalidate(); render();
  }
  function bind() {
    $$('.nav').forEach(button => button.addEventListener('click', () => go(button.dataset.page)));
    $$('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
    $('#viewProposal').onclick = () => go('proposal');
    const brandLink = $('a.brand'); if (brandLink) brandLink.addEventListener('click', event => { event.preventDefault(); go('workspace'); });
    $('#optimizeButton').onclick = () => runPlan();
    for (const id of ['workspaceComparison', 'planningComparison']) {
      $('#' + id).addEventListener('click', event => {
        const key = event.target.closest('button[data-adopt-strategy]')?.dataset.adoptStrategy;
        if (!strategies?.[key]?.result) return;
        executionMode = key === 'schedule';
        runPlan(false);
        toast('当前组合已更新为' + (executionMode ? '档期优先' : '预算优先') + '，客户提案已同步。');
        $('#' + id).querySelector('[data-adopt-strategy="' + key + '"]')?.focus({preventScroll:true});
      });
    }
    $('#hypothesisExport').onclick = exportHypothesis;
    $('#clearExecutionConstraints').onclick = () => { executionMode = false; runPlan(); };
    for (const key of Object.keys(planning)) if ($('#' + key)) $('#' + key).addEventListener('change', () => {
      try { const v = ['clientAlias','businessGoal','primaryGoal','successMeasure'].includes(key) ? $('#' + key).value : Number($('#' + key).value) * (key === 'executionReserve' ? 10000 : 1); planning = P.settings({ ...planning, [key]: key === 'executionReserve' ? Math.round(v) : v }); if(key==='primaryGoal'){planning.successMeasure=({认知:'投前与投后在相同商圈、同类人群开展品牌及门店关联认知调查；样本量、基线和提升目标待确认。',到店:'以授权活动码的门店核验量作观测，预先约定归因窗口、去重及自然到店对照；不把扫码直接当增量到店。',促销:'按授权活动码核销及优惠使用量统计；需基线、退款口径及对照，核销量不直接等于广告增量销量。',拉新:'以经客户授权并去重的有效新客记录衡量；明确新客定义、归因窗口及对照，不以页面访问量当新客。'})[v];syncFields();} invalidate(); if(executionMode) runPlan(false); else render(); }
      catch(error) { toast(error.message); syncFields(); }
    });
    $('#applyExecutionConstraints').onclick = () => {
      if (!brandMatches()) { toast('请先接入对应客户证据'); return; }
      const spendLimit = brief.budget - planning.executionReserve;
      if (spendLimit < 0) { toast('执行预留已超过总预算'); return; }
      executionMode = true; runPlan(false); toast('已按产能与内部预留重新组合；实际工期与执行报价仍须确认');
    };

    for (const field of ['brand', 'industry']) {
      $('#' + field).addEventListener(field === 'industry' ? 'change' : 'input', () => onBrandChanged(field));
      $('#' + field).addEventListener('change', () => { if (!brandMatches()) toast('原品牌门店已清空；请导入所选客户的门店及覆盖分析，不能沿用星巴克圈选'); });
    }
    for (const field of ['campaign', 'audience']) $('#' + field).addEventListener('input', () => { brief[field] = $('#' + field).value; invalidate(); render(); });
    $('#budget').addEventListener('input', event => setBudget(event.target.value));
    $('#budgetNumber').addEventListener('change', event => setBudget(event.target.value));
    $$('.budget-preset').forEach(button => button.addEventListener('click', () => setBudget(button.dataset.budget)));
    for (const field of ['start', 'end']) $('#' + field).addEventListener('change', () => { brief[field] = $('#' + field).value; runPlan(false); if (brief.start !== data.inventoryPeriod.start || brief.end !== data.inventoryPeriod.end) toast('新档期尚无对应库存查询，原组合已清空；请同步或导入该完整档期'); });
    $('#months').addEventListener('change', () => {
      const months = Number($('#months').value);
      if (!Number.isSafeInteger(months) || months < 1 || months > 12) { toast('计费月数请输入1–12整数'); syncFields(); return; }
      brief.months = months; runPlan(false); toast('仅按新计费月数重算刊例，未替你核定计费月定义或重新查询库存档期');
    });
    for (const field of ['mediaBus', 'mediaMetro']) $('#' + field).addEventListener('change', () => { brief.mediaTypes = [$('#mediaBus').checked ? 'bus' : null, $('#mediaMetro').checked ? 'metro' : null].filter(Boolean); runPlan(false); });
    $('#anchorGrid').addEventListener('change', event => { const index = event.target.dataset.anchor; if (index === undefined || !brandMatches()) return; const id = data.anchors[Number(index)]?.id; if (!id) return; brief.anchorIds = event.target.checked ? [...new Set([...brief.anchorIds, id])] : brief.anchorIds.filter(value => value !== id); runPlan(false); });
    $('#anchorGrid').addEventListener('click', event => { const button = event.target.closest('[data-anchor-source]'); if (button) showAnchorSource(Number(button.dataset.anchorSource)); });
    $('#inventoryRows').addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button) return;
      if (button.dataset.source !== undefined) showResourceSource(Number(button.dataset.source));
      else if (button.dataset.qty !== undefined) { const index = Number(button.dataset.qty), resource = data.resources[index]; setCount(index, E.quantity(selection, resource.id) + Number(button.dataset.delta)); }
      else if (button.dataset.remove !== undefined) { const resource = data.resources[Number(button.dataset.remove)]; if (excluded.includes(resource.id)) excluded = excluded.filter(id => id !== resource.id); else { excluded.push(resource.id); delete selection[resource.id]; } lastPlan = null; invalidate(); render(); }
    });
    $('#inventoryRows').addEventListener('change', event => { if (event.target.dataset.count !== undefined) setCount(Number(event.target.dataset.count), event.target.value); });
    $('#evidenceRows').addEventListener('click', event => { const button = event.target.closest('[data-evidence-source]'); if (button) showResourceSource(Number(button.dataset.evidenceSource)); });
    $('#resourceSearch').addEventListener('input', renderInventory); $('#resourceMedia').addEventListener('change', renderInventory);
    $('#clearExcluded').onclick = () => { excluded = []; invalidate(); render(); toast('已恢复候选，点击生成组合重新规划'); };
    $('#compareButton').onclick = () => { const result = summary(); baseline = { low: result.low, high: result.high, quantity: result.quantity, resourceCount: result.resourceCount, coveredAnchorIds: [...result.coveredAnchorIds], start: brief.start, end: brief.end, months: brief.months }; render(); toast('已保存当前费用区间与覆盖作为基线'); };
    $('#saveButton').onclick = () => { try { download('云策2027项目.json', JSON.stringify(project(), null, 2)); } catch (error) { toast(error.message); } };
    $('#openProject').onchange = event => { openProject(event.target.files[0]); event.target.value = ''; };
    $('#importData').onchange = event => { importData(event.target.files[0]); event.target.value = ''; };
    $('#templateButton').onclick = () => download('云策2027资源字段模板.json', JSON.stringify(template(), null, 2));
    $('#exportButton').onclick = exportHTML;
    $('#printButton').onclick = () => { renderProposal(); window.print(); };
    if ($('#exportCSVButton')) $('#exportCSVButton').onclick = exportCSV;
    $('#settingsButton').onclick = () => $('#settingsDialog').showModal();
    $('#clearKey').onclick = () => { $('#apiKey').value = ''; toast('本页面密钥已清除'); };
    $('#aiButton').onclick = generateAI;
    if ($('#liveSyncButton')) $('#liveSyncButton').onclick = syncLive;
  }

  try {
    if (!E) throw Error('2027规划引擎未加载');
    data = normalizeData(globalThis.CAMPAIGN_DATA);
    planning = planningFor(data);
    brief = defaultBrief(data);
    bind(); syncFields(); runPlan(false);
    if (location.protocol === 'file:') {
      $('#syncStatus').textContent = '当前为离线版：导入、模板与方案调整可直接使用。实时同步请解压整个交付包，双击“启动完整版.cmd”，在打开的红豆标签页登录后再操作。';
    } else {
      fetch('/api/health').then(r => { if (!r.ok) throw Error('health'); return r.json(); }).then(health => { serviceHealth = health; renderProgress(); $('#syncStatus').textContent = health.inventory.browser ? '已连接本机比赛浏览器；请确认红豆标签页已登录。同步只刷新公交库存，地铁仍保留原始日期和待核状态。' : '本地服务已运行。请用“启动完整版.cmd”打开比赛浏览器并登录红豆，再同步公交库存。'; }).catch(() => { $('#syncStatus').textContent = '无法连接本地服务。请通过启动完整版.cmd运行；当前离线数据和组合已保留。'; });
    }
    if (['workspace', 'planning', 'proposal', 'sources', 'progress'].includes(location.hash.slice(1))) go(location.hash.slice(1));
    // QA surface contains public project state only, never key or model response.
    globalThis.CampaignApp = { getProject: () => structuredClone(project()), getSummary: () => structuredClone(summary()), runPlan, importDataset: applyDataset, buildExportHTML, exportCSV, exportHypothesis, getPlanning: () => ({ executionMode, settings: structuredClone(planning), execution: P.execution(brief, summary(), planning) }), showPage: go };
  } catch (error) {
    console.error('云策工作台未能初始化：', error.message);
    toast('无法初始化：' + error.message);
    if ($('#importResult')) $('#importResult').textContent = '初始化失败：' + error.message;
  }
})();
