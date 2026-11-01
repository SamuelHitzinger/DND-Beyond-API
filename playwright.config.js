import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// Process-local only: never fall back to a user's shared browser cache.
process.env.PLAYWRIGHT_BROWSERS_PATH = fileURLToPath(new URL('./.tools/playwright/', import.meta.url));

export default defineConfig({
  testDir: './tests/browser',
  outputDir: './artifacts/browser-tests',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  workers: 4,
  reporter: 'list',
  use: { browserName: 'chromium', headless: true, locale: 'en-US', serviceWorkers: 'block' },
});
