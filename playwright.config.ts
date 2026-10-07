import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', use: { baseURL: 'http://127.0.0.1:1420', viewport: { width: 560, height: 660 }, channel: 'msedge' }, webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:1420', reuseExistingServer: true }, workers: 1 });
