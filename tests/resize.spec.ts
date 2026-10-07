import {expect,test,type Page} from '@playwright/test';
import {initialDocument} from '../src/model';

async function seed(page:Page){
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.boards[0].ink=[{id:'stroke',points:[{x:220,y:120},{x:320,y:120}]}];
 doc.items=['file','pdf'].map(id=>({id,boardId:'main',type:'file' as const,path:`C:/sample.${id==='pdf'?'pdf':'lnk'}`,ext:id==='pdf'?'pdf':'lnk',title:id==='pdf'?'项目说明.pdf':'程序.lnk',position:{x:24,y:0},createdAt:''}));
 doc.boards[0].paperRows=[{id:'first',parts:[{text:'开头'+'W'.repeat(52)},{itemId:'file'},{text:'中间'+'Z'.repeat(38)},{itemId:'pdf'},{text:'结尾'}],height:3},{id:'gap',parts:[],height:1},{id:'later',parts:[{text:' ',width:280},{text:'原位笔记'}],height:1}];
 await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded'))localStorage.setItem('desktop-board-preview',JSON.stringify(d));},doc);
 await page.goto('/');await expect(page.getByLabel('整板编辑区')).toBeVisible();await page.evaluate(()=>sessionStorage.setItem('seeded','1'));await expect(page.getByText('已保存',{exact:true})).toBeVisible();return doc;
}
async function geometry(page:Page){return page.locator('.paper-document').evaluate(paper=>{
 const origin=paper.getBoundingClientRect(),editor=paper.querySelector('.paper-editor')!,glyphs:{text:string;x:number;y:number;w:number;h:number}[]=[],segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
 const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n:Node|null;
 while((n=walker.nextNode())){if(n.parentElement?.closest('[data-atom]'))continue;for(const {segment,index} of segmenter.segment(n.textContent??'')){if(!segment.trim())continue;const range=document.createRange();range.setStart(n,index);range.setEnd(n,index+segment.length);const r=range.getBoundingClientRect();glyphs.push({text:segment,x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height});}}
 const atoms=[...editor.querySelectorAll<HTMLElement>('[data-atom]')].map(n=>{const r=n.getBoundingClientRect();return {id:n.dataset.atom,x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height};});
 const ink=[...paper.querySelectorAll('.ink-layer[aria-label] polyline')].map(n=>n.getAttribute('points'));return {glyphs,atoms,ink};
});}
async function saved(page:Page){await expect(page.getByText('已保存',{exact:true})).toBeVisible();return page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!));}

test('narrowing below the original width keeps content positions and exposes horizontal scrolling',async({page})=>{
 await seed(page);const before=await geometry(page);
 for(const size of [{width:400,height:360},{width:280,height:220},{width:240,height:180}]){
  await page.setViewportSize(size);await expect.poll(()=>geometry(page)).toEqual(before);
  await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollWidth-p.clientWidth)).toBeGreaterThan(50);
  const overflow=await page.locator('.paper').evaluate(p=>({x:p.scrollWidth-p.clientWidth,y:p.scrollHeight-p.clientHeight}));expect(overflow.x).toBeGreaterThan(50);
  await page.locator('.paper').evaluate(p=>{p.scrollLeft=100;p.scrollTop=48;});expect(await page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);expect(await geometry(page)).toEqual(before);
  await page.locator('.paper').evaluate(p=>{p.scrollLeft=0;p.scrollTop=0;});await saved(page);
 }
 await page.reload();await expect(page.getByLabel('整板编辑区')).toBeVisible();expect(await geometry(page)).toEqual(before);expect(await page.locator('.paper').evaluate(p=>p.scrollWidth-p.clientWidth)).toBeGreaterThan(50);
 const box=(await page.locator('.paper').boundingBox())!;await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
 await page.keyboard.down('Shift');await page.mouse.wheel(0,100);await page.keyboard.up('Shift');await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);expect(await geometry(page)).toEqual(before);
 await page.locator('.paper').evaluate(p=>{p.scrollLeft=0;p.scrollTop=p.scrollHeight;});await page.mouse.wheel(0,100);await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);
 await page.setViewportSize({width:560,height:660});await expect.poll(()=>geometry(page)).toEqual(before);
});

