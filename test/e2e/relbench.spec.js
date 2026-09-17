import { test, expect } from '@playwright/test';
import fs from 'node:fs';

test.describe('关系记忆工作台', () => {
  test('首页可访问并显示核心区块', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#metric-cards')).toBeVisible();
    await expect(page.locator('#pending-queue')).toBeVisible();
    await expect(page.getByRole('heading', { name: '待确认队列' })).toBeVisible();
  });

  test('新建联系人并出现在列表', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.getByRole('button', { name: '＋ 新建联系人' }).click();
    await page.locator('#nc-name').fill('E2E 小李');
    await page.locator('#nc-relation').selectOption('friend');
    await page.locator('#nc-birthday').fill('10-02');
    await page.locator('#nc-tags').fill('大学同学 羽毛球');
    await page.locator('#nc-ok').click();
    await expect(page.locator('#toast')).toContainText('联系人已创建');

    await page.locator('.nav-item[data-view="contacts"]').click();
    await expect(page.locator('#contact-list')).toContainText('E2E 小李');
    await expect(page.locator('#contact-list')).toContainText('朋友');
  });

  test('AI 待确认记忆经确认进入联系人时间线', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 老王', relation: 'client' } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;

    const tool = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'event', content: '女儿十月办婚礼', date: '2026-10-__' } } });
    expect(tool.ok()).toBeTruthy();
    const memoryId = (await tool.json()).memory.id;

    await page.goto('/');
    const card = page.locator(`.pending-card[data-id="${memoryId}"]`);
    await expect(card).toContainText('女儿十月办婚礼');
    await expect(card).toContainText('E2E 老王');

    await card.getByRole('button', { name: '确认' }).click();
    await expect(page.locator('#toast')).toContainText('已确认进入长期记忆');
    await expect(page.locator('.pending-card[data-id="' + memoryId + '"]')).toHaveCount(0);

    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 老王' }).click();
    await expect(page.locator('#contact-detail')).toContainText('女儿十月办婚礼');
    await expect(page.locator('#contact-detail')).toContainText('事件');
  });

  test('待确认记忆可以编辑后确认，也可以驳回', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 小陈' } });
    const contactId = (await created.json()).contact.id;
    const tool = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'preference', content: '好像喜欢爬山' } } });
    const memoryId = (await tool.json()).memory.id;

    await page.goto('/');
    const card = page.locator(`.pending-card[data-id="${memoryId}"]`);
    await card.getByRole('button', { name: '编辑' }).click();
    await card.locator('[data-role="pending-edit"]').fill('确定喜欢爬山，每周都去');
    await card.getByRole('button', { name: '保存并确认' }).click();
    await expect(page.locator('#toast')).toContainText('已保存并确认');

    const tool2 = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'gift', content: '想要游戏机' } } });
    const memoryId2 = (await tool2.json()).memory.id;
    await page.locator(`.pending-card[data-id="${memoryId2}"]`).getByRole('button', { name: '驳回' }).click();
    await expect(page.locator('#toast')).toContainText('已驳回');
    await expect(page.locator('.pending-card[data-id="' + memoryId2 + '"]')).toHaveCount(0);
  });

  test('手动记一笔即确认并可在时间线编辑删除', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.getByRole('button', { name: '＋ 新建联系人' }).click();
    await page.locator('#nc-name').fill('E2E 小赵');
    await page.locator('#nc-ok').click();
    await expect(page.locator('#toast')).toContainText('联系人已创建');

    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await page.locator('#qm-contact').selectOption({ label: 'E2E 小赵' });
    await page.locator('#qm-type').selectOption('taboo');
    await page.locator('#qm-content').fill('对海鲜过敏');
    await page.locator('#qm-importance').selectOption('3');
    await page.locator('#qm-ok').click();
    await expect(page.locator('#toast')).toContainText('已记录为长期记忆');

    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 小赵' }).click();
    const row = page.locator('.memory-row', { hasText: '对海鲜过敏' });
    await expect(row).toBeVisible();
    await expect(row.locator('.badge.imp3')).toBeVisible();

    await row.getByRole('button', { name: '编辑' }).click();
    await row.locator('[data-role="memory-edit"]').fill('对虾蟹过敏，鱼类没问题');
    await row.getByRole('button', { name: '保存' }).click();
    await expect(page.locator('#toast')).toContainText('已保存');
    await expect(page.locator('.memory-row', { hasText: '对虾蟹过敏' })).toBeVisible();

    const targetRow = page.locator('.memory-row', { hasText: '对虾蟹过敏' });
    page.once('dialog', (dialog) => dialog.accept());
    await targetRow.getByRole('button', { name: '删除' }).click();
    await expect(page.locator('.memory-row', { hasText: '对虾蟹过敏' })).toHaveCount(0);
  });

  test('智能整理：粘贴素材 → AI 拆条 → 按素材批量确认', async ({ page, request }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.getByRole('button', { name: '＋ 新建联系人' }).click();
    await page.locator('#nc-name').fill('E2E 素材小李');
    await page.locator('#nc-ok').click();
    await expect(page.locator('#toast')).toContainText('联系人已创建');

    // 打开记一笔弹窗，切到「智能整理」，粘贴长文本
    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await page.locator('.mtab[data-mtab="smart"]').click();
    await expect(page.locator('#form-smart')).toBeVisible();
    await page.locator('#qmt-contact').selectOption({ label: 'E2E 素材小李' });
    await page.locator('#qmt-text').fill('今天和小李吃饭，他说女儿十月办婚礼，还在学潜水，对花生过敏。上次的茶叶他很喜欢。');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#toast')).toContainText('素材已保存');

    // 首页出现待整理素材卡
    await expect(page.locator('#material-box')).toBeVisible();
    const card = page.locator('.material-card').first();
    await expect(card).toContainText('待 AI 整理');
    await expect(card).toContainText('E2E 素材小李');

    // 模拟 AI 整理：从素材卡拿 ID，经工具批量拆条（sourceId 溯源）
    const materials = await (await request.get('/api/materials?status=raw')).json();
    const material = materials.materials.find((mt) => mt.contactName === 'E2E 素材小李');
    expect(material).toBeTruthy();
    const extract = await request.post('/api/tools', { data: { name: 'memory_batch_add', args: { entries: [
      { contactId: material.contactId, type: 'event', content: '女儿十月办婚礼', sourceId: material.id },
      { contactId: material.contactId, type: 'taboo', content: '对花生过敏', importance: 3, sourceId: material.id },
    ] } } });
    expect(extract.ok()).toBeTruthy();
    const createdIds = (await extract.json()).created.map((m) => m.id);

    // SSE 刷新后素材卡显示已拆出，一键确认这两条
    await expect(card).toContainText('已拆出 2 条');
    await card.getByRole('button', { name: '确认这 2 条' }).click();
    await expect(page.locator('#toast')).toContainText('已确认 2 条素材记忆');

    // 时间线里可见
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 素材小李' }).click();
    await expect(page.locator('#contact-detail')).toContainText('女儿十月办婚礼');
    await expect(page.locator('#contact-detail')).toContainText('对花生过敏');

    // 溯源校验：素材已处理，记忆指向素材
    const memories = await (await request.get(`/api/memories?contact_id=${material.contactId}`)).json();
    expect(memories.memories.filter((m) => createdIds.includes(m.id)).every((m) => m.sourceId === material.id)).toBe(true);
  });

  test('删除联系人级联清除记忆', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 待删除' } });
    const contactId = (await created.json()).contact.id;
    await request.post('/api/memories', { data: { contactId, type: 'event', content: '将被级联删除的记忆' } });

    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 待删除' }).click();
    await expect(page.locator('#contact-detail')).toContainText('将被级联删除的记忆');

    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.detail-actions').getByRole('button', { name: '删除' }).click();
    await expect(page.locator('#toast')).toContainText('已删除联系人');
    await expect(page.locator('.contact-row', { hasText: 'E2E 待删除' })).toHaveCount(0);
    await expect(page.locator('#contact-detail')).toBeHidden();
  });

  test('礼赠：新建计划 → 标已送自动入台账', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 礼物王老师', relation: 'other', tags: ['老师'] } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;

    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    await expect(page.getByRole('heading', { name: '礼赠' })).toBeVisible();

    await page.locator('#btn-new-plan').click();
    await page.locator('#plan-contact').selectOption(contactId);
    await page.locator('#plan-occasion').fill('teacher_day');
    await page.locator('#plan-idea').fill('钢笔礼盒（老师每天板书）');
    await page.locator('#plan-budget').fill('¥200');
    await page.locator('#plan-product-name').fill('英雄钢笔经典款');
    await page.locator('#plan-product-price').fill('¥168');
    await page.locator('#plan-product-url').fill('https://e2e.test/pen/hero');
    await page.locator('#form-plan button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('计划已保存');
    // 计划必然出现在「进行中的计划」（时机窗口随日期变化，不依赖当天日期）
    await expect(page.locator('#plans-list')).toContainText('钢笔礼盒');
    await expect(page.locator('#plans-list a[href="https://e2e.test/pen/hero"]')).toContainText('英雄钢笔经典款');

    // AI 出主意入口（计划卡）——回归：曾因 data-id 缺失点击弹「联系人不存在」
    await page.locator('[data-action="suggest-open"][data-plan]').first().click();
    await expect(page.locator('#form-suggest')).toBeVisible();
    await expect(page.locator('#suggest-target')).toContainText('E2E 礼物王老师');
    await page.locator('#form-suggest [data-role="plan-cancel"]').click();
    await expect(page.locator('#form-suggest')).toBeHidden();

    await page.locator('[data-action="plan-sent"][data-id]').first().click();
    await expect(page.locator('#toast')).toContainText('已入台账');
    await expect(page.locator('#ledger-given')).toContainText('送出礼物：英雄钢笔经典款');
    await expect(page.locator('#ledger-given')).toContainText('¥168');
  });

  test('嵌入 DSH（sandbox iframe 同 lib/client.js）删除联系人可用', async ({ page, request, baseURL }) => {
    // 回归：lib/client.js 的 iframe sandbox 若缺 allow-modals，浏览器会吞掉
    // window.confirm()（返回 false 且无弹窗），删除联系人等操作静默失效。
    // sandbox 属性实时提取自 lib/client.js，改回去这里就会红。
    const clientSrc = fs.readFileSync('lib/client.js', 'utf8');
    const sandboxAttr = /setAttribute\('sandbox',\s*'([^']+)'\)/.exec(clientSrc)?.[1];
    expect(sandboxAttr, 'lib/client.js 中应能提取到 iframe sandbox 属性').toBeTruthy();

    const created = await request.post('/api/contacts', { data: { name: 'E2E 嵌入删除' } });
    const contactId = (await created.json()).contact.id;

    await page.route(`${baseURL}/__embedded-host.html`, (route) => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><body style="margin:0">
        <iframe src="/" sandbox="${sandboxAttr}" style="width:100vw;height:100vh;border:0"></iframe>
      </body></html>`,
    }));
    let dialogSeen = false;
    page.on('dialog', (dialog) => { dialogSeen = true; dialog.accept().catch(() => {}); });

    await page.goto(`${baseURL}/__embedded-host.html`);
    const frame = page.frames().find((f) => f.url() === `${baseURL}/`);
    expect(frame).toBeTruthy();
    await frame.locator('.nav-item[data-view="contacts"]').click();
    await frame.locator('.contact-row', { hasText: 'E2E 嵌入删除' }).click();
    await frame.locator('.detail-actions').getByRole('button', { name: '删除' }).click();
    await expect(frame.locator('#toast')).toContainText('已删除联系人');

    expect(dialogSeen, '确认弹窗应真实出现（sandbox 缺 allow-modals 时会被静默吞掉）').toBe(true);
    const contacts = await (await request.get('/api/contacts')).json();
    expect(contacts.contacts.some((c) => c.id === contactId)).toBe(false);
  });
});
