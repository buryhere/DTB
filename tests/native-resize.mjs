// Native size changes with an isolated development or release data root.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(process.argv[2]??''),release=root.startsWith(resolve('.native-release-test-data')+'\\');
assert(release||root.startsWith(resolve('.native-interaction-test-data')+'\\'));
const port=Number(process.argv[3]??(release?9224:9222));assert.equal(port,release?9224:9222);
let browser;await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:60000}).toBe(true);
const page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);assert.equal(await invoke('plugin:app|identifier'),release?'com.desktopboard.app':'com.desktopboard.interactiontest');
let doc=await invoke('load_document');assert.equal(doc.boards.length,1);assert.equal(doc.items.length,0);
const saved=()=>expect(page.getByText('已保存',{exact:true})).toBeVisible();
function assertGeometry(actual,expected){
 assert.equal(actual.glyphs.length,expected.glyphs.length);assert.equal(actual.atoms.length,expected.atoms.length);assert.deepEqual(actual.ink,expected.ink);
 for(const group of ['glyphs','atoms'])actual[group].forEach((value,i)=>{const before=expected[group][i];assert.equal(value.text??value.id,before.text??before.id);for(const key of ['x','y','w','h'])assert(Math.abs(value[key]-before[key])<.001,`${group}[${i}] ${key}: ${value[key]} versus ${before[key]}`);});
}
async function stableGeometry(expected){await expect.poll(async()=>{try{assertGeometry(await geometry(),expected);return true}catch{return false}}).toBe(true);assertGeometry(await geometry(),expected);}
async function geometry(){return page.locator('.paper-document').evaluate(paper=>{const origin=paper.getBoundingClientRect(),editor=paper.querySelector('.paper-editor'),glyphs=[],segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'}),walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n;
 while((n=walker.nextNode())){if(n.parentElement.closest('[data-atom]'))continue;for(const {segment,index} of segmenter.segment(n.textContent)){if(!segment.trim())continue;const range=document.createRange();range.setStart(n,index);range.setEnd(n,index+segment.length);const r=range.getBoundingClientRect();glyphs.push({text:segment,x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height});}}
 const atoms=[...editor.querySelectorAll('[data-atom]')].map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.atom,x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height};});const ink=[...paper.querySelectorAll('.ink-layer[aria-label] polyline')].map(n=>n.getAttribute('points'));return {glyphs,atoms,ink};});}
