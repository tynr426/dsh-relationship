import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// 独立模式作答走 navigator.clipboard.writeText，需授权（Chromium 默认拒绝）
test.use({ permissions: ['clipboard-write'] });

test.describe('关系记忆工作台', () => {
  test('首页可访问并显示核心区块', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '重要的人和事，不再忘记' })).toBeVisible();
    // 空库：待确认队列折叠（状态并入头部副标），最近记住了不占位
    await expect(page.locator('#pending-panel')).toBeHidden();
    await expect(page.locator('#recent-box')).toBeHidden();
    await expect(page.locator('#home-sub')).not.toContainText('待确认');
    await expect(page.locator('.howto-panel')).not.toHaveAttribute('open', '');
    await expect(page.locator('.nav-item svg').first()).toHaveCSS('width', '20px');
    await expect(page.locator('.privacy-note svg')).toHaveCSS('width', '18px');
    await expect(page.locator('#topbar .primary-btn')).toHaveCount(1);
    await expect(page.locator('#btn-quick-memory')).toHaveClass('primary-btn');
    await expect(page.locator('#btn-quick-plan')).toHaveClass('ghost-btn');
    await expect(page.locator('#view-home .primary-btn')).toHaveCount(0);
    await expect(page.locator('#view-home .home-priority')).toHaveCount(0);
  });

  test('空库首价值：一句原话 → 保存素材 → 核对确认 → 下次联系有依据', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('#attention-list')).toBeEmpty();
    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await expect(page.locator('#form-contact')).toBeHidden();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#modal-backdrop [role="tablist"]')).toHaveCount(0);
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.getByRole('dialog', { name: '手动录入', exact: true })).toBeVisible();
    await expect(page.locator('#qm-contact-hint')).toBeVisible();
    await expect(page.locator('#qm-ok')).toBeDisabled();
    await page.getByRole('button', { name: '返回原话输入' }).click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '记住一件事', exact: true }).click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('.capture-options')).not.toHaveAttribute('open', '');
    await expect(page.locator('#capture-mode')).toContainText('粘贴到 DSH 会话才会开始整理');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#form-smart')).toBeVisible();
    expect((await (await request.get('/api/materials')).json()).materials).toHaveLength(0);
    await page.locator('#qmt-text').fill('E2E 初次小李说对花生过敏');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/materials') && r.request().method() === 'POST');
    await page.locator('#qmt-ok').click();
    const material = (await (await saved).json()).material;
    await expect(page.locator('#toast')).toContainText('整理指令已复制');
    const materialCard = page.locator(`.material-card[data-id="${material.id}"]`);
    await expect(materialCard).toBeVisible();
    await expect(materialCard).toContainText('待 AI 整理');
    await expect(page.locator('#recent-box')).toBeHidden();
    expect((await (await request.get('/api/contacts')).json()).contacts).toHaveLength(0);
    await page.reload();
    await expect(page.locator('#onboarding')).toBeHidden();
    await expect(page.locator('#home-sub')).toContainText('素材待整理');

    const tool = async (name, args) => {
      const response = await request.post('/api/tools', { data: { name, args } });
      expect(response.ok()).toBeTruthy();
      const result = await response.json();
      expect(result.ok).toBe(true);
      return result;
    };
    const { contact } = await tool('contact_add', { name: 'E2E 初次小李' });
    const { memory } = await tool('memory_add', { contactId: contact.id, type: 'taboo', content: '对花生过敏', importance: 3, sourceId: material.id, sourceQuote: '对花生过敏' });
    await tool('material_report', { id: material.id, report: '拆出 1 条：对花生过敏。请核对原话后确认。' });
    const memoryCard = page.locator(`.pending-card[data-id="${memory.id}"]`);
    await expect(memoryCard).toContainText('原话：对花生过敏');
    await expect(page.locator('#view-home .home-priority')).toHaveCount(1);
    await expect(page.locator('#pending-panel')).toHaveClass(/home-priority/);
    await expect(page.locator('#recent-box')).toBeHidden();
    await page.locator(`.contact-pending[data-id="${contact.id}"]`).getByRole('button', { name: '确认收录' }).click();
    await memoryCard.getByRole('button', { name: '确认', exact: true }).click();
    await expect(page.locator('#recent-list')).toContainText('对花生过敏');
    await page.locator('.recent-row', { hasText: '对花生过敏' }).click();
    const briefing = page.waitForResponse((r) => r.url().endsWith('/api/briefing') && r.request().method() === 'POST');
    await page.locator('#contact-detail [data-action="briefing-open"]').click();
    expect((await (await briefing).json()).prompt).toContain('对花生过敏');
    await expect(page.locator('#toast')).toContainText('指令已复制');
    expect(errors).toEqual([]);
  });

  test('下一步建议：补充一件事后获取有依据的建议指令', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: '想想下一步', exact: true }).click();
    await expect(page.locator('#form-first')).toBeVisible();
    await expect(page.locator('#form-first')).toContainText('关键信息不足时才追问');
    await page.locator('#fr-name').fill('E2E 张老师');
    await page.locator('#fr-note').fill('想问问近况，两年没联系');
    await page.locator('#fr-go').click();
    await expect(page.locator('#toast')).toContainText('建议指令已复制');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await expect(page.locator('#contact-list')).toContainText('E2E 张老师');
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

  test('AI 新建联系人进待确认队列：拍板收录 / 拒绝级联删除', async ({ page, request }) => {
    // AI 通道（DSH 会话工具）新建联系人 → 待确认，不进用户可见列表
    const tool = await request.post('/api/tools', { data: { name: 'contact_add', args: { name: 'E2E 熊猫', relation: 'friend' } } });
    expect(tool.ok()).toBeTruthy();
    const added = await tool.json();
    const contactId = added.contact.id;
    expect(added.contact.status).toBe('pending');
    const contactsBefore = (await (await request.get('/api/contacts')).json()).contacts;
    expect(contactsBefore.some((c) => c.id === contactId)).toBe(false);

    // AI 不等收录，直接给待确认联系人挂待确认记忆
    const mem = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'attribute', content: '经营 GPT 中转站' } } });
    expect(mem.ok()).toBeTruthy();
    const memoryId = (await mem.json()).memory.id;

    await page.goto('/');
    // 侧栏徽标 = 待确认记忆 + 待确认联系人 合计
    await expect(page.locator('#nav-pending-count')).toHaveText('2');
    // 待确认联系人卡置顶队列，带 AI 新建标识
    const contactCard = page.locator(`.pending-card.contact-pending[data-id="${contactId}"]`);
    await expect(contactCard).toBeVisible();
    await expect(contactCard).toContainText('E2E 熊猫');
    await expect(contactCard).toContainText('朋友');
    await expect(contactCard).toContainText('AI 新建联系人');
    // 挂在待确认联系人名下的记忆卡也要显示人名，不能是「未知联系人」
    const memCard = page.locator(`.pending-card[data-id="${memoryId}"]`);
    await expect(memCard).toContainText('经营 GPT 中转站');
    await expect(memCard).toContainText('E2E 熊猫');

    // 收录前，联系人页看不到 TA
    await page.locator('.nav-item[data-view="contacts"]').click();
    await expect(page.locator('.contact-row', { hasText: 'E2E 熊猫' })).toHaveCount(0);

    // 拍板收录 → 进列表；其待确认记忆仍在队列等单独拍板
    await page.locator('.nav-item[data-view="home"]').click();
    await contactCard.getByRole('button', { name: '确认收录' }).click();
    await expect(page.locator('#toast')).toContainText('已收录该联系人');
    await expect(page.locator(`.pending-card.contact-pending[data-id="${contactId}"]`)).toHaveCount(0);
    await expect(memCard).toBeVisible();

    // 确认记忆 → 时间线可见完整链路
    await memCard.getByRole('button', { name: '确认' }).click();
    await expect(page.locator('#toast')).toContainText('已确认进入长期记忆');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 熊猫' }).click();
    await expect(page.locator('#contact-detail')).toContainText('经营 GPT 中转站');

    // 拒绝路径：AI 又建了一位 → 不要 → 页内危险确认 → 连带记忆级联删除
    const tool2 = await request.post('/api/tools', { data: { name: 'contact_add', args: { name: 'E2E 熊猫朋友', relation: 'friend' } } });
    const contactId2 = (await tool2.json()).contact.id;
    await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId: contactId2, type: 'attribute', content: '会被连带删除' } } });
    await page.goto('/');
    const rejectCard = page.locator(`.pending-card.contact-pending[data-id="${contactId2}"]`);
    await rejectCard.getByRole('button', { name: '不要' }).click();
    await expect(page.locator('#rel-dialog')).toBeVisible();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('已删除（连带 1 条记忆）');
    await expect(page.locator(`.pending-card.contact-pending[data-id="${contactId2}"]`)).toHaveCount(0);
    await expect(page.locator(`.pending-card[data-id]`, { hasText: '会被连带删除' })).toHaveCount(0);
    const contactsAfter = (await (await request.get('/api/contacts')).json()).contacts;
    expect(contactsAfter.some((c) => c.id === contactId2)).toBe(false);
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

    const tool2 = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'gift', content: '想要游戏机', direction: 'contact_to_user' } } });
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
    const created = page.waitForResponse((r) => r.url().endsWith('/api/contacts') && r.request().method() === 'POST');
    await page.locator('#nc-ok').click();
    const contactId = (await (await created).json()).contact.id;
    await expect(page.locator('#toast')).toContainText('联系人已创建');

    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.locator('#qm-content')).toBeFocused();
    await expect(page.locator('#form-quick-memory')).toContainText('不经过 AI，保存后直接进入长期记忆');
    await page.locator('#qm-contact').selectOption(contactId);
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

    const search = page.locator('#memory-search-input');
    await search.fill('虾蟹');
    await expect(page.locator('.memory-search')).toContainText('找到 1 条');
    await expect(page.locator('.memory-row', { hasText: '对虾蟹过敏' })).toBeVisible();
    await search.fill('咖啡');
    await expect(page.locator('.timeline .empty')).toContainText('没有检索到相关记忆');
    await search.fill('');
    await expect(page.locator('.memory-row', { hasText: '对虾蟹过敏' })).toBeVisible();

    const targetRow = page.locator('.memory-row', { hasText: '对虾蟹过敏' });
    await targetRow.getByRole('button', { name: '删除' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('.memory-row', { hasText: '对虾蟹过敏' })).toHaveCount(0);
  });

  test('记一笔默认输入原话，手动录入往返保留两份草稿且不提前写入', async ({ page, request }) => {
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 统一录入' } })).json()).contact;
    const before = (await (await request.get('/api/materials')).json()).materials.length;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.locator('#btn-quick-memory').click();
    await expect(page.getByRole('dialog', { name: '记一笔', exact: true })).toBeVisible();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#form-quick-memory')).toBeHidden();
    await expect(page.locator('#modal-backdrop [role="tablist"]')).toHaveCount(0);
    await page.locator('#qmt-text').fill('E2E 统一录入说喜欢清淡口味');
    await page.locator('.capture-options > summary').click();
    await page.locator('#qmt-contact').selectOption(contact.id);
    await page.locator('#qmt-occasion').fill('日常');
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.getByRole('dialog', { name: '手动录入', exact: true })).toBeVisible();
    await expect(page.locator('#qm-content')).toBeFocused();
    await expect(page.locator('#form-smart')).toBeHidden();
    await expect(page.locator('#qm-contact-hint')).toBeHidden();
    await expect(page.locator('#qm-content')).toHaveValue('');
    await page.locator('#qm-contact').selectOption(contact.id);
    await page.locator('#qm-type').selectOption('preference');
    await page.locator('#qm-content').fill('另一份手工草稿，不应随素材提交');
    await page.locator('#qm-importance').selectOption('3');
    await page.getByRole('button', { name: '返回原话输入' }).click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#qmt-text')).toHaveValue('E2E 统一录入说喜欢清淡口味');
    await expect(page.locator('#qmt-contact')).toHaveValues([contact.id]);
    await expect(page.locator('#qmt-occasion')).toHaveValue('日常');
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.locator('#qm-contact')).toHaveValue(contact.id);
    await expect(page.locator('#qm-type')).toHaveValue('preference');
    await expect(page.locator('#qm-content')).toHaveValue('另一份手工草稿，不应随素材提交');
    await expect(page.locator('#qm-importance')).toHaveValue('3');
    await page.getByRole('button', { name: '返回原话输入' }).click();
    expect((await (await request.get('/api/materials')).json()).materials).toHaveLength(before);
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories).toEqual([]);
    expect(await page.locator('#form-smart').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/materials') && r.request().method() === 'POST');
    await page.locator('#qmt-ok').click();
    const material = (await (await saved).json()).material;
    await expect(page.locator('#toast')).toContainText('素材已保存');
    const listed = (await (await request.get('/api/materials')).json()).materials.find((item) => item.id === material.id);
    expect(listed.contactIds).toEqual([contact.id]);
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories).toEqual([]);
    await expect(page.locator(`.material-card[data-id="${material.id}"]`)).toContainText('待 AI 整理');
    await page.locator('#btn-quick-memory').click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#qmt-text')).toHaveValue('');
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('#btn-quick-memory')).toBeFocused();
    await page.locator('#btn-quick-memory').click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('记一笔先于联系人加载打开时补齐选项，刷新不清除草稿和归属', async ({ page, request }) => {
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 延迟归属' } })).json()).contact;
    let releaseContacts;
    const release = new Promise((resolve) => { releaseContacts = resolve; });
    await page.route('**/api/contacts', async (route) => {
      const response = await route.fetch();
      await release;
      await route.fulfill({ response });
    }, { times: 1 });
    try {
      await page.goto('/');
      await page.locator('#btn-quick-memory').click();
      await page.locator('#qmt-text').fill('联系人还没加载也能先输入原话');
      await expect(page.locator('#qmt-contact option')).toHaveCount(0);
      await page.locator('#qmt-manual').click();
      await page.locator('#qm-content').fill('延迟加载时的手工草稿');
      await expect(page.locator('#qm-ok')).toBeDisabled();
      releaseContacts();
      await expect(page.locator(`#qm-contact option[value="${contact.id}"]`)).toBeAttached();
      await expect(page.locator('#qm-ok')).toBeEnabled();
      await expect(page.locator('#qm-contact-hint')).toBeHidden();
      await expect(page.locator('#qm-content')).toHaveValue('延迟加载时的手工草稿');
      await page.locator('#qm-contact').selectOption(contact.id);
      await page.locator('#qm-back').click();
      await expect(page.locator('#qmt-text')).toHaveValue('联系人还没加载也能先输入原话');
      await page.locator('.capture-options > summary').click();
      await page.locator('#qmt-contact').selectOption(contact.id);
      await page.locator('#qmt-occasion').fill('归属保留验证');
      const renamed = await request.patch(`/api/contacts/${contact.id}`, { data: { name: 'E2E 延迟归属改名' } });
      expect(renamed.ok()).toBeTruthy();
      await expect(page.locator(`#qmt-contact option[value="${contact.id}"]`)).toHaveText('E2E 延迟归属改名');
      await expect(page.locator('#qmt-contact')).toHaveValues([contact.id]);
      await expect(page.locator('#qmt-text')).toHaveValue('联系人还没加载也能先输入原话');
      await expect(page.locator('#qmt-occasion')).toHaveValue('归属保留验证');
      await page.locator('#qmt-manual').click();
      await expect(page.locator('#qm-contact')).toHaveValue(contact.id);
      await expect(page.locator('#qm-content')).toHaveValue('延迟加载时的手工草稿');
      expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories).toEqual([]);
    } finally { releaseContacts(); }
  });

  test('智能整理：粘贴素材 → AI 拆条 → 按素材批量确认', async ({ page, request }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.getByRole('button', { name: '＋ 新建联系人' }).click();
    await page.locator('#nc-name').fill('E2E 素材小李');
    await page.locator('#nc-ok').click();
    await expect(page.locator('#toast')).toContainText('联系人已创建');

    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await expect(page.locator('#form-smart')).toBeVisible();
    await page.locator('.capture-options > summary').click();
    await page.locator('#qmt-contact').selectOption({ label: 'E2E 素材小李' });
    await page.locator('#qmt-text').fill('2026-09-11 20:30 今天和小李吃饭，他说女儿十月办婚礼，还在学潜水，对花生过敏。上次的茶叶他很喜欢。');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#toast')).toContainText('素材已保存');

    await expect(page.locator('#material-box')).toBeVisible();
    await expect(page.locator('.materials-more')).toHaveAttribute('open', '');
    const card = page.locator('.material-card', { hasText: 'E2E 素材小李' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('待 AI 整理');
    await expect(page.locator('#home-sub')).toContainText('素材待整理');

    // 模拟 AI 整理：从素材卡拿 ID，经工具批量拆条（sourceId 溯源 + sourceQuote 原话摘录过闸门）
    const materials = await (await request.get('/api/materials?status=raw')).json();
    const material = materials.materials.find((mt) => mt.contactName === 'E2E 素材小李');
    expect(material).toBeTruthy();
    const extract = await request.post('/api/tools', { data: { name: 'memory_batch_add', args: { entries: [
      { contactId: material.contactId, type: 'event', content: '女儿十月办婚礼', sourceId: material.id, sourceQuote: '他说女儿十月办婚礼', saidAt: '2026-09-11 20:30' },
      { contactId: material.contactId, type: 'taboo', content: '对花生过敏', importance: 3, sourceId: material.id, sourceQuote: '对花生过敏', saidAt: '2026-09-11 20:30' },
    ] } } });
    expect(extract.ok()).toBeTruthy();
    const createdIds = (await extract.json()).created.map((m) => m.id);

    // 整理未完成态：已拆出条目但无报告——徽标提示 + 保留「继续整理」入口（不被 processed 锁死）
    await expect(card).toContainText('已拆出 2 条');
    await expect(card).toContainText('整理未完成');
    await expect(card.getByRole('button', { name: '复制继续整理指令' })).toBeVisible();

    // 反问生命周期：AI 登记 → 横幅出现；独立模式作答=复制（不算送达，横幅保留）→ 手动放弃清除
    const asked = await request.post('/api/tools', { data: { name: 'organize_question', args: { materialId: material.id, question: '还有一条模糊提及的茶叶，要不要单独登记？', options: [
      { label: '照常登记', command: `素材 ${material.id} 照常登记茶叶记忆` },
      { label: '跳过', command: `素材 ${material.id} 跳过茶叶` },
    ] } } });
    expect(asked.ok()).toBeTruthy();
    const banner = card.locator('.material-question');
    await expect(banner).toContainText('再告诉我一点');
    await banner.locator('.mq-btn').first().click();
    await expect(page.locator('#toast')).toContainText('作答指令已复制');
    await expect(banner).toContainText('已复制', '复制不算送达，横幅保留并提示粘贴去处');
    await expect(banner).toContainText('等你回答', '状态仍为待答');
    await banner.getByRole('button', { name: '不再等待' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('已清除');
    await expect(banner).toHaveCount(0);

    // AI 整理完提交整理报告：对话里的汇报经 material_report 落进工作台素材卡
    const reported = await request.post('/api/tools', { data: { name: 'material_report', args: { id: material.id, report: '拆出 2 条：女儿十月办婚礼、对花生过敏；已被既有记忆覆盖 0 条；无冲突。' } } });
    expect(reported.ok()).toBeTruthy();

    // 会话开始提醒工具（pending_summary）能看到这两条待确认
    const summary = await (await request.post('/api/tools', { data: { name: 'pending_summary', args: {} } })).json();
    expect(summary.ok).toBe(true);
    expect(summary.items.some((m) => m.id === createdIds[0])).toBe(true);

    // SSE 刷新后素材卡显示已拆出 + AI 整理报告；整理完成，未完成态与继续整理入口消失
    await expect(card).toContainText('已拆出 2 条');
    await expect(card.locator('.material-report')).toContainText('拆出 2 条');
    await expect(card).not.toContainText('整理未完成');
    await expect(card.getByRole('button', { name: '复制继续整理指令' })).toHaveCount(0);
    // 待确认卡展示原话摘录（提取闸门溯源）
    await expect(page.locator(`.pending-card[data-id="${createdIds[0]}"]`)).toContainText('原话：他说女儿十月办婚礼');
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

  test('智能整理多人素材：多选两人保存，素材卡显示双名', async ({ page, request }) => {
    const a = (await (await request.post('/api/contacts', { data: { name: 'E2E 多人甲' } })).json()).contact;
    const b = (await (await request.post('/api/contacts', { data: { name: 'E2E 多人乙' } })).json()).contact;

    await page.goto('/');
    await page.getByRole('button', { name: '＋ 记一笔' }).click();
    await expect(page.locator('#form-smart')).toBeVisible();
    await page.locator('.capture-options > summary').click();
    await page.locator('#qmt-contact').selectOption([a.id, b.id]);
    await page.locator('#qmt-text').fill('中秋送礼记录：给甲送了武夷岩茶，给乙送了稻香村月饼。');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#toast')).toContainText('素材已保存');

    const card = page.locator('.material-card', { hasText: '中秋送礼记录' }).first();
    await expect(card).toContainText('E2E 多人甲、E2E 多人乙');
    const list = await (await request.get('/api/materials?status=raw')).json();
    const mt = list.materials.find((x) => x.excerpt.includes('中秋送礼记录'));
    expect(mt.contactIds).toEqual([a.id, b.id]);
  });

  test('删除联系人级联清除记忆', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 待删除' } });
    const contactId = (await created.json()).contact.id;
    await request.post('/api/memories', { data: { contactId, type: 'event', content: '将被级联删除的记忆' } });

    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 待删除' }).click();
    await expect(page.locator('#contact-detail')).toContainText('将被级联删除的记忆');

    await page.locator('.detail-actions').getByRole('button', { name: '删除' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('已删除联系人');
    await expect(page.locator('.contact-row', { hasText: 'E2E 待删除' })).toHaveCount(0);
    await expect(page.locator('#contact-detail')).toBeHidden();
  });

  test('编辑联系人：改名改标签生日 → 详情与列表同步，弹窗标题正确复位', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 编辑前', relation: 'friend' } });
    const contactId = (await created.json()).contact.id;

    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 编辑前' }).click();
    await expect(page.locator('#contact-detail')).toBeVisible();

    await page.locator('.detail-actions').getByRole('button', { name: '编辑' }).click();
    await expect(page.locator('#nc-title-text')).toHaveText('编辑联系人');
    await expect(page.locator('#nc-name')).toHaveValue('E2E 编辑前');

    await page.locator('#nc-name').fill('E2E 编辑后');
    await page.locator('#nc-tags').fill('球友 周末局');
    await page.locator('#nc-birthday').fill('每年-05-20');
    await page.locator('#nc-ok').click();

    await expect(page.locator('#toast')).toContainText('联系人已更新');
    await expect(page.locator('#contact-detail')).toContainText('E2E 编辑后');
    await expect(page.locator('#contact-detail')).toContainText('球友');
    await expect(page.locator('#contact-detail')).toContainText('每年 05-20');
    await expect(page.locator('.contact-row', { hasText: 'E2E 编辑后' })).toBeVisible();

    // 编辑态不得泄漏：关窗后再开「新建联系人」标题应复位
    await page.locator('#btn-new-contact').click();
    await expect(page.locator('#nc-title-text')).toHaveText('新建联系人');
    await page.locator('#nc-cancel').click();

    const fetched = await request.get(`/api/contacts/${contactId}`);
    expect((await fetched.json()).contact.name).toBe('E2E 编辑后');
  });

  test('记个想法/回礼计划：从某人的行打开时「送给谁」自动选中该人', async ({ page, request }) => {
    // 甲先建（列表第一人），乙带回礼记录——若取值回落到列表第一人会错选甲，防假阳性
    await request.post('/api/contacts', { data: { name: 'E2E 默认甲', relation: 'friend' } });
    const b = (await (await request.post('/api/contacts', { data: { name: 'E2E 回礼乙', relation: 'friend' } })).json()).contact;
    await request.post('/api/memories', { data: { contactId: b.id, type: 'gift', content: '老白茶一盒', direction: 'contact_to_user', date: '2026-09-10' } });

    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    const row = page.locator('.occ-card.reciprocity', { hasText: 'E2E 回礼乙' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '记回礼计划' }).click();

    const selected = await page.locator('#plan-contact').inputValue();
    expect(selected).toBe(b.id);
    await expect(page.locator('#plan-contact')).toContainText('E2E 回礼乙');
    await expect(page.locator('#plan-occasion')).toHaveValue('thank_you');
  });

  test('零记忆联系人也放行「送什么」：不再禁用，标签进空态提示', async ({ page, request }) => {
    const c = (await (await request.post('/api/contacts', { data: { name: 'E2E 零记忆丁', relation: 'client', tags: ['律师'] } })).json()).contact;
    await request.post('/api/plans', { data: { contactId: c.id, occasion: '中秋', idea: '先记个想法' } });

    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    const card = page.locator('.occ-card', { hasText: 'E2E 零记忆丁' })
      .filter({ has: page.getByRole('button', { name: '已完成', exact: true }) });
    await expect(card).toBeVisible();
    await card.locator('.gift-tools > summary').click();
    await card.getByRole('button', { name: '送什么' }).click();

    await expect(page.locator('#suggest-list')).toContainText('律师');
    await expect(page.locator('#suggest-list')).toContainText('通用稳妥建议');
    await expect(page.locator('#suggest-ok')).toBeEnabled();
  });

  test('礼赠：新建计划 → 标已送自动入台账', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 礼物王老师', relation: 'other', tags: ['老师'] } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;

    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    await expect(page.getByRole('heading', { name: '计划与礼赠' })).toBeVisible();

    // 小视口回归：DSH 内嵌 iframe 高度有限，礼物计划表单字段多，
    // 弹窗必须能滚动且「保存计划」按钮始终可达（曾因无 max-height 被裁出视口）
    await page.setViewportSize({ width: 420, height: 520 });
    await page.locator('#btn-new-plan').click();
    await expect(page.locator('#form-plan')).toBeVisible();
    await expect(page.locator('#form-plan button[type="submit"]')).toBeVisible();
    await page.locator('#form-plan [data-role="plan-cancel"]').click();
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.locator('#btn-new-plan').click();
    await page.locator('#plan-contact').selectOption(contactId);
    await page.locator('#plan-idea').fill('钢笔礼盒（老师每天板书）');
    await page.locator('#plan-details > summary').click();
    await page.locator('#plan-occasion').fill('teacher_day');
    await page.locator('#plan-budget').fill('¥200');
    await page.locator('#plan-product-details > summary').click();
    await page.locator('#plan-product-name').fill('英雄钢笔经典款');
    await page.locator('#plan-product-price').fill('¥168');
    await page.locator('#plan-product-url').fill('https://e2e.test/pen/hero');
    await page.locator('#form-plan button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('计划已保存');
    // 计划必然出现在「进行中的计划」（时机窗口随日期变化，不依赖当天日期）
    await expect(page.locator('#plans-list')).toContainText('钢笔礼盒');
    await expect(page.locator('#plans-list a[href="https://e2e.test/pen/hero"]')).toContainText('英雄钢笔经典款');

    // 围绕已有计划出主意：AI 建议卡带 basedOnPlanId 关联；原计划卡可一键删除这批建议
    const plansNow = (await (await request.get('/api/plans')).json()).plans;
    const basePlanId = plansNow.find((p) => p.idea.includes('钢笔礼盒')).id;
    for (const idea of ['手写祝福贺卡', '定制粉笔收纳盒']) {
      const sug = await request.post('/api/tools', { data: { name: 'gift_plan_add', args: { contactId, idea, occasion: 'teacher_day', basedOnPlanId: basePlanId } } });
      expect(sug.ok()).toBeTruthy();
    }
    await expect(page.locator('#plans-list')).toContainText('围绕「钢笔礼盒');
    const delBatch = page.locator(`[data-action="plan-delete-suggestions"][data-id="${basePlanId}"]`);
    await expect(delBatch).toContainText('删这批建议(2)');
    await delBatch.click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('已删除 2 条 AI 建议');
    await expect(page.locator('#plans-list')).not.toContainText('手写祝福贺卡');
    await expect(page.locator('#plans-list')).toContainText('钢笔礼盒');

    // AI 出主意入口（计划卡）——回归：曾因 data-id 缺失点击弹「联系人不存在」
    await page.locator(`#plans-list .occ-card[data-plan="${basePlanId}"] .gift-tools > summary`).click();
    await page.locator(`#plans-list [data-action="suggest-open"][data-plan="${basePlanId}"]`).click();
    await expect(page.locator('#form-suggest')).toBeVisible();
    await expect(page.locator('#suggest-target')).toContainText('E2E 礼物王老师');
    await page.locator('#form-suggest [data-role="plan-cancel"]').click();
    await expect(page.locator('#form-suggest')).toBeHidden();

    await page.locator(`[data-action="plan-sent"][data-id="${basePlanId}"]`).click();
    await expect(page.locator('#rel-dialog')).toContainText('创建已确认的送礼记忆');
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('已入台账');
    await expect(page.locator('#ledger-given')).toContainText('送出礼物：英雄钢笔经典款');
    await expect(page.locator('#ledger-given')).toContainText('¥168');
  });

  test('嵌入 DSH（sandbox iframe 同 lib/client.js）删除联系人可用', async ({ page, request, baseURL }) => {
    // 回归：删除确认走页面内 confirmDialog（#rel-dialog），不依赖 iframe 的
    // allow-modals——Electron 沙箱 iframe 里原生 confirm() 返回值经常拿不回来，
    // 会让删除静默失效。sandbox 属性实时提取自 lib/client.js，删除流程必须
    // 在同样的沙箱里走通。
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

    await page.goto(`${baseURL}/__embedded-host.html`);
    const frame = page.frames().find((f) => f.url() === `${baseURL}/`);
    expect(frame).toBeTruthy();
    await frame.locator('.nav-item[data-view="contacts"]').click();
    await frame.locator('.contact-row', { hasText: 'E2E 嵌入删除' }).click();
    await frame.locator('.detail-actions').getByRole('button', { name: '删除' }).click();
    // 页面内确认弹窗必须真实出现并可点击（这才是沙箱里的可靠确认方式）
    await expect(frame.locator('#rel-dialog')).toBeVisible();
    await frame.locator('#rel-dialog-ok').click();
    await expect(frame.locator('#toast')).toContainText('已删除联系人');

    const contacts = await (await request.get('/api/contacts')).json();
    expect(contacts.contacts.some((c) => c.id === contactId)).toBe(false);
  });

  test('取代：pending 卡「被取代」后退出队列，confirmed 记忆被取代后退出时间线', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 取代' } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;

    // keep：REST 手动录入即 confirmed（旧事实）
    const keepRes = await request.post('/api/memories', { data: { contactId, type: 'attribute', content: '在杭州工作' } });
    expect(keepRes.ok()).toBeTruthy();
    const keepId = (await keepRes.json()).memory.id;

    // pending 卡：AI 重复登记的近似事实，走界面上的「被取代」
    const tool = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId, type: 'attribute', content: '好像在杭州上班' } } });
    expect(tool.ok()).toBeTruthy();
    const pendingId = (await tool.json()).memory.id;

    await page.goto('/');
    const card = page.locator(`.pending-card[data-id="${pendingId}"]`);
    await expect(card).toContainText('好像在杭州上班');
    await card.getByRole('button', { name: '被取代' }).click();
    const supersedeItem = page.locator('.supersede-item', { hasText: '在杭州工作' });
    await expect(supersedeItem).toBeVisible();
    await supersedeItem.click();
    await expect(page.locator('#toast')).toContainText('已标记被取代');
    // 点完即从待确认队列消失（toast 与队列行为一致）
    await expect(page.locator(`.pending-card[data-id="${pendingId}"]`)).toHaveCount(0);

    // 主方向：旧确认记忆被新事实修正（API 取代）→ 退出时间线，新事实可见
    const newer = await request.post('/api/memories', { data: { contactId, type: 'attribute', content: '已搬到上海工作' } });
    const newerId = (await newer.json()).memory.id;
    const sup = await request.post('/api/memories/supersede', { data: { id: keepId, keepId: newerId } });
    expect(sup.ok()).toBeTruthy();

    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 取代' }).click();
    await expect(page.locator('#contact-detail')).toContainText('已搬到上海工作');
    await expect(page.locator('.memory-row', { hasText: '在杭州工作' })).toHaveCount(0);

    // 服务端校验：跨联系人取代一律 400
    const other = await request.post('/api/contacts', { data: { name: 'E2E 取代别家' } });
    const otherId = (await other.json()).contact.id;
    const foreign = await request.post('/api/memories', { data: { contactId: otherId, type: 'attribute', content: '别家的事实' } });
    const foreignId = (await foreign.json()).memory.id;
    const bad = await request.post('/api/memories/supersede', { data: { id: foreignId, keepId: newerId } });
    expect(bad.status()).toBe(400);
  });

  test('首页按时机分组：全量展开、计划隔离、精确继续、键盘与窄屏', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const post = async (path, data) => {
      const res = await request.post(path, { data });
      expect(res.ok()).toBeTruthy();
      return res.json();
    };
    const date = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const contacts = [];
    for (let i = 0; i < 6; i++) contacts.push((await post('/api/contacts', { name: `E2E 分组${i}`, birthday: date(2).slice(5) })).contact);
    const contactId = contacts[5].id;
    const birthday = (await post('/api/plans', { contactId, idea: '生日亲手做蛋糕', occasion: '生日', occasionDate: date(2), status: 'decided' })).plan;
    await post('/api/plans', { contactId, idea: '拜访时带一本书', occasion: '拜访', occasionDate: date(2) });
    await post('/api/plans', { contactId, idea: '第二次拜访喝茶', occasion: 'visit', occasionDate: date(3) });
    await post('/api/plans', { contactId, idea: '还没定日子的散步', occasion: '散步' });
    await post('/api/tools', { name: 'gift_plan_add', args: { contactId, idea: 'AI 建议低糖蛋糕', basedOnPlanId: birthday.id } });
    await post('/api/tools', { name: 'gift_plan_add', args: { contactId: contacts[4].id, idea: 'AI 独立生日花束', occasion: 'birthday', occasionDate: date(2) } });
    await post('/api/memories', { contactId, type: 'taboo', content: '对花生过敏，连少量花生油也不可以' });
    await page.goto('/');
    const group = page.locator(`.occasion-group[data-group="birthday|${date(2)}"]`);
    const card = group.locator(`.attention-card[data-id="${contactId}"]`);
    await expect(group).toHaveCount(1);
    await expect(group.locator('time')).toHaveAttribute('datetime', date(2));
    await expect(group.locator('.occasion-group-head')).toContainText('6 人 · 2 人已有安排或主意');
    await expect(group.locator(':scope > .occasion-people > .attention-card').first()).toHaveAttribute('data-id', contactId);
    await expect(card).toContainText('生日亲手做蛋糕');
    await expect(card).toContainText('AI 建议低糖蛋糕');
    await expect(card).not.toContainText('拜访时带一本书');
    await expect(card.locator('.caution')).toHaveText('相处注意：对花生过敏，连少量花生油也不可以');
    await expect(group.locator('.people-more .attention-card').first()).toBeHidden();
    await group.locator('.people-more > summary').focus();
    await page.keyboard.press('Enter');
    await expect(group.locator('.people-more .attention-card').first()).toBeVisible();
    await expect(page.locator('#view-home')).toHaveClass(/active/);
    await card.getByRole('button', { name: '继续计划', exact: true }).click();
    await expect(page.locator('#plan-contact')).toHaveValue(contactId);
    await expect(page.locator('#plan-date')).toHaveValue(date(2));
    await expect(page.locator('#plan-idea')).toHaveValue('生日亲手做蛋糕');
    await page.locator('#plan-idea').fill('生日亲手做低糖蛋糕');
    await page.locator('#form-plan button[type="submit"]').click();
    await expect(card).toContainText('生日亲手做低糖蛋糕');
    expect((await (await request.get('/api/plans')).json()).plans.find((p) => p.id === birthday.id).contactId).toBe(contactId);
    await expect(group.locator('.people-more')).toHaveAttribute('open', '');
    await card.locator('.att-details > summary').click();
    const giftRequest = page.waitForRequest((r) => r.url().endsWith('/api/gift-suggest') && r.method() === 'POST');
    await card.locator(`[data-action="suggest-open"][data-plan="${birthday.id}"]`).click();
    await page.locator('#suggest-ok').click();
    expect((await giftRequest).postDataJSON()).toMatchObject({ contactId, planId: birthday.id, occasion: 'birthday', occasionDate: date(2) });
    await expect(page.locator('#toast')).toContainText('已复制');
    const ideasCard = group.locator(`.attention-card[data-id="${contacts[4].id}"]`);
    const plansBefore = (await (await request.get('/api/plans')).json()).plans.length;
    await ideasCard.getByRole('button', { name: '查看AI主意' }).click();
    await expect(ideasCard.locator('.att-details')).toHaveAttribute('open', '');
    expect((await (await request.get('/api/plans')).json()).plans.length).toBe(plansBefore);
    const greeting = group.locator('[data-action="attention-ai"]').first();
    const greetingId = await greeting.getAttribute('data-id');
    const greetingRequest = page.waitForRequest((r) => r.url().endsWith('/api/briefing') && r.method() === 'POST');
    await greeting.click();
    expect((await greetingRequest).postDataJSON()).toMatchObject({ contactId: greetingId, occasion: 'birthday' });
    await expect(page.locator('#toast')).toContainText('已复制');
    await group.locator(`.attention-card[data-id="${greetingId}"] [data-action="plan-open"]`).click();
    await expect(page.locator('#plan-contact')).toHaveValue(greetingId);
    await expect(page.locator('#plan-occasion')).toHaveValue('birthday');
    await expect(page.locator('#plan-date')).toHaveValue(date(2));
    await page.keyboard.press('Escape');
    await page.locator('.occasions-more > summary').click();
    await expect(page.locator(`.occasion-group[data-group="visit|${date(3)}"]`)).toBeVisible();
    await expect(page.locator('.occasion-group[data-group="散步|"]')).toContainText('日期未定');
    await post('/api/memories', { contactId, type: 'preference', content: '喜欢低糖点心' });
    await expect(page.locator('#recent-list')).toContainText('喜欢低糖点心');
    await expect(group.locator('.people-more')).toHaveAttribute('open', '');
    await expect(card.locator('.att-details')).toHaveAttribute('open', '');
    await expect(page.locator('.occasions-more')).toHaveAttribute('open', '');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(card.getByRole('button', { name: '继续计划', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator('.recent-row', { hasText: '喜欢低糖点心' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#contact-detail')).toContainText('E2E 分组5');
    expect(errors).toEqual([]);
  });

  test('首页优先具体跟进与安排，泛节日和久未更新按需展开', async ({ page, request }) => {
    const post = async (path, data) => {
      const response = await request.post(path, { data });
      expect(response.ok()).toBeTruthy();
      return response.json();
    };
    const date = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const person = (await post('/api/contacts', { name: 'E2E 具体安排' })).contact;
    const old = (await post('/api/contacts', { name: 'E2E 仅旧记录' })).contact;
    const plan = (await post('/api/plans', { contactId: person.id, idea: '去公园散步聊近况', occasion: 'E2E散步', occasionDate: date(1), status: 'decided' })).plan;
    await post('/api/memories', { contactId: person.id, type: 'promise', content: '答应帮忙整理相册', direction: 'user_to_contact', date: date(-800) });
    await post('/api/memories', { contactId: old.id, type: 'interaction', content: '很久以前一起吃饭', direction: 'both', date: date(-900) });
    await page.goto('/');
    const followup = page.locator(`.followup-section .attention-card[data-id="${person.id}"]`);
    await expect(followup).toContainText('答应帮忙整理相册');
    await expect(page.locator('.followup-section')).toContainText('没有后续记录，不等于你还没做');
    const ownGroup = page.locator(`.occasion-group[data-group="e2e散步|${date(1)}"]`);
    await expect(ownGroup).toBeVisible();
    await expect(ownGroup.locator(`[data-action="plan-edit"][data-plan="${plan.id}"]`).first()).toBeVisible();
    expect(await page.locator('#attention-list').evaluate((el) => el.firstElementChild.classList.contains('followup-section'))).toBe(true);
    const oldCard = page.locator(`.fading-more .attention-card[data-id="${old.id}"]`);
    await expect(oldCard).toBeHidden();
    await page.locator('.fading-more > summary').focus();
    await page.keyboard.press('Enter');
    await expect(oldCard).toBeVisible();
    await expect(page.locator('.fading-more')).toContainText('不判断关系是否疏远');
    const calendar = page.locator('.calendar-more');
    await expect(calendar).not.toHaveAttribute('open', '');
    await expect(calendar.locator('.occasion-group').first()).toBeHidden();
    await calendar.locator(':scope > summary').click();
    await expect(calendar.locator('.occasion-group').first()).toBeVisible();
    await expect(calendar).toContainText('不默认需要送礼');
    const attention = await (await request.get('/api/attention')).json();
    expect(await page.locator('#view-home .occasion-group').count()).toBe(attention.occasionGroups.length);
    expect(await page.locator('#view-home .occasion-group .attention-card').count()).toBe(attention.occasionGroups.reduce((n, g) => n + g.people.length, 0));
    await followup.getByRole('button', { name: '记下进展' }).click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#qmt-text')).toHaveValue('');
    await expect(page.locator('#qmt-contact option:checked')).toHaveAttribute('value', person.id);
    await page.keyboard.press('Escape');
    await post('/api/memories', { contactId: person.id, type: 'attribute', content: '用于验证展开状态保留' });
    await expect(page.locator('#recent-list')).toContainText('用于验证展开状态保留');
    await expect(calendar).toHaveAttribute('open', '');
    await expect(page.locator('.fading-more')).toHaveAttribute('open', '');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('一句话记录：复制失败保留原话可重试，空白不保存，窄屏不溢出', async ({ page, request }) => {
    await page.addInitScript(() => {
      let fail = true;
      window.copiedPrompts = [];
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => {
        if (fail) { fail = false; throw new DOMException('Clipboard denied', 'NotAllowedError'); }
        window.copiedPrompts.push(text);
      } });
    });
    const before = (await (await request.get('/api/materials')).json()).materials.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: '记住一件事', exact: true }).click();
    await page.locator('#qmt-text').fill('   ');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#toast')).toContainText('不能为空');
    await expect(page.locator('#form-smart')).toBeVisible();
    await expect(page.locator('#qmt-text')).toHaveValue('   ');
    await page.locator('#qmt-text').fill('E2E 复制重试：小陈提到周末要搬家');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/materials') && r.request().method() === 'POST');
    await page.locator('#qmt-ok').click();
    const material = (await (await saved).json()).material;
    await expect(page.locator('#toast')).toContainText('素材已保存，但指令未复制');
    const card = page.locator(`.material-card[data-id="${material.id}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText('小陈提到周末要搬家');
    await expect(card).toContainText('待 AI 整理');
    expect((await (await request.get('/api/materials')).json()).materials.length).toBe(before + 1);
    await card.getByRole('button', { name: '手动复制' }).click();
    await expect(page.locator('#airesult-title')).toHaveText('手动复制整理指令');
    const { prompt } = await (await request.get(`/api/materials/${material.id}/organize-prompt`)).json();
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(prompt);
    expect((await (await request.get(`/api/materials/${material.id}`)).json()).material.delivery).toBeNull();
    expect(await page.locator('#form-airesult').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await card.getByRole('button', { name: '复制整理指令' }).click();
    await expect(page.locator('#toast')).toContainText('整理指令已复制');
    expect(await page.evaluate(() => window.copiedPrompts)).toEqual([expect.stringContaining(material.id)]);
    expect((await (await request.get('/api/materials')).json()).materials.length).toBe(before + 1);
    await page.getByRole('button', { name: '记住一件事', exact: true }).click();
    await expect(page.locator('#qmt-text')).toHaveValue('');
    await expect(page.locator('#qmt-contact option:checked')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '想想下一步', exact: true }).click();
    await expect(page.locator('#form-first')).toBeVisible();
    await expect(page.locator('#form-smart')).toBeHidden();
    await expect(page.locator('#form-quick-memory')).toBeHidden();
  });

  test('AI记忆整理：重要状态不折叠，零提取报告算完成，普通素材展开状态保留', async ({ page, request }) => {
    const post = async (path, data) => {
      const res = await request.post(path, { data });
      expect(res.ok()).toBeTruthy();
      return res.json();
    };
    const contactId = (await post('/api/contacts', { name: 'E2E 整理分层' })).contact.id;
    const raw = (await post('/api/materials', { contactId, text: '普通素材，之后再整理' })).material;
    const completed = (await post('/api/materials', { contactId, text: '重复内容无需拆出新记忆' })).material;
    await post('/api/tools', { name: 'material_report', args: { id: completed.id, report: '已核对，没有新事实，无需新增记忆。' } });
    const question = (await post('/api/materials', { contactId, text: '需要补充是谁送的花' })).material;
    await post('/api/tools', { name: 'organize_question', args: { materialId: question.id, question: '是谁送的花？', options: [
      { label: '是我', command: `素材 ${question.id} 是我送的花` },
      { label: '不确定', command: `素材 ${question.id} 不确定是谁送的花，跳过` },
    ] } });
    await page.goto('/');
    const rawCard = page.locator(`.material-card[data-id="${raw.id}"]`);
    const completedCard = page.locator(`.material-card[data-id="${completed.id}"]`);
    const questionCard = page.locator(`.material-card[data-id="${question.id}"]`);
    await expect(rawCard).toBeHidden();
    await expect(completedCard).toBeHidden();
    await expect(questionCard).toBeVisible();
    await expect(questionCard).toContainText('等你回答');
    await expect(page.locator('#material-count')).toContainText('已整理');
    await page.locator('.materials-more > summary').click();
    await expect(rawCard).toBeVisible();
    await expect(completedCard).toContainText('已整理');
    await expect(completedCard.getByRole('button', { name: 'AI 整理', exact: true })).toHaveCount(0);
    await post('/api/memories', { contactId, type: 'attribute', content: '整理状态刷新验证' });
    await expect(page.locator('#recent-list')).toContainText('整理状态刷新验证');
    await expect(page.locator('.materials-more')).toHaveAttribute('open', '');
    await expect(rawCard).toBeVisible();
    await page.locator('.materials-more > summary').click();
    await expect(questionCard).toBeVisible();
    await expect(rawCard).toBeHidden();
    await expect(page.locator('#home-sub')).not.toContainText('已就绪');
  });

  test('普通计划完成不写礼物记忆，送礼操作须明确展开和确认', async ({ page, request }) => {
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 散步完成' } })).json()).contact;
    const plan = (await (await request.post('/api/plans', { data: { contactId: contact.id, idea: '一起到公园散步', status: 'decided' } })).json()).plan;
    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    const card = page.locator(`#plans-list .occ-card[data-plan="${plan.id}"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-action="plan-sent"]')).toBeHidden();
    await expect(card.locator('[data-action="jd-open"]')).toBeHidden();
    await card.locator('.gift-tools > summary').click();
    await card.getByRole('button', { name: '已送出礼物', exact: true }).click();
    await expect(page.locator('#rel-dialog')).toContainText('普通见面、散步等安排');
    await page.keyboard.press('Escape');
    expect((await (await request.get(`/api/plans?contact_id=${contact.id}`)).json()).plans[0].status).toBe('decided');
    await card.getByRole('button', { name: '已完成', exact: true }).click();
    await expect(page.locator('#rel-dialog')).toContainText('不会自动生成');
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#toast')).toContainText('未自动写入记忆');
    await expect(card).toHaveCount(0);
    await page.locator('#completed-plans > summary').click();
    const completed = page.locator(`#completed-plans-list .occ-card[data-plan="${plan.id}"]`);
    await expect(completed).toContainText('已完成');
    await expect(completed.locator('[data-action="plan-sent"]')).toHaveCount(0);
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories).toEqual([]);
    await page.reload();
    await page.locator('.nav-item[data-view="gifts"]').click();
    await page.locator('#completed-plans > summary').click();
    await expect(completed).toContainText('一起到公园散步');
    await expect(page.locator('#ledger-given')).not.toContainText('一起到公园散步');
  });

  test('计划页按归一场合和具体日期分组，旧计划不串卡，泛节日不平铺', async ({ page, request }) => {
    const date = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const birthday = date(1);
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 精确生日', birthday: birthday.slice(5) } })).json()).contact;
    const plans = [];
    for (const [occasion, occasionDate, idea] of [['birthday', birthday, '本次生日散步'], ['生日', birthday, '本次中文生日'], ['birthday', date(4), '另一天生日计划'], ['birthday', `${Number(birthday.slice(0, 4)) - 1}${birthday.slice(4)}`, '去年生日计划'], ['生日', '', '未定日期计划']]) {
      plans.push((await (await request.post('/api/plans', { data: { contactId: contact.id, occasion, occasionDate, idea } })).json()).plan);
    }
    for (let i = 0; i < 23; i++) await request.post('/api/contacts', { data: { name: `E2E 折叠朋友${i}`, relation: 'friend' } });
    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    await expect(page.locator('#occasions-list .gift-person').first()).toBeAttached();
    const groups = (await (await request.get('/api/attention')).json()).occasionGroups.filter((g) => g.date && g.days >= 0 && g.days <= 30);
    await expect(page.locator('#occasions-list .occasion-group')).toHaveCount(groups.length);
    await expect(page.locator('#occasions-list .gift-person')).toHaveCount(groups.reduce((n, g) => n + g.people.length, 0));
    await expect(page.locator('#occasions-list .gift-person:visible')).not.toHaveCount(groups.reduce((n, g) => n + g.people.length, 0));
    await expect(page.locator('#occasions-list [data-action="suggest-open"]:visible')).toHaveCount(0);
    for (const summary of await page.locator('#occasions-list details:not(.gift-tools) > summary').all()) await summary.click();
    const current = page.locator(`#occasions-list .gift-person[data-contact="${contact.id}"][data-occasion="birthday"][data-date="${birthday}"]`);
    await expect(current).toContainText('本次生日散步');
    await expect(current).toContainText('本次中文生日');
    await expect(current).not.toContainText('另一天');
    await expect(current).not.toContainText('去年');
    await expect(current).not.toContainText('未定日期');
    for (const plan of plans) await expect(page.locator(`#view-gifts .occ-card[data-plan="${plan.id}"]`)).toHaveCount(1);
    await expect(page.locator('#plans-list')).toContainText('去年生日计划');
    await expect(page.locator('#plans-list')).toContainText('未定日期计划');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('手机联系人详情直接可达，记一笔预选当前人，返回后可换人', async ({ page, request }) => {
    const contacts = [];
    for (let i = 0; i < 23; i++) contacts.push((await (await request.post('/api/contacts', { data: { name: `E2E 手机联系人${i}` } })).json()).contact);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator(`.contact-row[data-id="${contacts[1].id}"]`).click();
    await expect(page.locator('#contact-list')).toBeHidden();
    await expect(page.locator('#contact-detail h2')).toHaveText(contacts[1].name);
    await expect(page.locator('.contact-back')).toBeInViewport();
    await page.locator('#btn-quick-memory').click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#qmt-contact')).toHaveValues([contacts[1].id]);
    await expect(page.locator('.capture-options')).toHaveAttribute('open', '');
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.locator('#qm-contact')).toHaveValue(contacts[1].id);
    expect(await page.locator('#form-quick-memory').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.locator('#qm-content').fill('记录给第二位联系人');
    await page.locator('#form-quick-memory button[type="submit"]').click();
    await expect(page.locator('#contact-detail')).toContainText('记录给第二位联系人');
    expect((await (await request.get(`/api/memories?contact_id=${contacts[0].id}`)).json()).memories).toHaveLength(0);
    let releaseTimeline;
    let timelineStarted;
    const release = new Promise((resolve) => { releaseTimeline = resolve; });
    const started = new Promise((resolve) => { timelineStarted = resolve; });
    const timelineUrl = `**/api/contacts/${contacts[1].id}/timeline`;
    await page.route(timelineUrl, async (route) => {
      const response = await route.fetch();
      timelineStarted();
      await release;
      await route.fulfill({ response });
    }, { times: 1 });
    await request.patch(`/api/contacts/${contacts[1].id}`, { data: { notes: '触发延迟详情刷新' } });
    await started;
    await page.locator('.contact-back').click();
    const staleResponse = page.waitForResponse((r) => r.url().endsWith(`/api/contacts/${contacts[1].id}/timeline`));
    releaseTimeline();
    await staleResponse;
    await expect(page.locator('#contact-detail')).toBeHidden();
    await expect(page.locator(`.contact-row[data-id="${contacts[1].id}"]`)).toBeFocused();
    await page.locator(`.contact-row[data-id="${contacts[2].id}"]`).click();
    await page.locator('#btn-quick-memory').click();
    await expect(page.locator('#qmt-contact')).toHaveValues([contacts[2].id]);
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.locator('#qm-contact')).toHaveValue(contacts[2].id);
    await page.keyboard.press('Escape');
    await page.locator('.nav-item[data-view="home"]').click();
    await page.locator('#btn-quick-memory').click();
    await expect(page.locator('#qmt-text')).toBeFocused();
    await expect(page.locator('#qmt-contact')).toHaveValues([]);
    await page.getByRole('button', { name: '不使用 AI？手动录入' }).click();
    await expect(page.locator('#qm-contact')).toHaveValue('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test('弹窗圈定键盘焦点，Esc优先取消顶层并恢复触发点', async ({ page, request }) => {
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 键盘取消' } })).json()).contact;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('#btn-new-contact').click();
    await expect(page.locator('#nc-name')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#nc-ok')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#nc-name')).toBeFocused();
    await expect(page.locator('#app-shell')).toHaveJSProperty('inert', true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#btn-new-contact')).toBeFocused();
    await expect(page.locator('#app-shell')).toHaveJSProperty('inert', false);
    await page.locator(`.contact-row[data-id="${contact.id}"]`).click();
    const trigger = page.locator('#contact-detail [data-action="delete-contact"]');
    await trigger.click();
    await expect(page.locator('#rel-dialog-cancel')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#rel-dialog-ok')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#rel-dialog-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#rel-dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect((await request.get(`/api/contacts/${contact.id}`)).ok()).toBe(true);
    await page.locator('#btn-manage-relations').click();
    const rename = page.locator('[data-action="rel-rename"]').first();
    await rename.click();
    await expect(page.locator('#rel-dialog-input')).toBeFocused();
    await expect(page.locator('#modal-backdrop')).toHaveJSProperty('inert', true);
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('#rel-dialog-ok')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#form-relations')).toBeVisible();
    await expect(rename).toBeFocused();
    await expect(page.locator('#modal-backdrop')).toHaveJSProperty('inert', false);
    await page.keyboard.press('Escape');
    await expect(page.locator('#btn-manage-relations')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('打算分层：未识别人不猜选，细节折叠可保存，失败保留且编辑不丢商品信息', async ({ page, request }) => {
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 分层打算' } })).json()).contact;
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await expect(page.locator(`.contact-row[data-id="${contact.id}"]`)).toBeVisible();
    await page.locator('.nav-item[data-view="home"]').click();
    await page.locator('#btn-quick-plan').click();
    await expect(page.locator('#plan-say')).toBeFocused();
    await expect(page.locator('#plan-save')).toBeInViewport();
    await expect(page.locator('#form-plan .primary-btn')).toHaveCount(1);
    await page.locator('#plan-say').fill('找一天一起散步');
    await expect(page.locator('#plan-contact')).toHaveValue('');
    await page.locator('#plan-save').click();
    await expect(page.locator('#plan-contact')).toBeFocused();
    await expect(page.locator('#form-plan')).toBeVisible();
    await page.locator('#plan-contact').selectOption(contact.id);
    await page.locator('#plan-idea').fill('送一本喜欢的书');
    await page.locator('#plan-details > summary').click();
    await page.locator('#plan-occasion').fill('拜访');
    await page.locator('#plan-budget').fill('¥100');
    await page.locator('#plan-status').selectOption('decided');
    await page.locator('#plan-details > summary').click();
    await expect(page.locator('#plan-details-summary')).toContainText('拜访 · ¥100 · 已定');
    await page.locator('#plan-product-details > summary').click();
    await page.locator('#plan-product-name').fill('旅行随笔');
    await page.locator('#plan-product-price').fill('¥68');
    await page.locator('#plan-product-url').fill('https://e2e.test/pen/hero');
    await page.locator('#plan-product-details > summary').click();
    await expect(page.locator('#plan-product-summary')).toContainText('旅行随笔');
    expect(await page.locator('#form-plan').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.route('**/api/plans', async (route) => {
      if (route.request().method() === 'POST') await route.fulfill({ status: 500, json: { ok: false, error: '保存暂时失败' } });
      else await route.continue();
    }, { times: 1 });
    await page.locator('#plan-save').click();
    await expect(page.locator('#toast')).toContainText('保存暂时失败');
    await expect(page.locator('#plan-idea')).toHaveValue('送一本喜欢的书');
    await expect(page.locator('#plan-product-url')).toHaveValue('https://e2e.test/pen/hero');
    await page.locator('#plan-save').click();
    await expect(page.locator('#toast')).toContainText('计划已保存');
    const plans = (await (await request.get(`/api/plans?contact_id=${contact.id}`)).json()).plans;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ idea: '送一本喜欢的书', occasion: '拜访', budget: '¥100', status: 'decided', productName: '旅行随笔', productPrice: '¥68', productUrl: 'https://e2e.test/pen/hero' });
    await page.locator('.nav-item[data-view="gifts"]').click();
    await page.locator(`#plans-list [data-action="plan-edit"][data-id="${plans[0].id}"]`).click();
    await expect(page.getByRole('dialog', { name: '编辑打算', exact: true })).toBeVisible();
    await expect(page.locator('#plan-capture')).toBeHidden();
    await expect(page.locator('#plan-idea')).toBeFocused();
    await expect(page.locator('#plan-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#plan-product-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#plan-product-summary')).toContainText('旅行随笔');
    await page.locator('#plan-idea').fill('见面时送旅行随笔');
    await page.locator('#plan-save').click();
    await expect(page.locator('#toast')).toContainText('计划已保存');
    const edited = (await (await request.get(`/api/plans?contact_id=${contact.id}`)).json()).plans;
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ ...plans[0], idea: '见面时送旅行随笔', updatedAt: expect.any(String) });
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories).toEqual([]);
    await page.locator('#btn-quick-plan').click();
    await expect(page.locator('#plan-capture')).toBeVisible();
    await expect(page.locator('#plan-say')).toBeFocused();
    await expect(page.locator('#plan-details-summary')).toHaveText('（可选）');
    await expect(page.locator('#plan-product-summary')).toHaveText('（仅送礼时选填）');
    await expect(page.locator('#plan-save')).toHaveText('保存打算');
    expect(errors).toEqual([]);
  });

  test('一句话建计划：本地解析自动拆联系人/日期/想法，核对后保存', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 一句话小李' } })).json()).contact;
    const d = new Date(); d.setDate(d.getDate() + 1);
    const tomorrow = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await page.goto('/');
    // 联系人列表由启动时 refresh 异步载入：弹窗可能因列表未就绪被拒，toPass 兜底重开
    await expect(async () => {
      await page.getByRole('button', { name: '＋ 记个打算' }).click();
      await expect(page.locator('#plan-say')).toBeVisible();
    }).toPass();
    await expect(page.locator('#plan-say')).toBeFocused();
    await expect(page.getByRole('dialog', { name: '记个打算', exact: true })).toBeVisible();
    await expect(page.locator('#plan-contact')).toHaveValue('');
    await expect(page.locator('#plan-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#plan-product-details')).not.toHaveAttribute('open', '');
    await expect(page.locator('#plan-product-name')).toBeHidden();
    await page.locator('#plan-say').fill(`明天约${contact.name}吃饭`);
    await expect(page.locator('#plan-contact')).toHaveValue(contact.id);
    await expect(page.locator('#plan-date')).toHaveValue(tomorrow);
    await expect(page.locator('#plan-idea')).toHaveValue('约吃饭');
    await expect(page.locator('#plan-say-hint')).toBeVisible();
    await expect(page.locator('#plan-say-hint')).toContainText(`联系人 ${contact.name}`);
    await page.locator('#form-plan button[type="submit"]').click();
    await expect(page.locator('#toast')).toContainText('计划已保存');
    const plans = (await (await request.get('/api/plans')).json()).plans;
    const mine = plans.find((p) => p.contactId === contact.id);
    expect(mine).toBeTruthy();
    expect(mine.occasionDate).toBe(tomorrow);
    expect(mine.idea).toBe('约吃饭');
    expect(errors).toEqual([]);
  });

  test('京东找同款关键词：送礼想法才预填，电话/散步类计划留空手填', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const contact = (await (await request.post('/api/contacts', { data: { name: 'E2E 京东关键词' } })).json()).contact;
    const call = (await (await request.post('/api/plans', { data: { contactId: contact.id, idea: '联系一下', status: 'decided' } })).json()).plan;
    const gift = (await (await request.post('/api/plans', { data: { contactId: contact.id, idea: '送低糖蛋糕，他喜欢低糖', status: 'decided' } })).json()).plan;
    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    const callCard = page.locator(`#plans-list .occ-card[data-plan="${call.id}"]`);
    const giftCard = page.locator(`#plans-list .occ-card[data-plan="${gift.id}"]`);
    await callCard.locator('.gift-tools > summary').click();
    await callCard.getByRole('button', { name: '京东找同款' }).click();
    await expect(page.locator('#jd-keyword')).toHaveValue('');
    await page.keyboard.press('Escape');
    await giftCard.locator('.gift-tools > summary').click();
    await giftCard.getByRole('button', { name: '京东找同款' }).click();
    await expect(page.locator('#jd-keyword')).toHaveValue('低糖蛋糕');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('数据安全：AI 修改需确认，历史可查看和恢复', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { contact } = await (await request.post('/api/contacts', { data: { name: 'E2E 修改确认' } })).json();
    const { memory } = await (await request.post('/api/memories', { data: { contactId: contact.id, type: 'preference', content: '原先喜欢红茶' } })).json();
    await request.post('/api/tools', { data: { name: 'memory_update', args: { id: memory.id, content: '现在喜欢绿茶', importance: 3 } } });
    await page.goto('/');
    const card = page.locator('.revision-card', { hasText: 'E2E 修改确认' });
    await expect(card).toContainText('原先喜欢红茶');
    await expect(card).toContainText('现在喜欢绿茶');
    await expect(card).toContainText('重要度');
    const original = (await (await request.get(`/api/contacts/${contact.id}/timeline`)).json()).memories.find((m) => m.id === memory.id);
    expect(original.content).toBe('原先喜欢红茶');
    await card.getByRole('button', { name: '确认修改', exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator('.contact-row', { hasText: 'E2E 修改确认' }).click();
    const row = page.locator(`.memory-row[data-id="${memory.id}"]`);
    await expect(row).toContainText('现在喜欢绿茶');
    await row.getByRole('button', { name: '修改历史' }).click();
    await expect(page.locator('#memory-history')).toContainText('原先喜欢红茶');
    await page.getByRole('button', { name: '恢复到此次修改前' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#memory-history .history-entry')).toHaveCount(2);
    await page.locator('#history-close').click();
    await expect(row).toContainText('原先喜欢红茶');
    expect(errors).toEqual([]);
  });

  test('数据安全：原文变化时旧提案不能覆盖，可选择保留原内容', async ({ page, request }) => {
    const { contact } = await (await request.post('/api/contacts', { data: { name: 'E2E 修改冲突' } })).json();
    const { memory } = await (await request.post('/api/memories', { data: { contactId: contact.id, type: 'event', content: '原计划周末见面' } })).json();
    await request.post('/api/tools', { data: { name: 'memory_update', args: { id: memory.id, content: 'AI 建议周六见面' } } });
    await request.patch(`/api/memories/${memory.id}`, { data: { content: '用户确定周日见面' } });
    const { pendingRevisions } = await (await request.get('/api/overview')).json();
    const proposal = pendingRevisions.find((p) => p.memoryId === memory.id);
    await page.goto('/');
    const card = page.locator(`.revision-card[data-revision="${proposal.id}"]`);
    await card.getByRole('button', { name: '确认修改' }).click();
    await expect(page.locator('#toast')).toContainText('旧提案不能覆盖');
    await expect(card).toBeVisible();
    const current = (await (await request.get(`/api/contacts/${contact.id}/timeline`)).json()).memories.find((m) => m.id === memory.id);
    expect(current.content).toBe('用户确定周日见面');
    await card.getByRole('button', { name: '保留原内容' }).click();
    await expect(card).toHaveCount(0);
  });

  test('数据安全：窄屏入口可达，弹窗可用键盘关闭', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    const trigger = page.getByRole('button', { name: '数据安全与备份' });
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(page.locator('#safety-status')).toContainText('JSON');
    await expect(page.locator('#safety-close')).toBeEnabled();
    expect(await page.locator('#form-safety').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#form-safety')).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.setViewportSize({ width: 768, height: 900 });
    await trigger.click();
    await expect(page.locator('#form-safety')).toBeVisible();
  });

  test('跟进闭环：事项独立处理、延期、恢复，不改事实和台账', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const post = async (url, data) => { const res = await request.post(url, { data }); expect(res.ok()).toBeTruthy(); return res.json(); };
    const { contact } = await post('/api/contacts', { name: 'E2E 跟进闭环' });
    const { memory: first } = await post('/api/memories', { contactId: contact.id, type: 'promise', content: '闭环事项一：发送照片', date: '2000-01-01' });
    const { memory: second } = await post('/api/memories', { contactId: contact.id, type: 'promise', content: '闭环事项二：安排聚餐', date: '2000-01-02' });
    const { memory: gift } = await post('/api/memories', { contactId: contact.id, type: 'gift', direction: 'contact_to_user', content: '闭环收到的一本书', date: '2000-01-03' });
    const facts = (await (await request.get(`/api/contacts/${contact.id}/timeline`)).json()).memories;
    const ledger = await (await request.get('/api/gifts/ledger')).json();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    const more = page.locator('[data-disclosure="followups-more"]');
    if (await more.count()) await more.locator(':scope > summary').click();
    const firstCard = page.locator(`.followup-section [data-followup="promise:${first.id}"]`);
    const secondCard = page.locator(`.followup-section [data-followup="promise:${second.id}"]`);
    await firstCard.getByRole('button', { name: '已办妥', exact: true }).click();
    await expect(page.locator('#rel-dialog')).toContainText('不修改原始记忆或新增送礼记录');
    await page.locator('#rel-dialog-cancel').click();
    await expect(firstCard).toBeVisible();
    await firstCard.getByRole('button', { name: '已办妥', exact: true }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(firstCard).toHaveCount(0);
    await expect(secondCard).toBeVisible();
    await secondCard.getByRole('button', { name: '稍后提醒' }).click();
    await page.locator('#rel-dialog-input').fill('2000-01-01');
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#rel-dialog')).toBeVisible();
    const until = await page.locator('#rel-dialog-input').getAttribute('min');
    await page.locator('#rel-dialog-input').fill(until);
    await page.locator('#rel-dialog-ok').click();
    await expect(secondCard).toHaveCount(0);
    await page.locator('.handled-followups > summary').click();
    const handledSecond = page.locator(`.handled-followups [data-followup="promise:${second.id}"]`);
    await expect(handledSecond).toContainText(`${until} 起重新出现在工作台`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await page.locator('.handled-followups > summary').click();
    await expect(handledSecond).toContainText('稍后提醒');
    await handledSecond.getByRole('button', { name: '恢复提醒' }).click();
    await expect(handledSecond).toHaveCount(0);
    if (await more.count()) await more.locator(':scope > summary').click();
    await expect(secondCard).toBeVisible();
    await secondCard.getByRole('button', { name: '不再跟进' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(secondCard).toHaveCount(0);
    await page.locator('.nav-item[data-view="gifts"]').click();
    const giftCard = page.locator(`#reciprocity-list [data-followup="reciprocity:${gift.id}"]`);
    await expect(giftCard).toBeVisible();
    await giftCard.getByRole('button', { name: '已办妥' }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(giftCard).toHaveCount(0);
    await expect(page.locator('#ledger-received')).toContainText('闭环收到的一本书');
    await page.locator('.nav-item[data-view="contacts"]').click();
    await page.locator(`.contact-row[data-id="${contact.id}"]`).click();
    await expect(page.locator('.briefing-card')).not.toContainText('闭环事项');
    const after = await (await request.get(`/api/contacts/${contact.id}/timeline`)).json();
    expect(after.briefing.promises).toEqual([]);
    expect(after.briefing.reciprocity).toEqual([]);
    expect(after.memories).toEqual(facts);
    expect(await (await request.get('/api/gifts/ledger')).json()).toEqual(ledger);
    expect(errors).toEqual([]);
  });

  test('独立模式未完成素材可继续复制，发送留痕不等于确认', async ({ page, request }) => {
    await page.addInitScript(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { window.lastPrompt = text; } }); });
    const { contact } = await (await request.post('/api/contacts', { data: { name: 'E2E 继续整理' } })).json();
    const { material } = await (await request.post('/api/materials', { data: { text: 'E2E 未整理完成的素材：喜欢绿茶' } })).json();
    const extraction = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId: contact.id, type: 'preference', content: '喜欢绿茶', sourceId: material.id, sourceQuote: '喜欢绿茶' } } });
    expect(extraction.ok()).toBeTruthy();
    const { memory } = await extraction.json();
    await page.goto('/');
    const card = page.locator(`.material-card[data-id="${material.id}"]`);
    await expect(card).toContainText('整理未完成');
    await expect(card.locator('[data-action="organize-material"]')).toHaveCount(0);
    await card.getByRole('button', { name: '复制继续整理指令' }).click();
    await expect(card).toContainText('尚未确认发送');
    expect(await page.evaluate(() => window.lastPrompt)).toContain(material.id);
    const saved = (await (await request.get(`/api/materials/${material.id}`)).json()).material;
    expect(saved.delivery.copiedAt).toBeTruthy();
    expect(saved.delivery.sentAt).toBe('');
    expect(saved.report || '').toBe('');
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories.find((item) => item.id === memory.id).status).toBe('pending');
    await page.reload();
    await expect(card).toContainText('尚未确认发送');
    await expect(card.getByRole('button', { name: '复制继续整理指令' })).toBeEnabled();
  });

  test('建议复制失败保留输入，重试复用联系人', async ({ page, request }) => {
    await page.addInitScript(() => {
      let fail = true;
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async () => {
        if (fail) { fail = false; throw new Error('E2E clipboard denied'); }
      } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: '想想下一步', exact: true }).click();
    await page.locator('#fr-name').fill('E2E 建议复制重试');
    await page.locator('#fr-note').fill('下周想约对方散步');
    await page.locator('#fr-go').click();
    await expect(page.locator('#toast')).toContainText('输入已保留');
    await expect(page.locator('#form-first')).toBeVisible();
    await expect(page.locator('#fr-name')).toHaveValue('E2E 建议复制重试');
    await expect(page.locator('#fr-note')).toHaveValue('下周想约对方散步');
    await expect(page.locator('#fr-go')).toBeEnabled();
    await page.locator('#fr-go').click();
    await expect(page.locator('#form-first')).toBeHidden();
    const { contacts } = await (await request.get('/api/contacts')).json();
    expect(contacts.filter((c) => c.name === 'E2E 建议复制重试')).toHaveLength(1);
  });

  test('模拟宿主：发送失败可重试，成功后才记录送达并关闭建议表单', async ({ page, request }) => {
    let rejectNext = true;
    let sequence = 0;
    const accepted = [];
    await page.route('**/api/dsh-relationship/workbench/**', async (route) => {
      const url = new URL(route.request().url());
      url.pathname = url.pathname.replace('/api/dsh-relationship/workbench', '');
      if (url.pathname === '/api/events') { await route.abort(); return; }
      await route.fulfill({ response: await route.fetch({ url: url.toString() }) });
    });
    await page.route('**/api/session/*', async (route) => {
      const body = route.request().postDataJSON();
      let value = {};
      if (body.method === 'session/create') value = { sessionId: 'e2e-dispatch' };
      if (body.method === 'session/list') value = { items: [{ sessionId: 'e2e-dispatch' }] };
      if (body.method === 'session/prompt') {
        if (rejectNext) { rejectNext = false; await route.fulfill({ status: 503, json: {} }); return; }
        accepted.push(body.payload.args.request.content[0].text);
        sequence++;
      }
      await route.fulfill({ json: { rpcId: body.rpcId, result: { ok: true, value } } });
    });
    await page.route('**/api/agentPresets/list', (route) => route.fulfill({ json: { result: { ok: true, value: { items: [{ id: 'relationship' }] } } } }));
    await page.routeWebSocket('**/api/remote.mux', (socket) => socket.onMessage((message) => {
      const { streamId } = JSON.parse(message);
      socket.send(JSON.stringify({ streamId, type: 'item', value: { type: 'snapshot', records: [{ event: { seq: sequence, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'E2E 模拟宿主回复' }] } } } }] } }));
    }));
    await page.goto('/api/dsh-relationship/workbench/');
    await page.getByRole('button', { name: '记住一件事', exact: true }).click();
    await page.locator('#qmt-text').fill('E2E 宿主发送失败保留素材');
    const response = page.waitForResponse((res) => res.url().endsWith('/api/materials') && res.request().method() === 'POST');
    await page.locator('#qmt-ok').click();
    const { material } = await (await response).json();
    const card = page.locator(`.material-card[data-id="${material.id}"]`);
    await expect(page.locator('#toast')).toContainText('素材已保存，但指令未发送');
    expect((await (await request.get(`/api/materials/${material.id}`)).json()).material.delivery).toBeNull();
    await card.getByRole('button', { name: 'AI 整理', exact: true }).click();
    await expect(card).toContainText('尚未收到整理报告');
    expect(accepted).toEqual([`整理素材 ${material.id}`]);
    const saved = (await (await request.get(`/api/materials/${material.id}`)).json()).material;
    expect(saved.delivery.sentAt).toBeTruthy();
    expect(saved.delivery.copiedAt).toBe('');
    expect(saved.status).toBe('raw');
    await card.getByRole('button', { name: '重新发送整理指令' }).click();
    await page.locator('#rel-dialog-cancel').click();
    expect(accepted).toHaveLength(1);
    rejectNext = true;
    await page.getByRole('button', { name: '想想下一步', exact: true }).click();
    await page.locator('#fr-name').fill('E2E 宿主建议重试');
    await page.locator('#fr-note').fill('记得询问搬家近况');
    await page.locator('#fr-go').click();
    await expect(page.locator('#toast')).toContainText('输入已保留');
    await expect(page.locator('#fr-note')).toHaveValue('记得询问搬家近况');
    await page.locator('#fr-go').click();
    await expect(page.locator('#form-first')).toBeHidden();
    await expect(page.locator('#airesult-body')).toContainText('E2E 模拟宿主回复');
    expect(accepted).toHaveLength(2);
  });

  test('批量确认遇到失效记忆时按实际结果反馈', async ({ page, request }) => {
    const { contact } = await (await request.post('/api/contacts', { data: { name: 'E2E 部分确认' } })).json();
    const { material } = await (await request.post('/api/materials', { data: { text: 'E2E 部分确认素材：喜欢游泳；喜欢爬山' } })).json();
    const memories = [];
    for (const content of ['喜欢游泳', '喜欢爬山']) {
      const extraction = await request.post('/api/tools', { data: { name: 'memory_add', args: { contactId: contact.id, type: 'preference', content, sourceId: material.id, sourceQuote: content } } });
      expect(extraction.ok()).toBeTruthy();
      memories.push((await extraction.json()).memory);
    }
    await page.goto('/');
    await page.route('**/api/memories/confirm', async (route) => {
      await request.delete(`/api/memories/${memories[1].id}`);
      await route.continue();
    });
    await page.locator(`.material-card[data-id="${material.id}"]`).getByRole('button', { name: '确认这 2 条' }).click();
    await expect(page.locator('#toast')).toContainText('已确认 1 条素材记忆；1 条未确认');
    expect((await (await request.get(`/api/memories?contact_id=${contact.id}`)).json()).memories.find((item) => item.id === memories[0].id).status).toBe('confirmed');
  });

  test('数据安全：导出、预览不写入、确认恢复及坏文件拒绝', async ({ page, request }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('/');
    await page.getByRole('button', { name: '数据安全与备份' }).click();
    await expect(page.locator('#safety-status')).toContainText('JSON');
    const downloaded = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前数据', exact: true }).click();
    const backupFile = fs.readFileSync(await (await downloaded).path());
    await expect(page.locator('#safety-export')).toBeEnabled();
    const { contact: later } = await (await request.post('/api/contacts', { data: { name: 'E2E 备份后的记录' } })).json();
    await page.locator('#safety-file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backupFile });
    await expect(page.locator('#safety-preview')).toContainText('尚未修改当前数据');
    expect((await request.get(`/api/contacts/${later.id}`)).status()).toBe(200);
    await page.getByRole('button', { name: '确认恢复此备份', exact: true }).click();
    await page.locator('#rel-dialog-cancel').click();
    expect((await request.get(`/api/contacts/${later.id}`)).status()).toBe(200);
    await page.getByRole('button', { name: '确认恢复此备份', exact: true }).click();
    await page.locator('#rel-dialog-ok').click();
    await expect(page.locator('#safety-status')).toContainText('恢复完成');
    expect((await request.get(`/api/contacts/${later.id}`)).status()).toBe(404);
    await page.locator('#safety-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await expect(page.locator('#safety-status')).toContainText('不是有效的 JSON');
    await expect(page.locator('#safety-restore')).toBeHidden();
    await page.locator('#safety-close').click();
    await expect(page.locator('#form-safety')).not.toBeVisible();
    expect(errors).toEqual([]);
  });
});
