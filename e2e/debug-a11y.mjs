import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(1000);
  const results = await new AxeBuilder({ page }).analyze();
  console.log('violations:', JSON.stringify(results.violations, null, 2));
  await browser.close();
})();
