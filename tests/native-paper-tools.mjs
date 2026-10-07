// Continuous editor and partial eraser persistence in the Windows WebView.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const port=Number(process.argv[3]??9222);assert([9222,9224].includes(port));
const root=resolve(process.argv[2]??'');assert(root.startsWith(resolve(port===9224?'.native-release-test-data':'.native-interaction-test-data')+'\\'));
let browser;await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:15000}).toBe(true);
const context=browser.contexts()[0],page=context.pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);assert.equal(await invoke('plugin:app|identifier'),port===9224?'com.desktopboard.app':'com.desktopboard.interactiontest');
let doc=await invoke('load_document');assert.equal(doc.items.length,0);assert.equal(doc.boards.length,1);
const saved=()=>expect(page.getByText('已保存',{exact:true})).toBeVisible();
async function tool(name){await page.getByLabel('绘图与裁剪').click();await page.locator('.tools-menu').getByRole('button',{name,exact:true}).click();}
async function textX(text){return page.locator('.paper-editor').evaluate((editor,text)=>{const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){const offset=n.textContent.indexOf(text);if(offset>=0){const r=document.createRange();r.setStart(n,offset);r.setEnd(n,offset+text.length);return r.getBoundingClientRect().left;}}throw Error('Missing text');},text);}
try {
 if(!doc.settings.onboardingDone)await page.getByText('暂不开启').click();
 const line=page.locator('.editor-line').nth(2),box=await line.boundingBox();await line.click({position:{x:280,y:12}});await page.keyboard.insertText('原有信息');await saved();const anchor=await textX('原有信息');assert(Math.abs(anchor-box.x-280)<.5);
 await line.click({position:{x:80,y:12}});for(const text of ['中','文','a','b']){await page.keyboard.insertText(text);assert(Math.abs(await textX('原有信息')-anchor)<.2,'Earlier writing moved the anchored note.');}
 await page.keyboard.press('Backspace');assert(Math.abs(await textX('原有信息')-anchor)<.2);await saved();await page.reload();await expect(page.getByLabel('整板编辑区')).toContainText('原有信息');assert(Math.abs(await textX('原有信息')-anchor)<.2);
 console.log('PASS native arbitrary writing, inline Chinese/Latin buffer, deletion and reload');
 await tool('铅笔绘画');const b=await page.getByLabel('铅笔绘画区域').boundingBox();await page.keyboard.down('Shift');await page.mouse.move(b.x+40,b.y+132);await page.mouse.down();await page.mouse.move(b.x+300,b.y+132);await page.mouse.up();await page.keyboard.up('Shift');await expect(page.locator('.ink-line')).toHaveCount(1);
 await tool('铅笔橡皮擦');await page.mouse.move(b.x+170,b.y+110);await page.mouse.down();await page.mouse.move(b.x+170,b.y+153,{steps:10});await page.mouse.up();await expect(page.locator('.ink-line')).toHaveCount(2);await page.keyboard.press('Control+z');await expect(page.locator('.ink-line')).toHaveCount(1);await page.keyboard.press('Control+y');await expect(page.locator('.ink-line')).toHaveCount(2);await saved();
 const disk=JSON.parse(readFileSync(resolve(root,'board.json')));assert.equal(disk.boards[0].ink.length,2);assert(disk.boards[0].paperRows.some(r=>r.parts.some(p=>p.width>0)));
 await page.reload();await expect(page.locator('.ink-line')).toHaveCount(2);await expect(page.getByLabel('整板编辑区')).toContainText('原有信息');
 console.log('PASS native partial eraser, shared undo/redo and disk/reload persistence');
 // Seed a fresh layout inside this same isolated document; files and strokes
 // must remain present when a single text gesture crosses two scattered notes.
 doc=await invoke('load_document');const imported=await invoke('import_paths',{paths:[resolve('tests/fixtures/preview.pdf')],mode:'ref'}),fileId=crypto.randomUUID();
 doc.items=[{...imported[0],id:fileId,boardId:'main',position:{x:24,y:24},createdAt:new Date().toISOString()}];doc.boards[0].paperRows=[{id:'first',parts:[{text:'文字橡皮擦测试'},{text:'                  ',width:140},{text:'保留笔记'}],height:1},{id:'file',parts:[{itemId:fileId}],height:1},{id:'gap',parts:[],height:1},{id:'corner',parts:[{text:'                       ',width:180},{text:'角落文字'}],height:1}];
 await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.locator('.file-icon img')).toHaveCount(1);await saved();
 const boxOf=text=>page.locator('.paper-editor').evaluate((editor,text)=>{const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){if(n.parentElement.closest('[data-atom]'))continue;const start=n.textContent.indexOf(text);if(start>=0){const r=document.createRange();r.setStart(n,start);r.setEnd(n,start+text.length);const b=r.getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height};}}throw Error('Missing text');},text);
 const first=await boxOf('文字橡皮擦测试'),corner=await boxOf('角落文字'),anchorBox=await boxOf('保留笔记'),fileBox=await page.locator('[data-atom]').boundingBox(),inkBefore=(await invoke('load_document')).boards[0].ink;
 await tool('文字橡皮擦');await page.mouse.move(first.x-12,first.y+first.h/2);await page.mouse.down();await page.mouse.move(first.x+first.w+12,first.y+first.h/2);await page.mouse.move(corner.x-12,corner.y+corner.h/2);await page.mouse.move(corner.x+corner.w+12,corner.y+corner.h/2);await page.mouse.up();await saved();
 await expect(page.getByLabel('整板编辑区')).not.toContainText('文字橡皮擦测试');await expect(page.getByLabel('整板编辑区')).not.toContainText('角落文字');assert.deepEqual(await boxOf('保留笔记'),anchorBox);assert.deepEqual(await page.locator('[data-atom]').boundingBox(),fileBox);let erased=await invoke('load_document');assert.deepEqual(erased.boards[0].ink,inkBefore);assert.equal(erased.items.filter(i=>i.id===fileId).length,1);
 await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).toContainText('角落文字');await expect(page.getByLabel('整板编辑区')).toContainText('文字橡皮擦测试');await page.keyboard.press('Control+y');await expect(page.getByLabel('整板编辑区')).not.toContainText('角落文字');await saved();await page.reload();await expect(page.getByLabel('整板编辑区')).not.toContainText('文字橡皮擦测试');assert.deepEqual(await boxOf('保留笔记'),anchorBox);
 // Right cancellation rolls back a preview instead of committing another erase.
 await tool('文字橡皮擦');await page.mouse.move(anchorBox.x,anchorBox.y+anchorBox.h/2);await page.mouse.down();await expect(page.getByLabel('整板编辑区')).not.toContainText('保留笔记');await page.mouse.click(anchorBox.x,anchorBox.y+anchorBox.h/2,{button:'right'});await page.mouse.up();await expect(page.getByLabel('整板编辑区')).toContainText('保留笔记');await expect(page.locator('.drawing-surface')).toHaveCount(0);await saved();
 console.log('PASS native separate text eraser: scattered notes, files/ink/positions preserved, whole-gesture undo/redo/reload and right cancellation');
} finally {await invoke('quit_app').catch(()=>{});await browser.close();}
