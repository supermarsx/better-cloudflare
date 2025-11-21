import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ page }) => {
  // Intercept API requests and mock responses for simple UI flows
  await page.route('**/api/verify-token', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
  await page.route('**/api/zones', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'zone-1', name: 'example.com', status: 'active' }]) }));
  await page.route('**/api/zones/zone-1/dns_records', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/zones/*/dns_records', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
  await page.route('**/api/passkeys/register/options/*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ challenge: 'c1', options: {} }) }));
});

test('happy path: add key and login', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('text=Cloudflare DNS Manager')).toBeVisible();

  // Open Add Key dialog
  await page.getByRole('button', { name: 'Add Key' }).click();
  await page.fill('input[placeholder="Label"]', 'e2e-key');
  await page.fill('input[placeholder="API Key"]', 'dummy-token');
  await page.fill('input[placeholder="Enter your password"]', 'pw');
  await page.getByRole('button', { name: 'Create' }).click();
  // The UI uses a toast; check toast exists or dropdown contains new item
  await page.waitForTimeout(500);
  // The stored key should appear in select list
  await expect(page.locator('text=e2e-key')).toBeVisible();

  // Attempt login via select change
  await page.click('text=e2e-key');
  await page.fill('#password', 'pw');
  await page.getByRole('button', { name: 'Login' }).click();

  // After login, DNS Manager should show
  await expect(page.locator('text=DNS Manager')).toBeVisible();
});

test('accessibility: homepage has no a11y violations', async ({ page }) => {
  await page.goto('/');
  const accessibilityScanResults = await new AxeBuilder({ page }).analyze();
  expect(accessibilityScanResults.violations.length).toBe(0);
});
