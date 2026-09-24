import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';

// 京东响应由 page.route 隔离模拟，仅验证 UI 行为，不代表真实京东 API 验证。
const test = base.extend({
  giftPlans: async ({ request }, use) => {
    const created = await request.post('/api/contacts', { data: { name: 'JD 隔离测试联系人' } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;
    const first = await request.post('/api/tools', { data: { name: 'gift_plan_add', args: { contactId, idea: '甲计划：私人喜好仅供本地参考', budget: '一两百左右', occasion: 'jd_private' } } });
    expect(first.ok()).toBeTruthy();
    const planA = (await first.json()).plan;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const second = await request.post('/api/plans', { data: { contactId, idea: '乙计划：另一份私密礼物', occasion: 'jd_test', occasionDate: tomorrow.toISOString().slice(0, 10) } });
    expect(second.ok()).toBeTruthy();
    const planB = (await second.json()).plan;
    try { await use({ contactId, planA, planB }); }
    finally { await request.delete(`/api/contacts/${contactId}`); }
  },
});

const item = { itemId: '123456', name: '测试保温杯', price: 99.5, imageUrl: '' };
const product = { productName: '官方验证保温杯', productPrice: '99.50', productUrl: 'https://u.jd.com/' + 'x'.repeat(1000) };
const ready = { ok: true, configured: true, missing: [] };
const reply = (route, json, status = 200) => route.fulfill({ status, json });
const jdButton = (page, id) => page.locator(`[data-action="jd-open"][data-id="${id}"]`);
async function gifts(page) {
  await page.goto('/');
  await page.locator('.nav-item[data-view="gifts"]').click();
  await expect(page.locator('#view-gifts .gift-tools > summary').first()).toBeVisible();
  for (const summary of await page.locator('#view-gifts .gift-tools > summary').all()) await summary.click();
}
async function openReady(page, id) {
  await jdButton(page, id).click();
  await expect(page.locator('#jd-search')).toBeEnabled();
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('缺配置只引导本机变量名；可重新检查，关键词按原计划预填', async ({ page, giftPlans }) => {
  let checks = 0;
  await page.route('**/api/jd/status', (route) => {
    checks += 1;
    if (checks === 1) return reply(route, { ok: true, configured: false, missing: ['JD_APP_KEY', 'JD_APP_SECRET', 'JD_SITE_ID'] });
    if (checks === 2) return reply(route, { ok: false, error: '配置检查暂不可用' }, 503);
    return reply(route, ready);
  });
  await gifts(page);
  await jdButton(page, giftPlans.planA.id).click();
  await expect(page.locator('#form-jd')).toBeVisible();
  await expect(page.locator('#jd-status')).toContainText('JD_APP_SECRET');
  await expect(page.locator('#jd-status')).toContainText('请勿在此输入密钥');
  await expect(page.locator('#jd-search')).toBeDisabled();
  await expect(page.locator('#jd-keyword')).toHaveValue('甲计划');
  await expect(page.locator('#jd-min-price')).toHaveValue('');
  await expect(page.locator('#jd-max-price')).toHaveValue('');
  await expect(page.locator('#jd-keyword')).toHaveAttribute('maxlength', '80');
  await expect(page.locator('#jd-max-price')).toHaveAttribute('max', '1000000');
  await expect(page.locator('#form-jd')).toContainText('价格范围按京东券后价筛选');
  await expect(page.locator('#jd-plan-reference')).toContainText(giftPlans.planA.idea);
  await expect(page.locator('#jd-plan-reference')).toContainText('一两百左右');
  await expect(page.locator('#form-jd')).toContainText('仅发送你填写的关键词和价格范围至京东');
  await page.locator('#jd-status-retry').click();
  await expect(page.locator('#jd-status')).toContainText('配置检查暂不可用');
  await page.locator('#jd-status-retry').click();
  await expect(page.locator('#jd-search')).toBeEnabled();
  await expect(page.locator('#jd-status')).toContainText('已按原计划预填');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#modal-backdrop')).toBeHidden();
});

test('真实计划内嵌入口：关键词搜索范围、空结果和失败重试，安全渲染候选', async ({ page, giftPlans }) => {
  const payloads = [];
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route('https://images.example.test/**', (route) => route.abort());
  await page.route(`**/api/plans/${giftPlans.planB.id}/jd/search`, (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return reply(route, { ok: true, items: [] });
    if (payloads.length === 2) return reply(route, { ok: false, error: '京东搜索失败，请重试' }, 502);
    return reply(route, { ok: true, items: [
      { ...item, name: '<img src=x onerror=alert(1)> & 杯', imageUrl: 'https://images.example.test/cup.png' },
      { ...item, itemId: '2', imageUrl: 'javascript:alert(1)' },
      { ...item, itemId: '3', imageUrl: 'http://images.example.test/insecure.png' },
    ] });
  });
  await gifts(page);
  await expect(page.locator(`#occasions-list [data-action="jd-open"][data-id="${giftPlans.planB.id}"]`)).toBeVisible();
  await openReady(page, giftPlans.planB.id);
  await expect(page.locator('#jd-keyword')).toHaveValue('乙计划');
  await page.locator('#jd-keyword').fill('保温杯');
  await page.locator('#jd-min-price').fill('200');
  await page.locator('#jd-max-price').fill('100');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('最低价不能高于最高价');
  expect(payloads).toEqual([]);
  await page.locator('#jd-min-price').fill('0');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('没有找到商品');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('京东搜索失败');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-results .occ-card')).toHaveCount(3);
  await expect(page.locator('#jd-results')).toContainText('<img src=x onerror=alert(1)> & 杯');
  await expect(page.locator('#jd-results')).toContainText('非成交价');
  await expect(page.locator('#jd-results img')).toHaveCount(1);
  await expect(page.locator('#jd-results img')).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(page.locator('#jd-results [onerror]')).toHaveCount(0);
  expect(payloads).toEqual(Array(3).fill({ keyword: '保温杯', minPrice: 0, maxPrice: 100 }));
});

for (const [label, keyword] of [['空关键词', ''], ['空白关键词', ' \u3000  ']]) {
  test(`${label}查看全部品类24小时热销榜前20（模拟京东响应）`, async ({ page, giftPlans }) => {
    const payloads = [];
    const started = deferred();
    const release = deferred();
    await page.route('**/api/jd/status', (route) => reply(route, ready));
    await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, async (route) => {
      payloads.push(route.request().postDataJSON());
      started.resolve();
      await release.promise;
      return reply(route, { ok: true, items: Array.from({ length: 20 }, (_, index) => ({ ...item, itemId: String(index), name: `榜单商品 ${index + 1}` })) });
    });
    await gifts(page);
    await openReady(page, giftPlans.planA.id);
    await page.locator('#jd-keyword').fill(keyword);
    await expect(page.locator('#jd-keyword')).not.toHaveAttribute('required', '');
    await expect(page.locator('#jd-search')).toHaveText('查看热销榜');
    await expect(page.locator('#jd-min-price')).toBeDisabled();
    await expect(page.locator('#jd-max-price')).toBeDisabled();
    await expect(page.locator('#jd-price-hint')).toContainText('全部品类24小时热销榜前20不支持价格筛选');
    await page.locator('#jd-search').click();
    await started.promise;
    await expect(page.locator('#jd-status')).toContainText('正在获取京东全部品类24小时热销榜前20');
    await expect(page.locator('#jd-search')).toBeDisabled();
    release.resolve();
    await expect(page.locator('#jd-results .occ-card')).toHaveCount(20);
    await expect(page.locator('#jd-status')).toContainText('全部品类24小时热销榜前20：返回 20 件');
    await expect(page.locator('#jd-search')).toBeEnabled();
    await expect(page.locator('#jd-search')).toHaveText('查看热销榜');
    await expect(page.locator('#jd-keyword')).toHaveValue(keyword);
    await expect(page.locator('#jd-min-price')).toBeDisabled();
    await expect(page.locator('#jd-max-price')).toBeDisabled();
    expect(payloads).toEqual([{ keyword: '' }]);
  });
}

test('热销榜不发送残留价格；切回关键词恢复价格值、校验与搜索', async ({ page, giftPlans }) => {
  const payloads = [];
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => {
    payloads.push(route.request().postDataJSON());
    return reply(route, { ok: true, items: [item] });
  });
  await gifts(page);
  await openReady(page, giftPlans.planA.id);
  await page.locator('#jd-min-price').fill('200');
  await page.locator('#jd-max-price').fill('100');
  await page.locator('#jd-keyword').fill('   ');
  await expect(page.locator('#jd-min-price')).toBeDisabled();
  await expect(page.locator('#jd-max-price')).toBeDisabled();
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('全部品类24小时热销榜前20：返回 1 件');
  await expect(page.locator('#jd-search')).toBeEnabled();
  await expect(page.locator('#jd-min-price')).toBeDisabled();
  await expect(page.locator('#jd-max-price')).toBeDisabled();
  await expect(page.locator('#jd-min-price')).toHaveValue('200');
  await expect(page.locator('#jd-max-price')).toHaveValue('100');
  expect(payloads).toEqual([{ keyword: '' }]);
  await page.locator('#jd-keyword').fill('保温杯');
  await expect(page.locator('#jd-search')).toHaveText('搜索商品');
  await expect(page.locator('#jd-min-price')).toBeEnabled();
  await expect(page.locator('#jd-max-price')).toBeEnabled();
  await expect(page.locator('#jd-min-price')).toHaveValue('200');
  await expect(page.locator('#jd-max-price')).toHaveValue('100');
  await expect(page.locator('#jd-price-hint')).toContainText('价格仅适用于关键词搜索');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('最低价不能高于最高价');
  expect(payloads).toEqual([{ keyword: '' }]);
  await page.locator('#jd-min-price').fill('0');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('搜索找到 1 件候选商品');
  await expect(page.locator('#jd-search')).toBeEnabled();
  expect(payloads).toEqual([{ keyword: '' }, { keyword: '保温杯', minPrice: 0, maxPrice: 100 }]);
});

test('热销榜空结果与失败明确提示，可原条件重试', async ({ page, giftPlans }) => {
  const payloads = [];
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return reply(route, { ok: true, items: [] });
    if (payloads.length === 2) return reply(route, { ok: false, error: '京东请求暂不可用' }, 502);
    return reply(route, { ok: true, items: [item] });
  });
  await gifts(page);
  await openReady(page, giftPlans.planA.id);
  await page.locator('#jd-keyword').fill('   ');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('全部品类24小时热销榜前20暂无商品');
  await expect(page.locator('#jd-results .occ-card')).toHaveCount(0);
  await expect(page.locator('#jd-search')).toBeEnabled();
  await expect(page.locator('#jd-search')).toHaveText('查看热销榜');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('全部品类24小时热销榜前20加载失败');
  await expect(page.locator('#jd-status')).toContainText('京东请求暂不可用');
  await expect(page.locator('#jd-status')).toContainText('可再次查看热销榜重试');
  await expect(page.locator('#jd-search')).toBeEnabled();
  await expect(page.locator('#jd-search')).toHaveText('查看热销榜');
  await expect(page.locator('#jd-keyword')).toHaveValue('   ');
  await expect(page.locator('#jd-min-price')).toBeDisabled();
  await expect(page.locator('#jd-max-price')).toBeDisabled();
  expect(payloads).toEqual([{ keyword: '' }, { keyword: '' }]);
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('全部品类24小时热销榜前20：返回 1 件');
  await expect(page.locator('#jd-results .occ-card')).toHaveCount(1);
  expect(payloads).toEqual(Array(3).fill({ keyword: '' }));
});

