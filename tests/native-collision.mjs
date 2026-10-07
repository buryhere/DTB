// Temporarily substitutes the desktop icon layer. Only use the isolated identifier
// and a fresh DESKTOP_BOARD_DATA_DIR, following README.zh-CN.md.
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(process.argv[2] ?? '.native-interaction-test-data/collision-test');
assert(root.startsWith(resolve('.native-interaction-test-data') + '\\'), 'Use the isolated test directory.');
const journalPath = join(root, 'icon-recovery.json');
const journal = () => { try { return JSON.parse(readFileSync(journalPath)); } catch { return null; } };
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages().find(p => !p.url().includes('overlay=icons'));
await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
const overlay = browser.contexts()[0].pages().find(p => p.url().includes('overlay=icons'));
await overlay.evaluate(()=>window.__COLLISION_DIAGNOSTICS__=true);
await overlay.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'collision-scene',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.__collisionTestScene=e.payload)}));
const states = () => overlay.locator('canvas').evaluate(c => JSON.parse(c.dataset.states ?? '[]'));
const invoke = (name, args = {}) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
assert.equal(await invoke('plugin:app|identifier'), 'com.desktopboard.interactiontest');
let doc = await invoke('load_document'); assert.equal(doc.items.length, 0); assert.equal(doc.boards.length, 1); assert(!journal(), 'Start with a fresh test directory.');
const baseline = await invoke('read_icons'); assert.equal(baseline.autoArrange, false); assert.equal(baseline.visible, true);
const positions = icons => Object.fromEntries(icons.map(i => [i.id, { x: i.x, y: i.y }]));
const original = positions(baseline.icons);
const finishSettings=async()=>{if(await page.locator('.notice').count())await page.getByLabel('关闭提示').click();await page.getByRole('button',{name:'完成',exact:true}).click();};
writeFileSync(join(root, 'baseline.json'), JSON.stringify(baseline));
const move = (x, y) => invoke('plugin:window|set_position', { label: 'main', value: { Physical: { x, y } } });
const settled = () => expect.poll(async () => !!journal()?.clip && (await states()).some(s => s.active), { timeout: 12000 }).toBe(true);
let terminated = false;
try {
  if (!doc.settings.onboardingDone) await page.getByText('暂不开启').click();
  await invoke('plugin:window|set_size', { label: 'main', value: { Physical: { width: 300, height: 225 } } });
  await move(baseline.icons[0].x, baseline.icons[0].y);
  await expect(page.getByText('已保存', { exact: true })).toBeVisible();
  await page.getByLabel('更多工具').click(); await page.getByText('外观与设置').click();
  const toggle = page.getByText('桌面图标让位动画', { exact: true }).locator('input'); await toggle.click(); await expect(toggle).toBeChecked({ timeout: 12000 });
  await finishSettings(); await settled();
  const pushed = await invoke('read_icons');
  assert.deepEqual(positions(pushed.icons), original, 'Live physics keeps the native layout untouched.');
  const changed = (await states()).filter(s => s.active);
  assert(changed.length > 0);
  assert.equal(pushed.visible,true,'Explorer must keep displaying unaffected native icons.');
  const quality=await overlay.evaluate(async parent=>{
    const scene=window.__collisionTestScene;
    const sizes=await Promise.all(scene.icons.map(async i=>{const image=new Image();image.src=i.image;await image.decode();return image.naturalWidth}));
    const folder=scene.icons.find(i=>i.id.toLowerCase()===parent.toLowerCase());let yellowFraction=null;
    if(folder){const img=new Image();img.src=folder.image;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let yellow=0,opaque=0;for(let i=0;i<d.length;i+=4)if(d[i+3]>180){opaque++;if(d[i]>130&&d[i+1]>90&&d[i+2]<120)yellow++;}yellowFraction=yellow/Math.max(1,opaque);}
    return {minimum:Math.min(...sizes),maximum:Math.max(...sizes),larger:sizes.filter(n=>n>=scene.iconSize*2).length,total:sizes.length,yellowFraction};
  },resolve('..'));
  assert(quality.larger>quality.total*.8,'Shell must supply higher-resolution images for most desktop items.');
  if(quality.yellowFraction!==null)assert(quality.yellowFraction>.15,'The project folder must remain a folder icon, not a white document.');
  console.log('PASS: absolute Shell image binding and higher-resolution sprites',quality);
  for (const s of await states()) if (!s.active) assert.deepEqual({x:s.x,y:s.y}, original[s.id]);
  const image = await overlay.screenshot({path:join(root,'physics-visible.png')});
  const colored = await overlay.evaluate(async data => {
    const img=new Image();img.src='data:image/png;base64,'+data;await img.decode();
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;
    const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const bytes=ctx.getImageData(0,0,c.width,c.height).data;
    let count=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i]+bytes[i+1]+bytes[i+2]>90)count++;return count;
  }, image.toString('base64'));
  assert(colored>500,'A populated canvas must also appear in the WebView compositor screenshot, rather than a blank desktop.');
  console.log(`PASS: ${changed.length} contour bodies displaced; unaffected bodies stay home; composited icons visible (${colored} colored pixels)`);
  let maxRotation=0;
  for(let i=0;i<24;i++){
    await move(20+i*14,2+i*8);await page.waitForTimeout(30);
    const frame=await states();maxRotation=Math.max(maxRotation,...frame.map(s=>Math.abs(s.angle)));
    assert(frame.length===baseline.icons.length,'No desktop icons vanish during movement.');
  }
  assert(maxRotation>.01,'Moving contacts must generate visible rotation.');
  await overlay.screenshot({path:join(root,'physics-rotation.png')});
  console.log(`PASS: continuous collision displacement and contact rotation (${(maxRotation*180/Math.PI).toFixed(1)} degrees)`);

  await move(-1000, 300);
  await expect.poll(async () => positions((await invoke('read_icons')).icons), { timeout: 15000 }).toEqual(original);
  await expect.poll(() => !!journal()?.clip, {timeout:15000}).toBe(false);
  console.log('PASS: moving the board away returns every managed icon home');

  await move(baseline.icons[0].x, baseline.icons[0].y); await settled();
  await page.getByLabel('锁定板子', { exact: true }).click();
  await expect(page.getByLabel('解锁板子', { exact: true })).toBeVisible();
  assert.equal((await invoke('load_document')).boards[0].collision, true);
  await move(115, 246); await settled();
  assert.equal((await invoke('load_document')).boards[0].locked, true);
  await page.getByLabel('解锁板子', { exact: true }).click();
  console.log('PASS: lock retains the collision effect and still unlocks');

  await invoke('restore_icons');
  await expect.poll(async () => positions((await invoke('read_icons')).icons)).toEqual(original);
  await expect.poll(async () => (await invoke('load_document')).boards[0].collision).toBe(false);
  // Re-enable after manual restoration, exercising a fresh guard token.
  await page.getByLabel('更多工具').click(); await page.getByText('外观与设置').click(); await toggle.click(); await expect(toggle).toBeChecked({ timeout: 12000 }); await finishSettings(); await settled();
  console.log('PASS: manual restoration and re-enabling start a fresh guarded session');

  const guardToken = journal().token;
  const guardPid = Number(execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name = 'desktop-board.exe'" | Where-Object { $_.CommandLine -like '*--icon-guard*' -and $_.CommandLine -like '*${guardToken}*' } | Select-Object -ExpandProperty ProcessId`], { encoding: 'utf8', windowsHide: true }).trim());
  assert(guardPid > 0 && guardPid !== journal().pid); process.kill(guardPid, 'SIGKILL');
  await expect.poll(async () => positions((await invoke('read_icons')).icons), { timeout: 8000 }).toEqual(original);
  await expect.poll(async () => (await invoke('load_document')).boards[0].collision).toBe(false);
  if (await page.locator('.notice').count()) await page.getByLabel('关闭提示').click();
  await page.getByLabel('更多工具').click(); await page.getByText('外观与设置').click(); await toggle.click(); await expect(toggle).toBeChecked({ timeout: 12000 }); await finishSettings(); await settled();
  console.log('PASS: loss of the guard stops animation, restores positions and permits a fresh guarded session');

  await move(400, 246);
  await expect.poll(() => !!journal()?.clip, { timeout: 5000, intervals: [10, 20, 20, 20] }).toBe(true);
  const hostPid = journal().pid;
  // The identifier, fresh test root and journal have all been checked above.
  process.kill(hostPid, 'SIGKILL'); terminated = true;
  await expect.poll(() => { const j = journal(); return j && !j.hidden && !j.clip && Object.keys(j.entries).length === 0; }, { timeout: 10000 }).toBe(true);
  await browser.close().catch(() => {});
  const verifierRoot = join(resolve('.native-interaction-test-data'), `collision-verifier-${Date.now()}`);
  const verifier = spawn(resolve('src-tauri/target/debug/desktop-board.exe'), [], { windowsHide: true, env: { ...process.env, DESKTOP_BOARD_DATA_DIR: verifierRoot, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' } });
  let check;
  await expect.poll(async () => { try { check = await chromium.connectOverCDP('http://127.0.0.1:9223', { timeout: 2000 }); return true; } catch { return false; } }, { timeout: 10000 }).toBe(true);
  const target = check.contexts()[0].pages().find(p => !p.url().includes('overlay'));
  await target.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
  const after = await target.evaluate(() => window.__TAURI_INTERNALS__.invoke('read_icons'));
  assert.equal(after.visible, true); assert.deepEqual(positions(after.icons), original);
  const close = target.waitForEvent('close'); await target.evaluate(() => window.__TAURI_INTERNALS__.invoke('quit_app')); await close; await check.close(); verifier.unref();
  console.log('PASS: forced termination during a hidden frame restores the icon layer and all original positions');
} catch(error) {
  try { writeFileSync(join(root,'physics-failure.json'),JSON.stringify(await overlay.locator('canvas').evaluate(c=>({...c.dataset})),null,2)); } catch{}
  throw error;
} finally {
  if (!terminated) { await invoke('restore_icons').catch(() => {}); await invoke('quit_app').catch(() => {}); await browser.close().catch(() => {}); }
  if (terminated && journal()?.entries && Object.keys(journal().entries).length) {
    spawn(resolve('src-tauri/target/debug/desktop-board.exe'), ['--restore-desktop-icons', '--root', root], { windowsHide: true }).unref();
  }
}
