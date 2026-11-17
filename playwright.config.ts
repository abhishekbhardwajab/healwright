import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testIgnore: ['**/.tmp/**'],
  timeout: 60_000,
  workers: 2,
  reporter: [['list']],
  use: { trace: 'off' },
});
