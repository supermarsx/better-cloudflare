import { test, expect } from '@playwright/test';

test.describe('Client-side Stability Checks', () => {
  
  test('should load without hydration errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    
    // Listen for console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Filter for React hydration errors
        if (
          text.includes('Hydration failed') || 
          text.includes('Text content does not match') ||
          text.includes('There was an error while hydrating') ||
          text.includes('Minified React error #418') || // Hydration failed
          text.includes('Minified React error #423')    // Text content mismatch
        ) {
          consoleErrors.push(text);
        }
      }
    });

    await page.goto('/');
    
    // Wait for initial render and potential hydration
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    if (consoleErrors.length > 0) {
      console.error('Hydration errors detected:', consoleErrors);
    }

    expect(consoleErrors).toEqual([]);
  });

  test('monkey test - random interactions', async ({ page }) => {
    const exceptions: Error[] = [];
    
    // Catch unhandled exceptions
    page.on('pageerror', exception => {
      console.error('Monkey test caught exception:', exception);
      exceptions.push(exception);
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    // Perform random clicks
    const ACTIONS = 20;
    console.log(`Starting monkey test with ${ACTIONS} actions...`);

    for (let i = 0; i < ACTIONS; i++) {
      // Find all clickable elements currently on the page
      // We re-query every time because the DOM might have changed
      const clickables = await page.locator('button:visible, a:visible, [role="button"]:visible, input[type="submit"]:visible, input[type="button"]:visible').all();
      
      if (clickables.length === 0) {
        console.log('No clickable elements found, stopping monkey test.');
        break;
      }

      const randomIndex = Math.floor(Math.random() * clickables.length);
      const element = clickables[randomIndex];

      try {
        // Try to click. If it fails (detached, covered, etc.), we just catch and continue.
        // We use a short timeout so we don't get stuck.
        await element.click({ timeout: 500, force: true });
        
        // Small delay to let UI react
        await page.waitForTimeout(100);
      } catch (e) {
        // It's expected that some clicks might fail in a chaotic test
        // console.log('Monkey click failed:', e);
      }
    }

    // Ensure no unhandled exceptions occurred during the chaos
    expect(exceptions).toEqual([]);
  });
});
