const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const workspacePanel = '#workspaceComparison';
const planningPanel = '#planningComparison';
const clientPanel = '#clientComparison';
const snapshotPanel = '.proposal-doc .strategy-comparison';

async function numberField(page, selector, value) {
  const field = page.locator(selector);
  await field.fill(String(value));
  await field.press('Tab');
}

async function metrics(page, panelSelector, strategy) {
  const card = page.locator(panelSelector).first().locator('[data-strategy-card="' + strategy + '"]');
  const values = {};
  for (const metric of ['buses', 'days']) {
    const text = await card.locator('[data-metric="' + metric + '"]').innerText();
    values[metric] = Number(text.match(/\d+/)?.[0]);
  }
  return values;
}

async function assertComparison(page, panel, expected) {
  for (const [key, values] of Object.entries(expected)) {
    assert.deepEqual(await metrics(page, panel, key), values, panel + ' ' + key);
  }
}

const standard = { budget: { buses: 28, days: 17 }, schedule: { buses: 28, days: 17 } };
const expanded = { budget: { buses: 71, days: 3 }, schedule: { buses: 36, days: 15 } };

async function main() {
  const file = process.argv[2];
  const server = file ? null : require('../campaign-server.cjs').start(0);
  if (server && !server.listening) await require('node:events').once(server, 'listening');
  const target = file ? pathToFileURL(path.resolve(file)).href : 'http://127.0.0.1:' + server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ executablePath: process.env.EDGE_EXECUTABLE || (fs.existsSync(edge) ? edge : undefined) });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yunce-v13-qa-'));
  try {
    const context = await browser.newContext({ offline: Boolean(file), viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const errors = [];
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(target);
    await assertComparison(page, workspacePanel, standard);
    await page.locator('[data-budget="500"]').click();
    await assertComparison(page, workspacePanel, expanded);

    const decrease = page.locator('button[data-delta="-1"]:enabled').first();
    await decrease.click();
    assert.equal(await page.evaluate(() => CampaignApp.getSummary().busUnits), 70);
    await assertComparison(page, workspacePanel, expanded);

    await page.locator(workspacePanel + ' [data-adopt-strategy="schedule"]').click();
    assert.equal(await page.evaluate(() => CampaignApp.getSummary().busUnits), 36);
    await assertComparison(page, workspacePanel, expanded);
    await page.locator('[data-page="planning"]').click();
    await assertComparison(page, planningPanel, expanded);
    await numberField(page, '#upCapacity', 12);
    await numberField(page, '#downCapacity', 12);
    const faster = { buses: 71, days: 15 };
    await assertComparison(page, planningPanel, { budget: faster, schedule: faster });
    await numberField(page, '#upCapacity', 6);
    await numberField(page, '#downCapacity', 6);
    await numberField(page, '#minPublishDays', 15);
    assert.deepEqual(await metrics(page, planningPanel, 'schedule'), { buses: 36, days: 15 });
    await numberField(page, '#minPublishDays', 16);
    assert.deepEqual(await metrics(page, planningPanel, 'schedule'), { buses: 30, days: 17 });
    await numberField(page, '#minPublishDays', 14);
    await page.locator('[data-page="workspace"]').click();
    await page.locator(workspacePanel + ' [data-adopt-strategy="budget"]').click();
    assert.equal(await page.evaluate(() => CampaignApp.getSummary().busUnits), 71);
    await page.locator('[data-page="proposal"]').click();
    await assertComparison(page, snapshotPanel, expanded);
    const downloaded = page.waitForEvent('download');
    await page.locator('#exportButton').click();
    const clientFile = path.join(temp, 'client.html');
    await (await downloaded).saveAs(clientFile);

    await context.setOffline(true);
    const client = await context.newPage();
    client.setDefaultTimeout(5000);
    await client.goto(pathToFileURL(clientFile).href);
    await assertComparison(client, snapshotPanel, expanded);
    await assertComparison(client, clientPanel, expanded);
    await numberField(client, '#clientBudget', 200);
    await assertComparison(client, clientPanel, standard);
    await assertComparison(client, snapshotPanel, expanded);
    await client.locator(clientPanel + ' [data-adopt-strategy="schedule"]').click();
    assert.match(await client.locator('#clientResult').innerText(), /28\s*辆/);
    await client.locator('#restoreOriginal').click();
    assert.match(await client.locator('#clientResult').innerText(), /71\s*辆/);
    await assertComparison(client, clientPanel, expanded);
    await client.setViewportSize({ width: 390, height: 844 });
    assert(await client.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile client width');
    await page.locator('[data-page="workspace"]').click();
    if (process.env.COMPARISON_PREVIEW) {
      await page.waitForFunction(() => !document.querySelector('#toast.show'), undefined, { timeout: 9000 });
      await page.locator(workspacePanel).screenshot({ path: process.env.COMPARISON_PREVIEW });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile studio width');
    await page.locator('#industry').selectOption('银行保险');
    assert.equal(await page.evaluate(() => CampaignApp.getSummary().busUnits), 0);
    assert(!/71\s*辆/.test(await page.locator(workspacePanel).innerText()), 'stale brand suggestion');
    assert.deepEqual(errors, []);
    console.log('PASS | ' + (file ? 'offline bundle' : 'service') + ' | 200/500万元、手选、双向采用、施工产能、档期整数边界、离线导出/恢复、手机宽度、品牌切换');
  } finally {
    await browser.close();
    fs.rmSync(path.join(temp, 'client.html'), { force: true });
    fs.rmdirSync(temp);
    if (server) await new Promise(resolve => server.close(resolve));
  }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
