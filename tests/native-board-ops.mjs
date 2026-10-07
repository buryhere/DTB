import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]??'.native-interaction-test-data/board-ops-20261006');assert(root.startsWith(resolve('.native-interaction-test-data')+'\\'));
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'),context=browser.contexts()[0];
const page=context.pages().find(p=>!p.url().includes('overlay=')),control=context.pages().find(p=>p.url().includes('overlay=icons'));
const invoke=(name,args={},target=control)=>target.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
assert.equal(await invoke('plugin:app|identifier'),'com.desktopboard.interactiontest');
let doc=await invoke('load_document');assert.equal(doc.items.length,0);assert.equal(doc.boards.length,1);
if(!doc.settings.onboardingDone)await page.getByText('\u6682\u4e0d\u5f00\u542f').click();
async function note(target,text,x,y,commit=true){await target.locator('.editor-line').nth(roundRow(y)).click({position:{x:Math.max(0,x-24),y:12}});await target.keyboard.insertText(text);if(commit)await expect(target.getByText('\u5df2\u4fdd\u5b58',{exact:true})).toBeVisible();}
const roundRow=y=>Math.round(y/24);
async function scissors(target){await target.getByLabel('\u7ed8\u56fe\u4e0e\u88c1\u526a').click();await target.getByLabel('\u526a\u5200\u88c1\u526a').click();}
const boardPage=async label=>{let found;await expect.poll(async()=>{for(const p of context.pages().filter(p=>!p.url().includes('overlay=')))if(await p.evaluate(()=>window.__TAURI_INTERNALS__?.metadata.currentWindow.label).catch(()=>null)===label){found=p;return true;}return false;}).toBe(true);await expect(found.locator('main')).toBeVisible();return found;};
try {
 await note(page,'top original',80,48);await note(page,'lower original',80,384);const originalItems=(await invoke('load_document')).items;
 await page.getByLabel('\u7ed8\u56fe\u4e0e\u88c1\u526a').click();await page.getByRole('button',{name:'\u94c5\u7b14\u7ed8\u753b',exact:true}).click();
 const surface=await page.locator('.drawing-surface').boundingBox();
 for(const y of [100,400]){await page.mouse.move(surface.x+40,surface.y+y);await page.mouse.down();await page.mouse.move(surface.x+150,surface.y+y+10,{steps:8});await page.mouse.up();}
 await expect(page.locator('.ink-free')).toHaveCount(2);await expect(page.getByText('\u5df2\u4fdd\u5b58',{exact:true})).toBeVisible();
 await scissors(page);let cut;await expect.poll(()=>{cut=context.pages().find(p=>p.url().includes('overlay=cut'));return !!cut;}).toBe(true);await expect(cut.getByLabel('\u5c4f\u5e55\u88c1\u526a\u533a\u57df')).toBeVisible();
 let scene=await invoke('cut_scene');const local=(x,y)=>({x:(x-scene.origin.x)/scene.scale,y:(y-scene.origin.y)/scene.scale});let start=local(scene.paper.x-15,scene.paper.y+40*scene.scale);
 await cut.mouse.move(start.x,start.y);await cut.mouse.down();await cut.mouse.move(start.x-20,start.y+30,{steps:5});await expect(cut.locator('.cut-trail')).toHaveAttribute('points',/[\d.]+,[\d.]+ /);await expect(cut.locator('.cut-glass')).toHaveCSS('cursor',/url/);await expect(cut.locator('.cut-hint')).toHaveCSS('opacity','0.7');
 await cut.mouse.click(start.x,start.y,{button:'right'});await expect.poll(()=>context.pages().some(p=>p.url().includes('overlay=cut'))).toBe(false);assert.equal((await invoke('load_document')).boards.length,1);
 console.log('PASS global scissor cursor and trail outside paper, right cancel');
 await scissors(page);await expect.poll(()=>{cut=context.pages().find(p=>p.url().includes('overlay=cut'));return !!cut;}).toBe(true);await expect(cut.getByLabel('\u5c4f\u5e55\u88c1\u526a\u533a\u57df')).toBeVisible();scene=await invoke('cut_scene');
 start=local(scene.paper.x-15,scene.paper.y+288*scene.scale);const end=local(scene.paper.x+scene.paper.w+15,scene.paper.y+288*scene.scale);
 await cut.mouse.move(start.x,start.y);await cut.mouse.down();await cut.mouse.move(end.x,end.y,{steps:24});await expect(cut.locator('.cut-line')).toHaveCount(1);await cut.mouse.up();
 await expect.poll(async()=>(await invoke('load_document')).boards.length).toBe(2);
 doc=await invoke('load_document');const child=doc.boards.find(b=>b.id!=='main'),childPage=await boardPage('board-'+child.id);
 assert.equal(doc.boards[0].ink.length,1);assert.equal(child.ink.length,1);
 const lowerBefore=doc.items.find(i=>i.text==='lower original');assert.equal(lowerBefore.boardId,child.id);
 console.log('PASS global outside-to-outside cut creates two boards and partitions contents');
 await note(childPage,'unsaved merge draft',180,168,false);
 execFileSync('attrib',['+R',resolve(root,'board.json')]);
 try {
   await assert.rejects(invoke('board_operation',{label:'main',action:'merge',sourceId:child.id}));
   await expect(childPage.locator('.paper-editor')).toContainText('unsaved merge draft');assert.equal((await invoke('load_document')).boards.length,2);
 } finally {execFileSync('attrib',['-R',resolve(root,'board.json')]);}
 console.log('PASS failed save cancels merge and keeps the unsaved draft');
 await invoke('board_operation',{label:'main',action:'merge',sourceId:child.id});
 await expect.poll(async()=>(await invoke('load_document')).boards.length).toBe(1);doc=await invoke('load_document');assert.equal(doc.items.length,3);assert(doc.items.some(i=>i.text==='unsaved merge draft'));for(const original of originalItems)assert.deepEqual(doc.items.find(i=>i.id===original.id).position,original.position);
 await expect(page.getByText('unsaved merge draft',{exact:true})).toBeVisible();assert(doc.items.every(i=>i.boardId==='main'));assert.equal(doc.boards[0].ink.length,2);await expect(page.locator('.ink-free')).toHaveCount(2);
 console.log('PASS merge saves source draft, restores split positions, preserves all item IDs');
 await invoke('board_operation',{label:'main',action:'delete',sourceId:null});doc=await invoke('load_document');assert.equal(doc.boards.length,0);assert.equal(doc.items.length,0);assert.equal(doc.archive.length,3);assert.equal(doc.deletedBoards[0].board.id,'main');
 console.log('PASS delete last board archives all contents and keeps tray host');
 await invoke('board_operation',{label:'tray',action:'new',sourceId:null});doc=await invoke('load_document');await boardPage('board-'+doc.boards[0].id);
 await invoke('board_operation',{label:'tray',action:'restore',sourceId:'main'});await boardPage('main');doc=await invoke('load_document');assert.equal(doc.boards.length,2);assert.equal(doc.items.length,3);assert.equal(doc.archive.length,0);assert.equal(doc.deletedBoards.length,0);
 console.log('PASS new board and restore deleted board after deleting main');
 const disk=JSON.parse(readFileSync(resolve(root,'board.json')));assert.equal(disk.items.length,3);assert.equal(disk.boards.length,2);
} finally {
 const scene=await invoke('cut_scene').catch(()=>null);if(scene)await invoke('finish_cut',{token:scene.token,gesture:null}).catch(()=>{});
 await invoke('quit_app').catch(()=>{});await browser.close();
}