test('关键词搜索 403 不清空关键词、不自动请求热销榜', async ({ page, giftPlans }) => {
  const payloads = [];
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => {
    payloads.push(route.request().postDataJSON());
    if (payloads.length === 1) return reply(route, { ok: false, error: '当前应用没有商品查询 API 权限' }, 403);
    return reply(route, { ok: true, items: [item] });
  });
  await gifts(page);
  await openReady(page, giftPlans.planA.id);
  await expect(page.locator('#jd-status')).toContainText('配置就绪');
  await expect(page.locator('#jd-status')).not.toContainText('API 权限已就绪');
  await page.locator('#jd-keyword').fill('保温杯');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('商品搜索失败');
  await expect(page.locator('#jd-status')).toContainText('没有商品查询 API 权限');
  await expect(page.locator('#jd-search')).toBeEnabled();
  await expect(page.locator('#jd-search')).toHaveText('搜索商品');
  await expect(page.locator('#jd-keyword')).toHaveValue('保温杯');
  await expect(page.locator('#jd-results .occ-card')).toHaveCount(0);
  expect(payloads).toEqual([{ keyword: '保温杯' }]);
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-status')).toContainText('搜索找到 1 件候选商品');
  expect(payloads).toEqual([{ keyword: '保温杯' }, { keyword: '保温杯' }]);
});

