// Close only the explicitly isolated Tauri test application.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222');
const page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay=icons'));
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
assert.equal(await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:app|identifier')),'com.desktopboard.interactiontest','Refusing to close a normal application.');
const closed=page.waitForEvent('close',{timeout:10000});
await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('quit_app'));await closed;await browser.close();
