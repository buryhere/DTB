// Preserve physical paper/glyph/file positions when changing bookmark gutters.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(process.argv[2]??''),release=root.startsWith(resolve('.native-release-test-data')+'\\');
assert(release||root.startsWith(resolve('.native-interaction-test-data')+'\\'));
const port=Number(process.argv[3]??(release?9224:9222));assert.equal(port,release?9224:9222);
let browser,page;
await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:60000}).toBe(true);
page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
async function snapshot(){
 const position=await invoke('plugin:window|outer_position',{label:'main'}),scale=await invoke('plugin:window|scale_factor',{label:'main'});
 return page.locator('.paper-document').evaluate((paper,{position,scale})=>{const glyphs=[],walker=document.createTreeWalker(paper.querySelector('.paper-editor'),NodeFilter.SHOW_TEXT);let n;
  while((n=walker.nextNode())){if(n.parentElement.closest('[data-atom]'))continue;for(let i=0;i<n.textContent.length;i++){const text=n.textContent[i];if(!text.trim())continue;const range=document.createRange();range.setStart(n,i);range.setEnd(n,i+1);const r=range.getBoundingClientRect();glyphs.push({text,x:position.x+r.x*scale,y:position.y+r.y*scale,w:r.width*scale,h:r.height*scale});}}
  const atoms=[...paper.querySelectorAll('[data-atom]')].map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.atom,x:position.x+r.x*scale,y:position.y+r.y*scale,w:r.width*scale,h:r.height*scale};});
  const box=paper.closest('.paper').getBoundingClientRect();return {glyphs,atoms,ink:[...paper.querySelectorAll('.ink-layer polyline')].map(n=>n.getAttribute('points')),paper:{x:position.x+box.x*scale,y:position.y+box.y*scale,w:box.width*scale}};
 },{position,scale});
}
function compare(actual,before){assert.deepEqual(actual.ink,before.ink);for(const group of ['glyphs','atoms']){assert.equal(actual[group].length,before[group].length);actual[group].forEach((value,i)=>{const old=before[group][i];assert.equal(value.text??value.id,old.text??old.id);for(const key of ['x','y','w','h'])assert(Math.abs(value[key]-old[key])<=1.01,`${group}[${i}] ${key}: ${value[key]} vs ${old[key]}`);});}for(const k of ['x','y','w'])assert(Math.abs(actual.paper[k]-before.paper[k])<=(k==='w'?2:1.01),`paper ${k}: ${actual.paper[k]} vs ${before.paper[k]}`);}
// WebView rounds its logical viewport when native widths are fractional CSS px;
// allow two physical pixels for the visible width, while glyphs stay within one.
try{
 await page.locator('.save-state').waitFor();assert.equal(await invoke('plugin:app|identifier'),release?'com.desktopboard.app':'com.desktopboard.interactiontest');
 const seed=JSON.parse(readFileSync(join(root,'seed.json'))),old=seed.boards[0],scale=await invoke('plugin:window|scale_factor',{label:'main'});
 const delta=Math.round(58*scale)-Math.round(36*scale);
 await expect.poll(async()=>{const b=(await invoke('load_document')).boards[0];return [b.bounds.x,b.bounds.w,b.bookmarkGutter];}).toEqual([old.bounds.x-delta,old.bounds.w+delta,50]);
 const initial=await invoke('plugin:window|outer_position',{label:'main'});await page.reload();await page.locator('.save-state').waitFor();assert.deepEqual(await invoke('plugin:window|outer_position',{label:'main'}),initial);
 console.log('PASS legacy large-style startup migration and reload apply the gutter compensation once');
 let doc=await invoke('load_document');assert.equal(doc.boards.length,1);assert.equal(doc.items.length,0);
 const file=await invoke('import_paths',{paths:[resolve('tests/fixtures/preview.pdf')],mode:'ref'}),id=crypto.randomUUID();doc.items=[{...file[0],id,boardId:'main',createdAt:new Date().toISOString()}];
 doc.boards[0].paperRows=[{id:'first',height:3,parts:[{text:'Keep this '+'W'.repeat(52)},{itemId:id},{text:' after PDF'}]},{id:'gap',height:2,parts:[]},{id:'later',height:1,parts:[{text:' ',width:180},{text:'Later note'}]}];doc.boards[0].ink=[{id:'ink',points:[{x:80,y:144},{x:170,y:150}]}];
 await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.locator('.file-type')).toHaveText('PDF');await page.locator('.paper').evaluate(p=>{p.scrollTop=0;p.scrollLeft=0;});const before=await snapshot();
 const names={heart:'爱心缝线',geometric:'极简几何',pixel:'像素科技',whale:'用户',knot:'中国结'};
 for(const style of ['pixel','whale','knot','heart','geometric','whale','pixel']){
  await page.getByLabel('更多工具',{exact:true}).click();await page.getByText('书签样式',{exact:true}).click();await page.getByLabel(`书签样式：${names[style]}`,{exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();
  await expect.poll(async()=>(await invoke('load_document')).boards[0].bookmarkStyle).toBe(style);
  let mismatch;await expect.poll(async()=>{try{compare(await snapshot(),before);return true}catch(error){mismatch=error.message;return false}}).toBe(true).catch(error=>{console.error(style,mismatch);throw error});compare(await snapshot(),before);
  const box=await page.locator('.bookmark').boundingBox(),large=['whale','knot'].includes(style);assert.equal(box.width,large?66:44);assert.equal(box.height,large?90:60);
  await page.reload();await expect(page.locator('.file-type')).toHaveText('PDF');compare(await snapshot(),before);
 }
 console.log('PASS repeated small/large styles and reload: physical paper, every glyph, PDF and ink stay in place; dimensions persist');
 doc=await invoke('load_document');assert.equal(doc.items.filter(i=>i.type==='file').length,1);assert.equal(doc.boards[0].ink.length,1);
}finally{if(page)await invoke('quit_app').catch(()=>{});if(browser)await browser.close();}