test('选择失败可重试；发商品编号与展示名称/价格，关联原 AI 卡而不新建/已送', async ({ page, request, giftPlans }) => {
  const selections = [];
  const release = deferred();
  const started = deferred();
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => reply(route, { ok: true, items: [item] }));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/select`, async (route) => {
    selections.push(route.request().postDataJSON());
    if (selections.length === 1) {
      started.resolve();
      await release.promise;
      return reply(route, { ok: false, error: '推广链接生成失败' }, 502);
    }
    const updated = await request.patch(`/api/plans/${giftPlans.planA.id}`, { data: product });
    expect(updated.ok()).toBeTruthy();
    return reply(route, await updated.json());
  });
  await gifts(page);
  await expect(page.locator(`#plans-list [data-action="jd-open"][data-id="${giftPlans.planA.id}"]`)).toBeVisible();
  await openReady(page, giftPlans.planA.id);
  await page.locator('#jd-keyword').fill('杯');
  await page.locator('#jd-search').click();
  const choose = page.getByRole('button', { name: '选中并关联' });
  await choose.click();
  await started.promise;
  await expect(choose).toBeDisabled();
  await expect(page.locator('#jd-search')).toBeDisabled();
  expect(selections).toHaveLength(1);
  release.resolve();
  await expect(page.locator('#jd-status')).toContainText('推广链接生成失败');
  await choose.click();
  // 折中交互：选中成功后弹窗不自动关，原地显示「立即查看商品」成功态，点完成后才关闭
  await expect(page.locator('#jd-results')).toContainText('已关联原计划');
  await expect(page.locator('#jd-results')).toContainText('未购买、未标记已送');
  await expect(page.locator('#toast')).toContainText('CPS 推广链接');
  const view = page.locator('#jd-results a.primary-btn');
  await expect(view).toHaveAttribute('href', product.productUrl);
  await expect(view).toHaveAttribute('rel', 'noreferrer noopener');
  // 独立模式点链接走原生新标签；外网导航由测试拦截（不真连京东），只断言弹窗地址
  await page.context().route(/u\.jd\.com/, (route) => route.fulfill({ contentType: 'text/html', body: 'e2e' }));
  const popupPromise = page.waitForEvent('popup');
  await view.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(product.productUrl);
  await popup.close();
  // 「复制链接」逃生口：点一下即拿到完整 CPS 链接，任何环境可用
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.locator('#jd-results').getByRole('button', { name: '复制链接' }).click();
  await expect(page.locator('#toast')).toContainText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(product.productUrl);
  // 成功面板内嵌二维码：桌面选品、手机扫码成交的主力通路
  await expect(page.locator('#jd-results .jd-qr svg')).toBeVisible();
  await page.locator('#jd-results').getByRole('button', { name: '完成' }).click();
  await expect(page.locator('#modal-backdrop')).toBeHidden();
  const card = page.locator('.occ-card').filter({ has: jdButton(page, giftPlans.planA.id) });
  await expect(card).toContainText('官方验证保温杯');
  await expect(card).toContainText('CPS 推广链接');
  await expect(card).toContainText('AI 建议');
  await expect(card.locator('a')).toHaveAttribute('href', product.productUrl);
  // 计划卡「扫码买」：二维码弹窗 + 复制链接（首页时机提醒卡同一 planProductLine 复用）
  await card.getByRole('button', { name: '扫码买' }).click();
  await expect(page.locator('#form-qr')).toBeVisible();
  await expect(page.locator('#qr-product-line')).toContainText('官方验证保温杯');
  await expect(page.locator('#qr-image svg')).toBeVisible();
  await page.locator('#form-qr').getByRole('button', { name: '复制链接' }).click();
  await expect(page.locator('#toast')).toContainText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(product.productUrl);
  await page.locator('#form-qr').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#modal-backdrop')).toBeHidden();
  expect(selections).toEqual([
    { itemId: item.itemId, name: item.name, price: item.price },
    { itemId: item.itemId, name: item.name, price: item.price },
  ]);
  const plans = (await (await request.get(`/api/plans?contact_id=${giftPlans.contactId}`)).json()).plans;
  expect(plans).toHaveLength(2);
  expect(plans.find((p) => p.id === giftPlans.planA.id)).toMatchObject({ ...product, status: 'idea', source: 'ai', idea: giftPlans.planA.idea });
  expect(plans.find((p) => p.id === giftPlans.planB.id).productUrl).toBe('');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('#plan-product-url')).toHaveAttribute('maxlength', '4096');
  await expect(page.locator('#plan-product-url')).toHaveValue(product.productUrl);
});

