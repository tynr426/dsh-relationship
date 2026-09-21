import { test, expect } from '@playwright/test';
import fs from 'node:fs';

// 独立模式作答走 navigator.clipboard.writeText，需授权（Chromium 默认拒绝）
test.use({ permissions: ['clipboard-write'] });

test.describe('关系记忆工作台', () => {
  test('首页可访问并显示核心区块', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '帮你记住重要的人，也帮你想下一步怎么做' })).toBeVisible();
    // 空库：待确认队列折叠（状态并入头部副标），最近记住了不占位
    await expect(page.locator('#pending-panel')).toBeHidden();
    await expect(page.locator('#recent-box')).toBeHidden();
    await expect(page.locator('#home-sub')).toContainText('记忆整理已就绪');
  });

  test('空库首价值引导：场景 → 建联系人 → 指令就绪', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#onboarding')).toBeVisible();
    await expect(page.locator('#attention-list')).toBeEmpty();
    await page.getByRole('button', { name: '不知道送什么' }).click();
    await expect(page.locator('#form-first')).toBeVisible();
    await page.locator('#fr-name').fill('E2E 张老师');
    await page.locator('#fr-note').fill('教师节送礼，两年没联系');
    await page.locator('#fr-go').click();
    await expect(page.locator('#toast')).toContainText('指令已复制');
    await expect(page.locator('#onboarding')).toBeHidden();
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
    await page.locator('#qmt-text').fill('2026-09-11 20:30 今天和小李吃饭，他说女儿十月办婚礼，还在学潜水，对花生过敏。上次的茶叶他很喜欢。');
    await page.locator('#qmt-ok').click();
    await expect(page.locator('#toast')).toContainText('素材已保存');

    // 首页出现待整理素材卡
    await expect(page.locator('#material-box')).toBeVisible();
    const card = page.locator('.material-card').first();
    await expect(card).toContainText('待 AI 整理');
    await expect(card).toContainText('E2E 素材小李');

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
    await expect(card.getByRole('button', { name: '继续整理' })).toBeVisible();

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
    await expect(card.getByRole('button', { name: '继续整理' })).toHaveCount(0);
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

  test('礼赠：新建计划 → 标已送自动入台账', async ({ page, request }) => {
    const created = await request.post('/api/contacts', { data: { name: 'E2E 礼物王老师', relation: 'other', tags: ['老师'] } });
    expect(created.ok()).toBeTruthy();
    const contactId = (await created.json()).contact.id;

    await page.goto('/');
    await page.locator('.nav-item[data-view="gifts"]').click();
    await expect(page.getByRole('heading', { name: '礼赠' })).toBeVisible();

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
    await page.locator('#rel-dialog-input').fill(keepId);
    await page.locator('#rel-dialog-ok').click();
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
});