try {
 doc.settings.onboardingDone=true;doc.boards[0].collision=false;
 const imported=await invoke('import_paths',{paths:[resolve('tests/fixtures/preview.pdf')],mode:'ref'}),fileId=crypto.randomUUID();
 doc.items=[{...imported[0],id:fileId,boardId:'main',createdAt:new Date().toISOString()}];
 doc.boards[0].paperRows=[{id:'first',parts:[{text:'开头'+'W'.repeat(62)},{itemId:fileId},{text:'Z'.repeat(38)+'结尾'}],height:3},{id:'gap',parts:[],height:1},{id:'later',parts:[{text:' ',width:220},{text:'原位笔记'}],height:1}];doc.boards[0].ink=[{id:'stroke',points:[{x:180,y:120},{x:290,y:120}]}];
 await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.locator('.file-type')).toHaveText('PDF');await saved();
 const before=await geometry(),initial=(await invoke('load_document')).boards[0].bounds,scale=(await invoke('load_document')).boards[0].display.scaleFactor;
 const narrow={w:Math.round(280*scale),h:Math.round(220*scale)};
 for(const [w,h] of [[initial.w+200,initial.h],[initial.w+350,initial.h+170],[narrow.w,narrow.h],[initial.w,initial.h]]){
  await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:Math.round(w),height:Math.round(h)}}});
  await expect.poll(async()=>{const b=(await invoke('load_document')).boards[0].bounds;return [b.w,b.h]}).toEqual([w,h]);await stableGeometry(before);
 }
 console.log('PASS native resize: widen, lengthen, narrow below original and restore; glyph/PDF/ink coordinates unchanged');
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:narrow.w,height:narrow.h}}});await expect.poll(async()=>(await invoke('load_document')).boards[0].bounds.w).toBe(narrow.w);
 await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollWidth-p.clientWidth)).toBeGreaterThan(50);const view=await page.locator('.paper').boundingBox();await page.mouse.move(view.x+view.width/2,view.y+view.height/2);await page.keyboard.down('Shift');await page.mouse.wheel(0,100);await page.keyboard.up('Shift');await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);assertGeometry(await geometry(),before);
 await page.locator('.paper').evaluate(p=>{p.scrollLeft=0;p.scrollTop=p.scrollHeight;});await page.mouse.wheel(0,100);await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);await page.reload();await expect(page.locator('.file-type')).toHaveText('PDF');assertGeometry(await geometry(),before);
 console.log('PASS native narrow-window horizontal overflow, Shift wheel, wheel at vertical boundary and reload');
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:Math.round(initial.w+350),height:Math.round(initial.h+170)}}});await expect.poll(async()=>(await invoke('load_document')).boards[0].bounds.w).toBe(initial.w+350);await page.reload();await expect(page.locator('.file-type')).toHaveText('PDF');assertGeometry(await geometry(),before);
 const paper=await page.locator('.paper-document').boundingBox();await page.mouse.click(paper.x+650,paper.y+12);await page.keyboard.insertText('新增区域');await expect(page.getByLabel('整板编辑区')).toContainText('新增区域');
 const after=await geometry();assertGeometry({...after,glyphs:after.glyphs.filter(g=>!['新','增','区','域'].includes(g.text))},before);
 await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).not.toContainText('新增区域');await stableGeometry(before);
 await page.keyboard.press('Control+y');await expect(page.getByLabel('整板编辑区')).toContainText('新增区域');await expect.poll(()=>JSON.parse(readFileSync(resolve(root,'board.json'))).items.some(i=>i.text?.includes('新增区域'))).toBe(true);
 const disk=JSON.parse(readFileSync(resolve(root,'board.json')));assert.equal(disk.items.filter(i=>i.id===fileId).length,1);assert(disk.boards[0].paperRows.every(r=>r.wrapWidth>0));
 console.log('PASS native resize persistence/reload, editable added area and undo/redo; original contents unchanged');
 // A live writing caret outside both edges is scrolled into the smaller viewport.
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:initial.w,height:initial.h}}});await expect.poll(async()=>(await invoke('load_document')).boards[0].bounds.w).toBe(initial.w);
 doc=await invoke('load_document');doc.boards[0].paperRows=Array.from({length:22},(_,i)=>({id:'r'+i,parts:i===0?[{text:'原位笔记'}]:i===18?[{text:' ',width:390},{text:'光标目标'}]:[],height:1}));doc.boards[0].ink=[];
 await invoke('save_board',{board:doc.boards[0],items:[],settings:doc.settings,origin:'fixture'});await page.reload();await saved();const anchored=await geometry();await page.locator('.paper-editor').evaluate(editor=>{const n=editor.querySelector('[data-row=r18]').lastChild;editor.focus();window.getSelection().setBaseAndExtent(n,4,n,4);});
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:narrow.w,height:narrow.h}}});await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollTop)).toBeGreaterThan(0);assertGeometry(await geometry(),anchored);
 assert(await page.locator('.paper').evaluate(p=>{const r=window.getSelection().getRangeAt(0).getBoundingClientRect(),b=p.getBoundingClientRect();return r.x>=b.x&&r.x<=b.x+p.clientWidth&&r.y>=b.y&&r.bottom<=b.y+p.clientHeight;}));
 await page.keyboard.insertText('续写');await expect(page.getByLabel('整板编辑区')).toContainText('光标目标续写');const continued=await geometry();assertGeometry({...continued,glyphs:continued.glyphs.filter(g=>!['续','写'].includes(g.text))},anchored);
 console.log('PASS native shrink reveals an active writing caret on both axes and preserves original writing');
} finally {await invoke('quit_app').catch(()=>{});await browser.close();}
