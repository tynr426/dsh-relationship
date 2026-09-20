import { test as base, expect } from '@playwright/test';

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

test('真实计划内嵌入口：必填、范围、空结果和失败重试，安全渲染候选', async ({ page, giftPlans }) => {
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
  await page.locator('#jd-keyword').fill('');
  await page.locator('#jd-search').click();
  expect(payloads).toEqual([]);
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

test('选择失败可重试；只发商品编号，关联原 AI 卡而不新建/已送', async ({ page, request, giftPlans }) => {
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
  await expect(page.locator('#modal-backdrop')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('CPS 推广链接');
  const card = page.locator('.occ-card').filter({ has: jdButton(page, giftPlans.planA.id) });
  await expect(card).toContainText('官方验证保温杯');
  await expect(card).toContainText('CPS 推广链接');
  await expect(card).toContainText('AI 建议');
  await expect(card.locator('a')).toHaveAttribute('href', product.productUrl);
  expect(selections).toEqual([{ itemId: item.itemId }, { itemId: item.itemId }]);
  const plans = (await (await request.get(`/api/plans?contact_id=${giftPlans.contactId}`)).json()).plans;
  expect(plans).toHaveLength(2);
  expect(plans.find((p) => p.id === giftPlans.planA.id)).toMatchObject({ ...product, status: 'idea', source: 'ai', idea: giftPlans.planA.idea });
  expect(plans.find((p) => p.id === giftPlans.planB.id).productUrl).toBe('');
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.locator('#plan-product-url')).toHaveAttribute('maxlength', '4096');
  await expect(page.locator('#plan-product-url')).toHaveValue(product.productUrl);
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