test('shrinking both axes scrolls an active writing caret into view without reflowing notes',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.boards[0].paperRows=Array.from({length:22},(_,i)=>({id:`r${i}`,parts:i===0?[{text:'原位笔记'}]:i===18?[{text:' ',width:390},{text:'光标目标'}]:[],height:1}));
 await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded'))localStorage.setItem('desktop-board-preview',JSON.stringify(d));},doc);await page.goto('/');await page.evaluate(()=>sessionStorage.setItem('seeded','1'));await saved(page);const before=await geometry(page);
 await page.locator('.paper-editor').evaluate(editor=>{const line=editor.querySelector('[data-row=r18]')!,node=line.lastChild!;editor.focus();window.getSelection()!.setBaseAndExtent(node,4,node,4);});
 await page.setViewportSize({width:280,height:220});await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollLeft)).toBeGreaterThan(0);await expect.poll(()=>page.locator('.paper').evaluate(p=>p.scrollTop)).toBeGreaterThan(0);expect(await geometry(page)).toEqual(before);
 const visible=await page.locator('.paper').evaluate(p=>{const r=window.getSelection()!.getRangeAt(0).getBoundingClientRect(),b=p.getBoundingClientRect();return r.x>=b.x&&r.x<=b.x+p.clientWidth&&r.y>=b.y&&r.bottom<=b.y+p.clientHeight;});expect(visible).toBe(true);
 await page.keyboard.insertText('续写');await expect(page.getByLabel('整板编辑区')).toContainText('光标目标续写');const after=await geometry(page);expect(after.glyphs.filter(g=>!['续','写'].includes(g.text))).toEqual(before.glyphs);
 await saved(page);await page.reload();await expect(page.getByLabel('整板编辑区')).toContainText('光标目标续写');expect((await geometry(page)).glyphs.filter(g=>!['续','写'].includes(g.text))).toEqual(before.glyphs);
});

test('widening and lengthening add blank paper without changing any glyph, file or ink coordinate',async({page})=>{
 await seed(page);const before=await geometry(page);
 for(const size of [{width:840,height:660},{width:1000,height:900},{width:1200,height:1040},{width:560,height:660}]){
  await page.setViewportSize(size);await expect.poll(()=>geometry(page)).toEqual(before);await saved(page);
 }
 await page.setViewportSize({width:960,height:860});await saved(page);expect(await geometry(page)).toEqual(before);await page.reload();await expect(page.getByLabel('整板编辑区')).toBeVisible();expect(await geometry(page)).toEqual(before);
 // The new area remains editable and does not cause old wraps to reflow.
 const paper=(await page.locator('.paper-document').boundingBox())!;
 await page.mouse.click(paper.x+700,paper.y+12);await page.keyboard.insertText('新增区域');const after=await geometry(page);
 expect(after.glyphs.filter(g=>!['新','增','区','域'].includes(g.text))).toEqual(before.glyphs);expect(after.atoms).toEqual(before.atoms);expect(after.ink).toEqual(before.ink);
 await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).not.toContainText('新增区域');await saved(page);expect(await geometry(page)).toEqual(before);
 await page.keyboard.press('Control+y');await expect(page.getByLabel('整板编辑区')).toContainText('新增区域');
});

test('resize preserves a live caret on a soft wrap and backward text selection',async({page})=>{
 await seed(page);const before=await geometry(page);
 await page.locator('.paper-editor').evaluate(editor=>{const n=editor.querySelector('[data-row=first]')!.firstChild!;editor.focus();window.getSelection()!.setBaseAndExtent(n,45,n,45);});
 await page.setViewportSize({width:940,height:660});await saved(page);expect(await geometry(page)).toEqual(before);
 await page.keyboard.insertText('光标处');await expect(page.getByLabel('整板编辑区')).toContainText('光标处');await page.keyboard.press('Control+z');await saved(page);expect(await geometry(page)).toEqual(before);
 const select=await page.locator('.paper-editor').evaluate(editor=>{const line=editor.querySelector('[data-row=first]')!,n=line.firstChild!;editor.focus();window.getSelection()!.setBaseAndExtent(n,5,n,2);return window.getSelection()!.toString();});
 await page.setViewportSize({width:1200,height:850});await saved(page);expect(await page.evaluate(()=>window.getSelection()!.toString())).toBe(select);
 await page.keyboard.press('Backspace');await page.keyboard.press('Control+z');await saved(page);expect(await geometry(page)).toEqual(before);
});
