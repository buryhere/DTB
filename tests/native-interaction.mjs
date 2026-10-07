// Run against an isolated desktop test instance, never against normal user data.
// See README.zh-CN.md for the launch configuration.
import { chromium, expect } from '@playwright/test';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const context = browser.contexts()[0], page = context.pages().find(p => !p.url().includes("overlay="));
await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
const invoke = (name, args = {}, target = page) => target.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
assert.equal(await invoke('plugin:app|identifier'), 'com.desktopboard.interactiontest', 'Launch the isolated test configuration.');
const doc = await invoke('load_document');
assert.equal(doc.items.length, 0, 'Use a fresh isolated test data directory.');
assert.equal(doc.boards.length, 1, 'Use a fresh isolated test data directory.');
if (!doc.settings.onboardingDone) await page.getByText('暂不开启').click();
await invoke('set_level', { label: 'main', level: 'top' });
await invoke('plugin:window|set_focus', { label: 'main' });
await expect(page.locator('main')).toHaveCSS('--paper-rgb', '255, 240, 245');

const beforeSize = await invoke('plugin:window|outer_size', { label: 'main' });
const origin = await invoke('plugin:window|outer_position', { label: 'main' });
const scale = await invoke('plugin:window|scale_factor', { label: 'main' });
const toolbar = await page.locator('.toolbar').boundingBox();
const x = Math.round(origin.x + (toolbar.x + toolbar.width * .45) * scale), y = Math.round(origin.y + (toolbar.y + toolbar.height / 2) * scale);
// Real OS input is necessary: CDP mouse events do not change GetAsyncKeyState.
const nativeInput = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class BoardMouse { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y); [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra); [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context); [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index); }'
[BoardMouse]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[BoardMouse]::SetCursorPos(${x},${y}) | Out-Null
Start-Sleep -Milliseconds 80
[BoardMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
try { Start-Sleep -Milliseconds 150; [BoardMouse]::SetCursorPos(([BoardMouse]::GetSystemMetrics(0)-2),([BoardMouse]::GetSystemMetrics(1)/2)) | Out-Null; Start-Sleep -Milliseconds 250 } finally { [BoardMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
`;
execFileSync('powershell', ['-NoProfile', '-Command', nativeInput], { windowsHide: true });
await expect.poll(() => invoke('plugin:window|outer_position', { label: 'main' })).not.toEqual(origin);
assert.deepEqual(await invoke('plugin:window|outer_size', { label: 'main' }), beforeSize, 'Dragging to an edge must not resize the board.');
await invoke('plugin:window|set_position', { label: 'main', value: { Physical: origin } });
console.log('PASS: dragging the blank toolbar to the screen edge preserves window dimensions');

async function note(text,x,y,target=page){await target.locator('.editor-line').nth(Math.round(y/24)).click({position:{x:Math.max(0,x-24),y:12}});for(const [i,line] of text.split('\n').entries()){if(i)await target.keyboard.press('Enter');await target.keyboard.insertText(line);}await expect(target.getByText('\u5df2\u4fdd\u5b58',{exact:true})).toBeVisible();}

await note('上半张纸\nEnter 可以继续换行', 80, 48);
await note('下半张纸', 80, 384);
await page.screenshot({ path: 'interaction-check.png' });

async function cut(target, direction, coordinate) {
  const area = await target.getByLabel('自由书写区域').boundingBox();
  const position = await invoke('plugin:window|outer_position', { label: await target.evaluate(() => window.__TAURI_INTERNALS__.metadata.currentWindow.label) }, target);
  await target.getByLabel('\u7ed8\u56fe\u4e0e\u88c1\u526a').click();await target.getByLabel('\u526a\u5200\u88c1\u526a').click();
  let overlay;await expect.poll(()=>{overlay=context.pages().find(p=>p.url().includes('overlay=cut'));return !!overlay;}).toBe(true);
  await expect(overlay.getByLabel('屏幕裁剪区域')).toBeVisible();
  const scene=await invoke('cut_scene');
  const physical = (x,y)=>({x:Math.round(position.x+x*scale),y:Math.round(position.y+y*scale)});
  const start=direction==='horizontal'?physical(area.x-10,area.y+coordinate):physical(area.x+coordinate,area.y-10);
  const end=direction==='horizontal'?physical(area.x+area.width+10,area.y+coordinate):physical(area.x+coordinate,area.y+area.height+10);
  const script = `
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class CutMouse {[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);[DllImport("user32.dll")]public static extern bool SetProcessDpiAwarenessContext(IntPtr context);}'
[CutMouse]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
[CutMouse]::SetCursorPos(${start.x},${start.y}) | Out-Null
Start-Sleep -Milliseconds 100
[CutMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
try { for($step=1;$step -le 30;$step++){[CutMouse]::SetCursorPos([int](${start.x}+(${end.x}-${start.x})*$step/30),[int](${start.y}+(${end.y}-${start.y})*$step/30)) | Out-Null;Start-Sleep -Milliseconds 12};Start-Sleep -Milliseconds 250 } finally {[CutMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}
`;
  assert(scene.token);
  await Promise.all([promisify(execFile)('powershell',['-NoProfile','-Command',script],{windowsHide:true}),expect(overlay.locator('.cut-line')).toHaveCount(1)]);
}
await cut(page, 'horizontal', 240);
await expect.poll(async () => (await invoke('load_document')).boards.length).toBe(2);
let saved = await invoke('load_document');
assert.equal(saved.items.length, 3);
assert.equal(saved.items.find(i => i.text === '下半张纸').boardId, saved.boards[1].id);
console.log('PASS: horizontal scissor gesture splits native windows and retains both notes');

const childId = saved.boards[1].id;
await expect.poll(() => context.pages().filter(p => !p.url().includes("overlay=")).length).toBe(2);
const child = context.pages().find(p => p !== page && !p.url().includes("overlay="));
await expect(child.getByText('下半张纸', { exact: true })).toBeVisible();
const childLabel = `board-${childId}`;
await invoke('plugin:window|set_size', { label: childLabel, value: { Physical: { width: Math.round(900 * scale), height: Math.round(480 * scale) } } }, child);
await note('右侧内容', 600, 48, child);
await cut(child, 'vertical', 430);
await expect.poll(async () => (await invoke('load_document')).boards.length).toBe(3);
saved = await invoke('load_document');
assert.equal(saved.items.length, 4);
assert.equal(saved.items.find(i => i.text === '右侧内容').boardId, saved.boards[2].id);
assert(saved.items.find(i => i.text === '右侧内容').position.x > 100);
console.log('PASS: vertical scissor gesture assigns content by position without loss');
await expect.poll(() => context.pages().filter(p => !p.url().includes("overlay=")).length).toBe(3);
for (const target of context.pages().filter(p => !p.url().includes("overlay="))) await expect(target.getByText('已保存', { exact: true })).toBeVisible();
const closed = page.waitForEvent('close', { timeout: 10_000 });
await invoke('quit_app');
await closed;
await browser.close();
