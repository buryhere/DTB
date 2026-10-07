// Run against the final EXE with an empty, isolated release data directory.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]??'');assert(root.startsWith(resolve('.native-release-test-data')+'\\'));
let browser;await expect.poll(async()=>{try{browser=await chromium.connectOverCDP('http://127.0.0.1:9224',{timeout:1500});return true}catch{return false}},{timeout:15000}).toBe(true);
const context=browser.contexts()[0],page=context.pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);assert.equal(await invoke('plugin:app|identifier'),'com.desktopboard.app');
let doc=await invoke('load_document');assert.equal(doc.items.length,0);assert.equal(doc.boards.length,1);
const saved=()=>expect(page.getByText('已保存',{exact:true})).toBeVisible();
async function tool(name){await page.getByLabel('绘图与裁剪').click();await page.locator('.tools-menu').getByRole('button',{name,exact:true}).click();}
async function textBox(text){return page.locator('.paper-editor').evaluate((editor,text)=>{const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode())){if(n.parentElement.closest('[data-atom]'))continue;const start=n.textContent.indexOf(text);if(start>=0){const range=document.createRange();range.setStart(n,start);range.setEnd(n,start+text.length);const r=range.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}}throw Error('Missing text '+text);},text);}
try {
 const imported=await invoke('import_paths',{paths:[resolve('tests/fixtures/preview.pdf')],mode:'ref'}),fileId=crypto.randomUUID();
 doc.settings.onboardingDone=true;doc.boards[0].collision=false;doc.items=[{...imported[0],id:fileId,boardId:'main',position:{x:24,y:24},createdAt:new Date().toISOString()}];
 doc.boards[0].paperRows=[{id:'source',parts:[{text:'框选搬动😀'}],height:1},{id:'file',parts:[{itemId:fileId},{text:'一起移动'}],height:1},{id:'gap',parts:[],height:1},{id:'other',parts:[{text:' ',width:260},{text:'原位笔记'}],height:1}];
 doc.boards[0].ink=[{id:'ink',points:[{x:40,y:55},{x:140,y:55}]},{id:'fixed',points:[{x:240,y:220},{x:300,y:220}]}];
 await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.locator('.file-icon img')).toHaveCount(1);await saved();
 const original=await textBox('框选搬动😀'),fixed=await textBox('原位笔记'),paper=await page.locator('.paper-document').boundingBox(),before=await invoke('load_document');
 async function select(){await page.mouse.move(paper.x+23,paper.y+1);await page.mouse.down();await page.mouse.move(paper.x+210,paper.y+63,{steps:6});await expect(page.getByLabel('框选虚线框')).toBeVisible();await page.mouse.up();await expect(page.getByLabel('框选落点预览')).toBeVisible();}
 await tool('框选移动');await select();await page.mouse.move(paper.x+290,paper.y+300);await page.waitForTimeout(700);await saved();const pending=JSON.parse(readFileSync(resolve(root,'board.json')));assert.deepEqual(pending.items,before.items);assert.deepEqual(pending.boards[0].ink,before.boards[0].ink);
 await page.mouse.click(paper.x+290,paper.y+300,{button:'right'});await expect(page.getByLabel('框选区域')).toBeVisible();await expect(page.getByLabel('整板编辑区')).toContainText('框选搬动😀');
 await select();await page.mouse.move(paper.x+290,paper.y+300);const ghost=await page.locator('.ghost-text').first().boundingBox();await page.mouse.click(paper.x+290,paper.y+300);await expect(page.getByLabel('框选落点预览')).toHaveCount(0);await saved();const moved=await textBox('框选搬动😀');assert(Math.abs(moved.x-ghost.x)<.1);assert(Math.abs((moved.y-original.y)%24)<.1);assert.deepEqual(await textBox('原位笔记'),fixed);
 const disk=JSON.parse(readFileSync(resolve(root,'board.json')));assert.equal(disk.items.filter(i=>i.id===fileId).length,1);assert.equal(disk.boards[0].ink.length,2);assert.deepEqual(disk.boards[0].ink.find(s=>s.id==='fixed'),before.boards[0].ink.find(s=>s.id==='fixed'));
 await page.keyboard.press('Control+z');await expect(page.locator('[data-row=source]')).toContainText('框选搬动😀');await page.keyboard.press('Control+y');assert.deepEqual(await textBox('框选搬动😀'),moved);await saved();await page.reload();assert.deepEqual(await textBox('框选搬动😀'),moved);assert.deepEqual(await textBox('原位笔记'),fixed);
 console.log('PASS release marquee: mixed text/PDF/ink, destination ghost, original autosave, right reselect, undo/redo and disk/reload');
 // Exercise real mother/child window creation through the cross-window barrier.
 await page.getByLabel('更多工具').click();await page.getByText('外观与设置').click();await page.getByLabel('背景颜色',{exact:true}).fill('#e8f2ff');await page.getByLabel('下划线间距',{exact:true}).evaluate(node=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,'40');node.dispatchEvent(new Event('input',{bubbles:true}));});await page.getByRole('button',{name:'完成',exact:true}).click();await saved();
 await invoke('board_operation',{label:'main',action:'new',sourceId:null});
 await expect.poll(async()=>(await invoke('load_document')).boards.length).toBe(2);
 doc=await invoke('load_document');const mother=doc.boards.find(b=>b.id==='main'),child=doc.boards.find(b=>b.id!=='main');let childPage;
 await expect.poll(async()=>{for(const candidate of context.pages()){if(candidate.url().includes('overlay='))continue;try{if(await candidate.evaluate(()=>window.__TAURI_INTERNALS__?.metadata.currentWindow.label)==='board-'+child.id){childPage=candidate;return true;}}catch{}}return false;},{timeout:15000}).toBe(true);
 await expect(childPage.getByLabel('整板编辑区')).toBeVisible();await expect(childPage.locator('main')).toHaveCSS('--line-height','40px');await expect(childPage.locator('main')).toHaveCSS('--paper-rgb','232, 242, 255');await expect(childPage.getByLabel('整板编辑区')).not.toContainText('框选搬动😀');
 doc=await invoke('load_document');const created=doc.boards.find(b=>b.id===child.id);for(const key of ['theme','grid','level','autoFade','collision','edgeHide'])assert.deepEqual(created[key],mother[key]);assert.equal(doc.items.filter(i=>i.boardId===child.id).length,0);assert.equal(created.ink?.length??0,0);
 console.log('PASS release new child inherits mother theme/spacing/preferences with empty contents');
 // Removing distant content retracts paper while the native outer size stays put.
 await invoke('board_operation',{label:'board-'+child.id,action:'delete',sourceId:null});
 doc=await invoke('load_document');const board=doc.boards[0];board.paperRows=Array.from({length:100},(_,i)=>({id:'r'+i,parts:i===0?[{text:'保留'}]:i===50?[{text:'清除远端'}]:[],height:1}));board.ink=[{id:'distant',points:[{x:40,y:1200},{x:100,y:1200}]}];
 await invoke('save_board',{board,items:[],settings:doc.settings,origin:'fixture'});await page.reload();await saved();const nativeBounds=(await invoke('load_document')).boards[0].bounds;
 await tool('文字橡皮擦');await page.locator('.paper').evaluate(p=>p.scrollTop=1850);const target=await textBox('清除远端');await page.mouse.move(target.x-5,target.y+target.h/2);await page.mouse.down();await page.mouse.move(target.x+target.w+5,target.y+target.h/2,{steps:6});await page.mouse.up();await expect(page.getByLabel('整板编辑区')).not.toContainText('清除远端');await expect.poll(()=>JSON.parse(readFileSync(resolve(root,'board.json'))).boards[0].paperRows.length).toBe(31);await saved();
 const shrunk=JSON.parse(readFileSync(resolve(root,'board.json'))).boards[0];assert.equal(shrunk.paperRows.length,31);assert.deepEqual(shrunk.bounds,nativeBounds);assert.equal(shrunk.ink.length,1);
 await tool('铅笔橡皮擦');await page.locator('.paper').evaluate(p=>p.scrollTop=850);const surface=await page.getByLabel('铅笔橡皮擦区域').boundingBox();await page.mouse.move(surface.x+35,surface.y+1200);await page.mouse.down();await page.mouse.move(surface.x+105,surface.y+1200,{steps:6});await page.mouse.up();await expect(page.locator('.ink-layer polyline')).toHaveCount(0);await expect.poll(()=>JSON.parse(readFileSync(resolve(root,'board.json'))).boards[0].ink.length).toBe(0);await saved();
 const empty=JSON.parse(readFileSync(resolve(root,'board.json'))).boards[0];assert.equal(empty.ink.length,0);assert(empty.paperRows.length<20);assert.deepEqual(empty.bounds,nativeBounds);
 console.log('PASS release paper tail retraction protects ink, removes unused rows and preserves native window dimensions');
} finally {await invoke('quit_app').catch(()=>{});await browser.close();}