test('嵌入 DSH：点「立即查看商品」改由宿主页面代开，不依赖沙箱 iframe 弹窗', async ({ page, request, giftPlans, baseURL }) => {
  // 回归：桌面壳会吞掉沙箱 iframe 里的 target=_blank（用户点了没反应）。
  // sandbox 属性实时提取自 lib/client.js；宿主半只记录 open-external 消息，不真开窗。
  const clientSrc = fs.readFileSync('lib/client.js', 'utf8');
  const sandboxAttr = /setAttribute\('sandbox',\s*'([^']+)'\)/.exec(clientSrc)?.[1];
  expect(sandboxAttr, 'lib/client.js 中应能提取到 iframe sandbox 属性').toBeTruthy();
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => reply(route, { ok: true, items: [item] }));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/select`, async (route) => {
    const updated = await request.patch(`/api/plans/${giftPlans.planA.id}`, { data: product });
    return reply(route, await updated.json());
  });
  await page.route(`${baseURL}/__jd-embedded-host.html`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body style="margin:0">
      <script>window.__relMsgs = []; window.addEventListener('message', function (e) { window.__relMsgs.push(e.data); });</script>
      <iframe src="/" sandbox="${sandboxAttr}" style="width:100vw;height:100vh;border:0"></iframe>
    </body></html>`,
  }));
  await page.goto(`${baseURL}/__jd-embedded-host.html`);
  const frame = page.frames().find((f) => f.url() === `${baseURL}/`);
  expect(frame).toBeTruthy();
  await frame.locator('.nav-item[data-view="gifts"]').click();
  await expect(frame.locator('#view-gifts .gift-tools > summary').first()).toBeVisible();
  for (const summary of await frame.locator('#view-gifts .gift-tools > summary').all()) await summary.click();
  await frame.locator(`[data-action="jd-open"][data-id="${giftPlans.planA.id}"]`).click();
  await expect(frame.locator('#jd-search')).toBeEnabled();
  await frame.locator('#jd-search').click();
  await frame.getByRole('button', { name: '选中并关联' }).click();
  await expect(frame.locator('#jd-results')).toContainText('已关联原计划');
  let popups = 0;
  page.on('popup', () => { popups += 1; });
  await frame.locator('#jd-results a.primary-btn').click();
  await page.waitForFunction((url) => window.__relMsgs.some((m) => m && m.source === 'dsh-relationship' && m.type === 'open-external' && m.url === url), product.productUrl);
  expect(popups).toBe(0);
  await expect(frame.locator('#form-jd')).toBeVisible();
});

