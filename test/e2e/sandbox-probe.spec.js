import { test } from '@playwright/test';
test('GUI 加载等待与入口', async ({ browser }) => {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(6000);
  const html = await page.evaluate(() => document.body.innerHTML.slice(0, 300));
  console.log('BODY:', html.replace(/\s+/g, ' '));
  const entry = await page.locator('text=关系记忆').count();
  console.log('「关系记忆」文案数:', entry);
  await page.close();
});
