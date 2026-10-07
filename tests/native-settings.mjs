// Requires the same isolated launch configuration as native-interaction.mjs.
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const port=Number(process.argv[3]??9222);assert([9222,9224].includes(port));
if(port===9224||process.argv[2])assert(resolve(process.argv[2]??'').startsWith(resolve(port===9224?'.native-release-test-data':'.native-interaction-test-data')+'\\'));
let browser;await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:15000}).toBe(true);
const page = browser.contexts()[0].pages().find(p => !p.url().includes("overlay=icons"));
await page.waitForFunction(() => window.__TAURI_INTERNALS__?.invoke);
const invoke = (name, args = {}) => page.evaluate(({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args), { name, args });
assert.equal(await invoke('plugin:app|identifier'),port===9224?'com.desktopboard.app':'com.desktopboard.interactiontest');
try {
let doc = await invoke('load_document'); assert.equal(doc.items.length, 0);
if (!doc.settings.onboardingDone) await page.getByText('暂不开启').click();
await expect(page.getByText('已保存', { exact: true })).toBeVisible();
const shortcut = execFileSync('powershell', ['-NoProfile', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-ChildItem -LiteralPath (Join-Path $env:USERPROFILE 'Desktop') -Filter '*.lnk' | Select-Object -First 1 -ExpandProperty FullName"], { encoding: 'utf8', windowsHide: true }).trim();
assert(shortcut, 'A desktop shortcut is needed to verify a real Shell icon.');
const paths = [shortcut, resolve('tests/fixtures/preview.pdf')];
const imported = await invoke('import_paths', { paths, mode: 'ref' });
doc = await invoke('load_document');
doc.items = imported.map((item, n) => ({ ...item, id: crypto.randomUUID(), boardId: 'main', position: { x: 80 + n * 180, y: 96 }, createdAt: new Date().toISOString() }));
doc.boards[0].paperRows=[{id:'source',parts:[{text:'前'},{text:'        ',width:60},{itemId:doc.items[0].id},{text:'邻'},{text:'        ',width:60},{itemId:doc.items[1].id},{text:'尾'}],height:1},{id:'below',parts:[{text:'下面的笔记'}],height:1}];await invoke('save_board', { board: doc.boards[0], items: doc.items, settings: doc.settings, origin: 'fixture' });
await page.reload();
await expect(page.locator('.file-icon img')).toHaveCount(1);
await expect(page.locator('.document-compact .file-type')).toHaveText('PDF');
await expect.poll(() => page.locator('.file-icon img').evaluateAll(images => images.every(img => img.naturalWidth > 0))).toBe(true);
await expect(page.locator('.icon-only .file-name')).toHaveCount(0);
await page.getByLabel('更多工具').click(); await page.getByText('外观与设置').click();
await page.getByLabel('下划线间距', { exact: true }).evaluate(node => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, '48'); node.dispatchEvent(new Event('input', { bubbles: true })); });
await page.getByRole('button', { name: '完成', exact: true }).click();
await expect(page.locator('.named-file')).toHaveClass(/name-below/);
await expect(page.locator('.file-icon img')).toHaveCount(2);
await expect.poll(() => page.locator('.file-icon img').evaluateAll(images => images.every(img => img.naturalWidth > 0))).toBe(true);
const image = await page.locator('.named-file img').boundingBox(), name = await page.locator('.file-name').boundingBox();
assert(name.y >= image.y + image.height, 'PDF filename should be under the icon.');
await page.screenshot({ path: 'settings-check.png' });
console.log('PASS: real shortcut/PDF icons, shortcut label hidden, PDF label below with 48px rows');

await page.evaluate(() => {
  window.__openAttempts=0;
  const fetchOriginal=window.fetch;window.fetch=(input,init)=>{
    const url=String(input instanceof Request?input.url:input);
    if(url.startsWith('http://ipc.localhost/')&&url.split('?')[0].endsWith('/open_item')){window.__openAttempts++;return Promise.resolve(new Response('null',{status:200,headers:{'Content-Type':'application/json'}}));}
    return fetchOriginal(input,init);
  };
  const postOriginal=window.chrome.webview.postMessage.bind(window.chrome.webview);
  window.chrome.webview.postMessage=message=>{
    const data=typeof message==='string'?JSON.parse(message):message;
    if(data.cmd==='open_item'){window.__openAttempts++;window.__TAURI_INTERNALS__.runCallback(data.callback,null);return;}
    return postOriginal(message);
  };
});
await page.locator('.icon-only img').dblclick();await expect.poll(()=>page.evaluate(()=>window.__openAttempts)).toBe(1);
const textPositions=()=>page.locator('.paper-editor').evaluate(editor=>{const result={};const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode()))if(['前','邻','尾','下面的笔记'].includes(n.textContent)){const r=document.createRange();r.selectNodeContents(n);const b=r.getBoundingClientRect();result[n.textContent]={x:b.x,y:b.y};}return result;});
const textBefore=await textPositions();assert.equal(Object.keys(textBefore).length,4);
const lineBoxes=await page.locator('.editor-line').evaluateAll(lines=>lines.slice(0,2).map(n=>({y:n.getBoundingClientRect().y,h:n.getBoundingClientRect().height})));assert(Math.abs(lineBoxes[0].h-48)<.05);assert(Math.abs(lineBoxes[1].y-lineBoxes[0].y-48)<.05);
await page.evaluate(()=>window.__openAttempts=0);const atom=page.locator('.paper-atom:has(.icon-only)'),id=await atom.getAttribute('data-atom'),before=await atom.boundingBox(),destination=await page.locator('.editor-line').nth(7).boundingBox();
await page.mouse.move(before.x+8,before.y+8);await page.mouse.down();await page.mouse.move(destination.x+170,destination.y+12);await expect(page.locator('.paper-file-drag')).toBeVisible();await page.mouse.up();await expect(page.locator('.paper-file-drag')).toHaveCount(0);await expect(page.getByText('已保存',{exact:true})).toBeVisible();
const textAfter=await textPositions();for(const [text,b] of Object.entries(textBefore)){assert(Math.abs(textAfter[text].x-b.x)<.05);assert(Math.abs(textAfter[text].y-b.y)<.05);}
assert.equal((await invoke('load_document')).items.filter(i=>i.id===id).length,1);assert.equal(await page.evaluate(()=>window.__openAttempts),0);await page.keyboard.press('Control+z');await expect(page.getByText('已保存',{exact:true})).toBeVisible();
console.log('PASS: native immediate drag keeps text coordinates and underline spacing; double-click and undo remain available');
const icon = await page.locator('.icon-only img').boundingBox();
await page.getByLabel('锁定板子', { exact: true }).click();
await expect(page.getByLabel('解锁板子', { exact: true })).toBeVisible();
assert.equal(await invoke('plugin:window|is_resizable', { label: 'main' }), false);
await assert.rejects(invoke('drag_board', { label: 'main' }), /锁定/);
await page.mouse.dblclick(icon.x + 5, icon.y + 5); await page.keyboard.press('ArrowRight');
assert.equal(await page.evaluate(() => window.__openAttempts), 0);
await expect(page.getByText('已保存', { exact: true })).toBeVisible(); await page.reload();
await expect(page.getByLabel('解锁板子', { exact: true })).toBeVisible();
assert.equal(await invoke('plugin:window|is_resizable', { label: 'main' }), false);
await page.getByLabel('解锁板子', { exact: true }).click();
await expect(page.getByLabel('更多工具')).toBeEnabled();
assert.equal(await invoke('plugin:window|is_resizable', { label: 'main' }), true);
console.log('PASS: native lock blocks drag, resize and file launch; persists and unlocks');
// Shell icon association fixtures: these files are never opened in Office.
const fixtureRoot=resolve(process.argv[2]??'.native-interaction-test-data/native-settings-office');mkdirSync(fixtureRoot,{recursive:true});const fixtureDir=mkdtempSync(join(fixtureRoot,'office-'));
const officePaths=['季度汇报.pptx','年度预算.xlsx','项目方案.docx'].map(name=>{const path=join(fixtureDir,name);writeFileSync(path,'',{flag:'wx'});return path;});
const officeImports=await invoke('import_paths',{paths:[...officePaths,resolve('tests/fixtures/preview.pdf')],mode:'ref'});
doc=await invoke('load_document');doc.items=officeImports.map(i=>({...i,id:crypto.randomUUID(),boardId:'main',createdAt:new Date().toISOString()}));doc.boards[0].paperRows=doc.items.map((i,n)=>({id:'office'+n,parts:[{itemId:i.id}],height:1}));
await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.getByText('已保存',{exact:true})).toBeVisible();
for(const spacing of [16,24,48,64]){
 await page.getByLabel('更多工具').click();await page.getByText('外观与设置',{exact:true}).click();await page.getByLabel('下划线间距',{exact:true}).evaluate((node,n)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,String(n));node.dispatchEvent(new Event('input',{bubbles:true}));},spacing);await page.getByRole('button',{name:'完成',exact:true}).click();
 for(const item of doc.items){const atom=page.locator(`[data-atom="${item.id}"]`);if(spacing<40){await expect(atom.locator('.file-type')).toHaveText(item.ext.toUpperCase());await expect(atom.locator('.file-icon')).toHaveCount(0);}else{await expect(atom.locator('.file-icon img')).toBeVisible();await expect.poll(()=>atom.locator('img').evaluate(img=>img.naturalWidth)).toBeGreaterThan(0);const icon=await atom.locator('img').boundingBox(),label=await atom.locator('.file-name').boundingBox();assert(label.y>=icon.y+icon.height);}
 const cell=await atom.boundingBox(),label=await atom.locator('.file-name').boundingBox();assert(Math.abs(cell.height-spacing)<.05);assert(label.y>=cell.y-.05&&label.y+label.height<=cell.y+spacing+.05);}
 await page.screenshot({path:join(fixtureRoot,`office-${spacing}.png`)});
}
await expect(page.getByText('已保存',{exact:true})).toBeVisible();await page.reload();await expect(page.locator('.name-below')).toHaveCount(4);assert.equal((await invoke('load_document')).items.filter(i=>i.type==='file').length,4);
console.log('PASS: native Office/PDF compact badges, actual Shell icons with names below, 16–64px grid alignment and persistence');
}finally {await invoke('quit_app').catch(()=>{});await browser.close();}