for (const stage of ['status', 'search', 'select']) {
  test(`取消后过期 ${stage} 响应不串另一计划弹窗`, async ({ page, request, giftPlans }) => {
    const pending = deferred();
    const started = deferred();
    const finished = deferred();
    let statusCalls = 0;
    await page.route('**/api/jd/status', async (route) => {
      if (stage === 'status' && ++statusCalls === 1) {
        started.resolve();
        await pending.promise;
        await reply(route, { ok: true, configured: false, missing: ['JD_APP_SECRET'] });
        finished.resolve();
      } else await reply(route, ready);
    });
    await page.route('**/api/plans/*/jd/search', async (route) => {
      if (stage === 'search' && route.request().url().includes(giftPlans.planA.id)) {
        started.resolve();
        await pending.promise;
        await reply(route, { ok: true, items: [{ ...item, name: '过期甲商品' }] });
        finished.resolve();
      } else await reply(route, { ok: true, items: [{ ...item, name: '当前候选商品' }] });
    });
    await page.route(`**/api/plans/${giftPlans.planA.id}/jd/select`, async (route) => {
      started.resolve();
      await pending.promise;
      const updated = await request.patch(`/api/plans/${giftPlans.planA.id}`, { data: product });
      await reply(route, await updated.json());
      finished.resolve();
    });
    await gifts(page);
    await jdButton(page, giftPlans.planA.id).click();
    if (stage !== 'status') {
      await expect(page.locator('#jd-search')).toBeEnabled();
      await page.locator('#jd-keyword').fill('甲关键词');
      await page.locator('#jd-search').click();
      if (stage === 'select') await page.getByRole('button', { name: '选中并关联' }).click();
    }
    await started.promise;
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await openReady(page, giftPlans.planB.id);
    await expect(page.locator('#jd-keyword')).toHaveValue('乙计划');
    await page.locator('#jd-keyword').fill('乙关键词');
    await page.locator('#jd-search').click();
    await expect(page.locator('#jd-results')).toContainText('当前候选商品');
    pending.resolve();
    await finished.promise;
    await expect(page.locator('#form-jd')).toBeVisible();
    await expect(page.locator('#jd-plan-reference')).toContainText(giftPlans.planB.idea);
    await expect(page.locator('#jd-keyword')).toHaveValue('乙关键词');
    await expect(page.locator('#jd-results')).not.toContainText('过期甲商品');
    await expect(page.locator('#jd-status')).not.toContainText('JD_APP_SECRET');
    await expect(page.locator('#jd-search')).toBeEnabled();
    const plans = (await (await request.get(`/api/plans?contact_id=${giftPlans.contactId}`)).json()).plans;
    expect(plans.find((p) => p.id === giftPlans.planB.id).productUrl).toBe('');
  });
}

test('窄屏 20 条候选可滚动到底，参考标价超过券后上限仍显示', async ({ page, giftPlans }) => {
  await page.setViewportSize({ width: 390, height: 640 });
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await page.route(`**/api/plans/${giftPlans.planA.id}/jd/search`, (route) => reply(route, {
    ok: true, items: Array.from({ length: 20 }, (_, index) => ({ ...item, itemId: String(index), name: `测试商品 ${index + 1}`, price: 120 })),
  }));
  await gifts(page);
  await openReady(page, giftPlans.planA.id);
  await page.locator('#jd-keyword').fill('杯');
  await page.locator('#jd-max-price').fill('100');
  await page.locator('#jd-search').click();
  await expect(page.locator('#jd-results .occ-card')).toHaveCount(20);
  const last = page.locator('#jd-results .occ-card').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.getByRole('button', { name: '选中并关联' })).toBeInViewport();
  await expect(last).toContainText('参考标价 ¥120');
  const bounds = await page.locator('.modal').evaluate((el) => ({ left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right, width: innerWidth, scrollable: el.scrollHeight > el.clientHeight }));
  expect(bounds.scrollable).toBe(true);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#modal-backdrop')).toBeHidden();
  const card = page.locator('#plans-list .occ-card').filter({ has: jdButton(page, giftPlans.planA.id) });
  expect(await card.locator('.occ-main').evaluate((el) => el.clientWidth)).toBeGreaterThan(120);
  await page.locator('#btn-new-plan').click();
  await expect(page.locator('#form-plan')).toBeVisible();
  await expect(page.locator('#form-jd')).toBeHidden();
});

test('已送计划不显示京东入口', async ({ page, request, giftPlans }) => {
  await request.patch(`/api/plans/${giftPlans.planA.id}`, { data: { status: 'sent' } });
  await page.route('**/api/jd/status', (route) => reply(route, ready));
  await gifts(page);
  await expect(jdButton(page, giftPlans.planA.id)).toHaveCount(0);
  await expect(jdButton(page, giftPlans.planB.id)).toBeVisible();
});
