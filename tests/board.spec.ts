import {expect,test, type Page} from '@playwright/test';
import {initialDocument} from '../src/model';
import type {PaperRow} from '../src/paper-model';
const row=(id:string,text=''):PaperRow=>({id,parts:text?[{text}]:[],height:1});
async function start(page:Page,rows?:PaperRow[]){
 const doc=initialDocument();doc.settings.onboardingDone=true;if(rows)doc.boards[0].paperRows=rows;
 await page.addInitScript(doc=>{if(!sessionStorage.getItem('seeded'))localStorage.setItem('desktop-board-preview',JSON.stringify(doc));},doc);await page.goto('/');await expect(page.getByLabel('整板编辑区')).toBeVisible();
 // Only seed the first navigation; later reload must use the saved document.
 await page.evaluate(()=>sessionStorage.setItem('seeded','1'));
}
async function caret(page:Page,id:string,offset:number){await page.locator('.paper-editor').evaluate((editor,{id,offset})=>{const line=editor.querySelector<HTMLElement>(`[data-row="${id}"]`)!;editor.focus();const walker=document.createTreeWalker(line,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){const count=n.textContent?.length??0;if(offset<=count){window.getSelection()!.setBaseAndExtent(n,offset,n,offset);return;}offset-=count;}window.getSelection()!.setBaseAndExtent(line,0,line,0);}, {id,offset});}
async function textX(page:Page,text:string){return page.locator('.paper-editor').evaluate((editor,text)=>{const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){const offset=n.textContent?.indexOf(text)??-1;if(offset>=0){const r=document.createRange();r.setStart(n,offset);r.setEnd(n,offset+text.length);return r.getBoundingClientRect().left;}}throw Error('Missing text '+text);},text);}
async function snapshot(page:Page){await expect(page.getByText('已保存',{exact:true})).toBeVisible();return page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!));}
async function tool(page:Page,name:string){if(name==='文字编辑'){await page.getByLabel('自由书写区域').click({button:'right',position:{x:10,y:10}});return;}await page.getByLabel('绘图与裁剪').click();await page.locator('.tools-menu').getByRole('button',{name,exact:true}).click();}
async function settings(page:Page){await page.getByLabel('更多工具').click();await page.getByText('外观与设置').click();}

test('marquee carries text, file atoms and ink as one group, previews exact drop, cancels and undoes',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=[{id:'file',boardId:'main',type:'file',ext:'lnk',title:'程序.lnk',path:'C:/sample.lnk',position:{x:24,y:24},createdAt:''}];
 doc.boards[0].paperRows=[row('first','搬动😀'),{id:'second',parts:[{itemId:'file'},{text:'伴随文字'}],height:1},row('third'),row('fourth','                         保留原位')];
 doc.boards[0].ink=[{id:'stroke',points:[{x:35,y:55},{x:110,y:55}]},{id:'other',points:[{x:260,y:220},{x:300,y:220}]}];
 await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded'))localStorage.setItem('desktop-board-preview',JSON.stringify(d));},doc);await page.goto('/');await page.evaluate(()=>sessionStorage.setItem('seeded','1'));
 const before=await snapshot(page),anchor=await textBox(page,'保留原位'),originalText=await textBox(page,'搬动😀'),paper=(await page.locator('.paper-document').boundingBox())!;
 const select=async()=>{await page.mouse.move(paper.x+23,paper.y+1);await page.mouse.down();await page.mouse.move(paper.x+130,paper.y+63,{steps:5});await expect(page.getByLabel('框选虚线框')).toBeVisible();await expect(page.locator('.marquee-outline rect')).toHaveCSS('animation-timing-function','steps(2)');await page.mouse.up();await expect(page.getByLabel('框选落点预览')).toBeVisible();};
 await tool(page,'框选移动');await select();await page.mouse.move(paper.x+290,paper.y+320);
 // Autosave while carrying must keep the original document, never an empty source.
 await page.waitForTimeout(600);const saved=await snapshot(page);expect(saved.items).toEqual(before.items);expect(saved.boards[0].ink).toEqual(before.boards[0].ink);
 await page.mouse.click(paper.x+290,paper.y+320,{button:'right'});await expect(page.getByLabel('框选落点预览')).toHaveCount(0);await expect(page.getByLabel('框选区域')).toBeVisible();await expect(page.getByLabel('整板编辑区')).toContainText('搬动😀');
 await select();await page.mouse.move(paper.x+290,paper.y+320);const ghost=(await page.locator('.ghost-text').first().boundingBox())!;
 await page.mouse.down();await expect(page.getByLabel('框选落点预览')).toBeVisible();await page.mouse.up();await expect(page.getByLabel('框选落点预览')).toHaveCount(0);
 const moved=await textBox(page,'搬动😀');expect(moved.x).toBeCloseTo(ghost.x,1);expect((moved.y-originalText.y)%24).toBeCloseTo(0,1);expect(moved.y).toBeCloseTo(ghost.y+originalText.y-paper.y,1);
 expect(await textBox(page,'保留原位')).toEqual(anchor);const after=await snapshot(page);expect(after.items.filter((i:any)=>i.id==='file')).toHaveLength(1);expect(after.boards[0].ink.find((s:any)=>s.id==='other')).toEqual(before.boards[0].ink.find((s:any)=>s.id==='other'));
 await page.keyboard.press('Control+z');await expect(page.locator('[data-row=first]')).toContainText('搬动😀');expect((await snapshot(page)).items).toEqual(before.items);
 await page.keyboard.press('Control+y');expect(await textBox(page,'搬动😀')).toEqual(moved);await snapshot(page);await page.reload();expect(await textBox(page,'搬动😀')).toEqual(moved);expect(await textBox(page,'保留原位')).toEqual(anchor);
});

test('marquee rejects occupied writing, selects a whole wrapped emoji and right cancellation keeps the tool',async({page})=>{
 await start(page,[row('first','😀甲'),row('second','其它文字')]);const box=await textBox(page,'😀'),dest=await textBox(page,'其它文字');await tool(page,'框选移动');
 await page.mouse.move(box.x+1,box.y+1);await page.mouse.down();await page.mouse.move(box.x+2,box.y+4);await page.mouse.up();await expect(page.locator('.ghost-text')).toHaveText('😀');
 await page.mouse.move(dest.x+box.w/2,dest.y+dest.h/2);await expect(page.getByLabel('框选落点预览')).toHaveAttribute('aria-invalid','true');await page.mouse.click(dest.x+box.w/2,dest.y+dest.h/2);await expect(page.getByLabel('框选落点预览')).toBeVisible();
 await page.mouse.click(dest.x,dest.y,{button:'right'});await expect(page.getByLabel('整板编辑区')).toContainText('😀甲');await expect(page.getByLabel('整板编辑区')).toContainText('其它文字');await expect(page.getByLabel('框选区域')).toBeVisible();
 await page.mouse.click(dest.x,dest.y,{button:'right'});await expect(page.getByLabel('框选区域')).toHaveCount(0);await expect(page.getByLabel('整板编辑区')).toHaveAttribute('contenteditable','true');
});

test('empty paper retracts after erasing distant notes, preserves ink and window dimensions',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.boards[0].paperRows=Array.from({length:100},(_,i)=>row(`r${i}`,i===0?'留下':i===60?'擦除远端文字':''));doc.boards[0].ink=[{id:'ink',points:[{x:40,y:900},{x:100,y:900}]}];
 await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded'))localStorage.setItem('desktop-board-preview',JSON.stringify(d));},doc);await page.goto('/');await page.evaluate(()=>sessionStorage.setItem('seeded','1'));const initial=await snapshot(page);expect(initial.boards[0].paperRows).toHaveLength(61);
 await tool(page,'文字橡皮擦');await page.locator('.paper').evaluate(p=>p.scrollTop=1300);const box=await textBox(page,'擦除远端文字');await page.mouse.move(box.x-5,box.y+box.h/2);await page.mouse.down();await page.mouse.move(box.x+box.w+5,box.y+box.h/2,{steps:5});await page.mouse.up();
 const next=await snapshot(page);expect(next.boards[0].paperRows).toHaveLength(38);expect(next.boards[0].ink).toEqual(initial.boards[0].ink);expect(next.boards[0].bounds).toEqual(initial.boards[0].bounds);
 await tool(page,'铅笔橡皮擦');await page.locator('.paper').evaluate(p=>p.scrollTop=650);const surface=(await page.getByLabel('铅笔橡皮擦区域').boundingBox())!;await page.mouse.move(surface.x+35,surface.y+900);await page.mouse.down();await page.mouse.move(surface.x+105,surface.y+900,{steps:8});await page.mouse.up();
 const empty=await snapshot(page);expect(empty.boards[0].ink).toHaveLength(0);expect(empty.boards[0].paperRows.length).toBeLessThan(30);await page.keyboard.press('Control+z');expect((await snapshot(page)).boards[0].ink).toEqual(initial.boards[0].ink);await page.reload();expect((await snapshot(page)).boards[0].paperRows).toHaveLength(38);
});

test('marquee moves a grapheme from a soft wrap without disturbing remaining writing',async({page})=>{
 await start(page,[row('wrap','保留'+'W'.repeat(75)+'👨‍👩‍👧‍👦'+'Z'.repeat(60)+'结尾',3),row('next','下一行保留')]);await snapshot(page);
 const before=await textBox(page,'保留'),end=await textBox(page,'结尾'),below=await textBox(page,'下一行保留'),emoji=await textBox(page,'👨‍👩‍👧‍👦'),paper=(await page.locator('.paper-document').boundingBox())!;await tool(page,'框选移动');
 await page.mouse.move(emoji.x+emoji.w/2-1,emoji.y+2);await page.mouse.down();await page.mouse.move(emoji.x+emoji.w/2+1,emoji.y+4);await page.mouse.up();await expect(page.locator('.ghost-text')).toHaveText('👨‍👩‍👧‍👦');
 await page.mouse.move(paper.x+250,paper.y+300);await page.mouse.click(paper.x+250,paper.y+300);expect(await textBox(page,'保留')).toEqual(before);expect(await textBox(page,'结尾')).toEqual(end);expect(await textBox(page,'下一行保留')).toEqual(below);const moved=await textBox(page,'👨‍👩‍👧‍👦');expect(moved.y).toBeGreaterThan(emoji.y+100);
 await snapshot(page);await page.reload();expect(await textBox(page,'结尾')).toEqual(end);expect(await textBox(page,'👨‍👩‍👧‍👦')).toEqual(moved);
});

test('deleting the final distant note retracts its blank tail and Enter can extend paper again',async({page})=>{
 await start(page,Array.from({length:70},(_,i)=>row(`r${i}`,i===0?'保留':i===50?'x':'')));await snapshot(page);await caret(page,'r50',1);await page.keyboard.press('Backspace');const shrunk=await snapshot(page);expect(shrunk.boards[0].paperRows.length).toBeLessThan(30);
 const last=await page.locator('.editor-line').last().getAttribute('data-row');await caret(page,last!,0);await page.keyboard.press('Enter');await page.keyboard.insertText('可以继续向下写');await expect(page.getByLabel('整板编辑区')).toContainText('可以继续向下写');const extended=await snapshot(page);expect(extended.boards[0].paperRows.length).toBe(shrunk.boards[0].paperRows.length+1);
});

test('one continuous editor supports Chinese text, Enter, selection deletion, undo and reload',async({page})=>{
 await page.goto('/');await page.getByText('暂不开启').click();await page.locator('.editor-line').nth(2).click({position:{x:144,y:12}});await page.keyboard.insertText('准备项目资料');await page.keyboard.press('Enter');await page.keyboard.insertText('第二行');
 await expect(page.locator('textarea')).toHaveCount(0);await expect(page.locator('[contenteditable=true]')).toHaveCount(1);const doc=await snapshot(page);expect(doc.items.map((i:any)=>i.text)).toEqual(['准备项目资料','第二行']);expect(doc.items[0].position.x).toBe(168);
 await page.reload();await expect(page.getByLabel('整板编辑区')).toContainText('准备项目资料');await page.getByLabel('整板编辑区').focus();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await expect(page.getByLabel('整板编辑区')).not.toContainText('准备项目资料');await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).toContainText('准备项目资料');await snapshot(page);
});

test('editing earlier text consumes blank rows, then pushes the later note; deleting restores its gap',async({page})=>{
 await start(page,[row('first','first'),row('g1'),row('g2'),row('later','later')]);await caret(page,'first',5);
 await page.keyboard.press('Enter');await page.keyboard.insertText('extra');let doc=await snapshot(page);expect(doc.items.find((i:any)=>i.text==='later').position.y).toBe(72);expect(doc.boards[0].paperRows.filter((r:any)=>r.id==='g1'||r.id==='g2')).toHaveLength(1);
 await page.keyboard.press('Enter');await page.keyboard.insertText('extra2');doc=await snapshot(page);expect(doc.items.find((i:any)=>i.text==='later').position.y).toBe(72);
 await page.keyboard.press('Enter');await page.keyboard.insertText('extra3');doc=await snapshot(page);expect(doc.items.find((i:any)=>i.text==='later').position.y).toBe(96);
 await page.keyboard.press('Home');await page.keyboard.press('Backspace');doc=await snapshot(page);expect(doc.items.find((i:any)=>i.text==='later').position.y).toBe(96);expect(doc.boards[0].paperRows.some((r:any)=>!r.parts.length)).toBe(true);
});

test('automatic wrapping consumes the gap before shifting later text',async({page})=>{
 await start(page,[row('first','a'),row('g1'),row('g2'),row('later','later')]);await caret(page,'first',1);await page.keyboard.insertText('W'.repeat(90));const doc=await snapshot(page);expect(doc.boards[0].paperRows[0].height).toBe(2);expect(doc.items.find((i:any)=>i.text==='later').position.y).toBe(72);
});

test('IME composition is committed once and plain paste replaces a backwards selection',async({page})=>{
 await start(page,[row('first','before')]);await caret(page,'first',6);
 await page.getByLabel('整板编辑区').evaluate(editor=>{editor.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));const n=editor.firstElementChild!.firstChild!;n.textContent='before中文';window.getSelection()!.setBaseAndExtent(n,8,n,8);editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertCompositionText',data:'中文',isComposing:true}));editor.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));});
 expect((await snapshot(page)).items[0].text).toBe('before中文');await page.getByLabel('整板编辑区').evaluate(editor=>{const n=editor.firstElementChild!.firstChild!;window.getSelection()!.setBaseAndExtent(n,8,n,6);const data=new DataTransfer();data.setData('text/plain','换行\n后续');data.setData('text/html','<b>不应插入</b>');editor.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,clipboardData:data}));});await expect(page.getByLabel('整板编辑区')).toContainText('before换行');await expect(page.getByLabel('整板编辑区')).toContainText('后续');await expect(page.locator('.paper-editor b')).toHaveCount(0);await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).toContainText('before中文');
});

test('pencil free drawing, click dots, Shift centered straight lines and undo persist',async({page})=>{
 await page.goto('/');await page.getByText('暂不开启').click();await tool(page,'铅笔绘画');const surface=page.getByLabel('铅笔绘画区域'),box=(await surface.boundingBox())!;
 await page.mouse.move(box.x+40,box.y+55);await page.mouse.down();await page.mouse.move(box.x+95,box.y+75,{steps:8});await page.mouse.up();await expect(page.locator('.ink-free')).toHaveCount(1);
 await page.mouse.click(box.x+120,box.y+60);await expect(page.locator('.ink-free')).toHaveCount(2);
 await page.keyboard.down('Shift');await page.mouse.move(box.x+150,box.y+80);await page.mouse.down();await page.mouse.move(box.x+300,box.y+89,{steps:12});await page.mouse.up();await page.keyboard.up('Shift');
 await expect(page.locator('.ink-line')).toHaveAttribute('points','150,84 300,84');let doc=await snapshot(page);expect(doc.boards[0].ink).toHaveLength(3);await page.getByRole('button',{name:'撤销 Ctrl+Z'}).click();await expect(page.locator('.ink-line')).toHaveCount(0);await tool(page,'文字编辑');await expect(page.getByLabel('整板编辑区')).toBeFocused();await page.keyboard.insertText('继续写字');await snapshot(page);await page.reload();await expect(page.locator('.ink-free')).toHaveCount(2);await expect(page.getByLabel('整板编辑区')).toContainText('继续写字');
});

test('theme and line spacing persist and scale both text positions and ink',async({page})=>{
 await page.goto('/');await page.getByText('暂不开启').click();await page.locator('.editor-line').nth(4).click({position:{x:0,y:12}});await page.keyboard.insertText('第五行');await tool(page,'铅笔绘画');const b=(await page.getByLabel('铅笔绘画区域').boundingBox())!;await page.keyboard.down('Shift');await page.mouse.move(b.x+40,b.y+100);await page.mouse.down();await page.mouse.move(b.x+180,b.y+105);await page.mouse.up();await page.keyboard.up('Shift');
 await settings(page);await page.getByLabel('背景颜色',{exact:true}).fill('#e8f2ff');await page.getByLabel('下划线间距',{exact:true}).evaluate(node=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,'40');node.dispatchEvent(new Event('input',{bubbles:true}));});await page.getByRole('button',{name:'完成',exact:true}).click();
 await expect(page.locator('main')).toHaveCSS('--line-height','40px');const doc=await snapshot(page);expect(doc.items[0].position.y).toBe(160);expect(doc.boards[0].ink[0].points[0].y).toBe(180);await page.reload();await expect(page.locator('main')).toHaveCSS('--paper-rgb','232, 242, 255');await expect(page.locator('.ink-line')).toHaveAttribute('points','40,180 180,180');
 await expect(page.getByLabel('整板编辑区')).toHaveCSS('font-size','21.6667px');await expect(page.getByRole('button',{name:'文字编辑',exact:true})).toHaveCount(0);
});

test('lock freezes the whole editor and drawing tools, persists and unlocks',async({page})=>{
 await page.goto('/');await page.getByText('暂不开启').click();await page.locator('.editor-line').nth(4).click({position:{x:0,y:12}});await page.keyboard.insertText('保留这段');await page.getByLabel('锁定板子',{exact:true}).click();await expect(page.getByLabel('整板编辑区')).toHaveAttribute('contenteditable','false');await expect(page.getByLabel('自由书写区域')).toHaveAttribute('inert','');await expect(page.getByLabel('绘图与裁剪')).toBeDisabled();await snapshot(page);await page.reload();await page.getByLabel('解锁板子',{exact:true}).click();await expect(page.getByLabel('整板编辑区')).toHaveAttribute('contenteditable','true');await expect(page.getByLabel('整板编辑区')).toContainText('保留这段');
});

test('scissors are grouped with pencil and retain outside trails and right-click cancellation',async({page})=>{
 await page.goto('/');await page.getByText('暂不开启').click();const area=(await page.getByLabel('自由书写区域').boundingBox())!;await tool(page,'剪刀裁剪');await expect(page.locator('.cut-hint')).toHaveCSS('opacity','0.7');await expect(page.locator('.cut-hint')).toHaveCSS('font-weight','700');await page.mouse.move(1,area.y+240);await page.mouse.down();await page.mouse.move(area.x+area.width-8,area.y+240,{steps:24});await expect(page.locator('.cut-trail')).toHaveAttribute('points',/\d+,\d+ /);await expect(page.locator('.cut-line')).toHaveCount(1);await page.keyboard.press('Escape');await expect(page.locator('.cut-overlay')).toBeVisible();await page.mouse.click(1,area.y+240,{button:'right'});await page.mouse.up();await expect(page.locator('.cut-overlay')).toHaveCount(0);
});

test('inline files are part of selection, deletion and undo; document labels are selectable as whole file atoms',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=[{id:'shortcut',boardId:'main',type:'file',ext:'lnk',title:'快捷程序.lnk',path:'C:/sample.lnk',position:{x:24,y:0},createdAt:''},{id:'pdf',boardId:'main',type:'file',ext:'PDF',title:'项目说明.pdf',path:'C:/sample.pdf',position:{x:140,y:0},createdAt:''},{id:'word',boardId:'main',type:'file',ext:'docx',title:'项目计划.docx',path:'C:/sample.docx',position:{x:300,y:0},createdAt:''}];await page.addInitScript(doc=>{if(!localStorage.getItem('desktop-board-preview'))localStorage.setItem('desktop-board-preview',JSON.stringify(doc));},doc);await page.goto('/');
 await expect(page.locator('[data-atom=shortcut] .file-name')).toHaveCount(0);await expect(page.locator('[data-atom=pdf] .file-name')).toHaveText('项目说明');await settings(page);await page.getByLabel('下划线间距',{exact:true}).evaluate(node=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,'48');node.dispatchEvent(new Event('input',{bubbles:true}));});await page.getByRole('button',{name:'完成',exact:true}).click();await expect(page.locator('[data-atom=pdf] .file-tile')).toHaveClass(/name-below/);
 await page.getByLabel('整板编辑区').focus();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await expect(page.locator('[data-atom]')).toHaveCount(0);expect((await snapshot(page)).items).toHaveLength(0);await page.keyboard.press('Control+z');await expect(page.locator('[data-atom]')).toHaveCount(3);expect((await snapshot(page)).items).toHaveLength(3);
});

test('clicking beyond existing text places new writing at the clicked position and preserves it on reload',async({page})=>{
 await start(page,[row('first','已有内容')]);const line=page.locator('[data-row=first]'),box=(await line.boundingBox())!;await line.click({position:{x:280,y:12}});await page.keyboard.insertText('后方落笔');expect(await textX(page,'后方落笔')).toBeCloseTo(box.x+280,0);const doc=await snapshot(page);expect(doc.boards[0].paperRows[0].parts.some((p:any)=>p.width>0)).toBe(true);
 await page.reload();expect(await textX(page,'后方落笔')).toBeCloseTo(box.x+280,0);
 await page.locator('.editor-line').nth(2).click({position:{x:80,y:12}});await page.keyboard.insertText('multi word ');await page.keyboard.insertText('note');expect((await snapshot(page)).items.some((i:any)=>i.text==='multi word note')).toBe(true);
});

test('typing before notes consumes same-line whitespace while Chinese input and deletion keep later notes fixed',async({page})=>{
 await start(page,[row('first','          后方信息')]);const x=await textX(page,'后方信息');await caret(page,'first',0);
 for(const text of ['中','a','文','b']){await page.keyboard.insertText(text);expect(await textX(page,'后方信息')).toBeCloseTo(x,1);}
 await page.keyboard.press('Backspace');expect(await textX(page,'后方信息')).toBeCloseTo(x,1);await snapshot(page);await page.reload();expect(await textX(page,'后方信息')).toBeCloseTo(x,1);
 await start(page);await page.getByLabel('整板编辑区').focus();await page.keyboard.press('Control+a');await page.keyboard.press('Backspace');await page.keyboard.insertText('前方          后方');const anchor=await textX(page,'后方');const id=await page.locator('.editor-line').first().getAttribute('data-row');await caret(page,id!,2);await page.keyboard.insertText('新增');expect(await textX(page,'后方')).toBeCloseTo(anchor,1);await page.keyboard.insertText('很长的内容会用完所有留白');expect(await textX(page,'后方')).toBeGreaterThan(anchor+10);
});

test('eraser removes only crossed ink, supports one-step undo and persists remaining fragments',async({page})=>{
 await start(page,[row('first','保留文字')]);await tool(page,'铅笔绘画');const b=(await page.getByLabel('铅笔绘画区域').boundingBox())!;
 for(const y of [84,132]){await page.keyboard.down('Shift');await page.mouse.move(b.x+40,b.y+y);await page.mouse.down();await page.mouse.move(b.x+300,b.y+y);await page.mouse.up();await page.keyboard.up('Shift');}await expect(page.locator('.ink-line')).toHaveCount(2);
 await tool(page,'铅笔橡皮擦');await expect(page.getByLabel('铅笔橡皮擦区域')).toBeVisible();await page.mouse.move(b.x+170,b.y+65);await page.mouse.down();await page.mouse.move(b.x+170,b.y+103,{steps:10});await page.mouse.up();await expect(page.locator('.ink-line')).toHaveCount(3);await expect(page.getByLabel('整板编辑区')).toContainText('保留文字');
 await page.getByRole('button',{name:'撤销 Ctrl+Z'}).click();await expect(page.locator('.ink-line')).toHaveCount(2);await page.keyboard.press('Control+y');await expect(page.locator('.ink-line')).toHaveCount(3);await snapshot(page);await page.reload();await expect(page.locator('.ink-line')).toHaveCount(3);
});

test('scissors retain the overlay until the right mouse button is released',async({page})=>{
 await start(page);await tool(page,'剪刀裁剪');await page.mouse.move(2,400);await page.mouse.down({button:'right'});await page.waitForTimeout(250);await expect(page.locator('.cut-overlay')).toBeVisible();await page.mouse.up({button:'right'});await expect(page.locator('.cut-overlay')).toHaveCount(0);
});

test('right-click exits pencil and eraser without leaving a draft, and compact toolbar has no text button',async({page})=>{
 await start(page);await expect(page.getByRole('button',{name:'文字编辑',exact:true})).toHaveCount(0);await expect(page.locator('.toolbar')).toHaveCSS('height','36px');
 for(const name of ['铅笔绘画','铅笔橡皮擦','文字橡皮擦']){await tool(page,name);await page.getByLabel('自由书写区域').click({button:'right',position:{x:15,y:20}});await expect(page.locator('.drawing-surface')).toHaveCount(0);await expect(page.getByLabel('整板编辑区')).toHaveAttribute('contenteditable','true');}
 await page.keyboard.insertText('右键返回后可以继续写字');await expect(page.getByLabel('整板编辑区')).toContainText('右键返回后可以继续写字');
});

test('moving immediately after pressing a file preserves text coordinates and supports undo/reload',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=[{id:'file',boardId:'main',type:'file',ext:'lnk',title:'程序.lnk',path:'C:/sample.lnk',position:{x:24,y:0},createdAt:''}];doc.boards[0].paperRows=[{id:'source',parts:[{itemId:'file'},{text:'旁边文字'}],height:1},row('next','其它内容'),row('dest')];
 await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('desktop-board-preview',JSON.stringify(d));sessionStorage.setItem('seeded','1');}},doc);await page.goto('/');const atom=page.locator('[data-atom=file]'),original=(await atom.boundingBox())!,dest=(await page.locator('[data-row=dest]').boundingBox())!;
 const geometry=()=>page.locator('.paper-editor').evaluate(editor=>{const result:Record<string,{x:number;y:number}>={};const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode()))for(const text of ['旁边文字','其它内容']){const start=n.textContent?.indexOf(text)??-1;if(start>=0){const range=document.createRange();range.setStart(n,start);range.setEnd(n,start+text.length);const r=range.getBoundingClientRect();result[text]={x:r.x,y:r.y};}}return result;});const before=await geometry();
 await page.mouse.move(original.x+10,original.y+10);await page.mouse.down();await page.mouse.move(dest.x+190,dest.y+12);await expect(page.locator('.paper-file-drag')).toBeVisible();await page.mouse.up();await expect(page.locator('.paper-file-drag')).toHaveCount(0);await expect(page.locator('[data-row=dest] [data-atom=file]')).toHaveCount(1);await expect(page.locator('[data-row=source]')).toContainText('旁边文字');expect((await snapshot(page)).items.filter((i:any)=>i.id==='file')).toHaveLength(1);expect(await geometry()).toEqual(before);
 await page.keyboard.press('Control+z');await expect(page.locator('[data-row=source] [data-atom=file]')).toHaveCount(1);await page.keyboard.press('Control+y');await expect(page.locator('[data-row=dest] [data-atom=file]')).toHaveCount(1);await snapshot(page);await page.reload();await expect(page.locator('[data-row=dest] [data-atom=file]')).toHaveCount(1);
 const moved=(await atom.boundingBox())!;await page.mouse.move(moved.x+10,moved.y+10);await page.mouse.down();await page.mouse.move(moved.x+40,moved.y+10);await expect(page.locator('.paper-file-drag')).toBeVisible();await page.mouse.click(moved.x+40,moved.y+10,{button:'right'});await page.mouse.up();await expect(page.locator('.paper-file-drag')).toHaveCount(0);await expect(page.locator('[data-row=dest] [data-atom=file]')).toHaveCount(1);
});

test('inline text and files stay on the underline grid at every supported spacing',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=['file','pdf'].map(id=>({id,boardId:'main',type:'file',ext:id==='pdf'?'pdf':'lnk',title:id==='pdf'?'很长的项目说明文档.pdf':'程序.lnk',path:`C:/sample.${id}`,position:{x:24,y:0},createdAt:''}));doc.boards[0].paperRows=[{id:'icons',parts:[{text:'前面'},{itemId:'file'},{text:'中间'},{itemId:'pdf'},{text:'后面'}],height:1},row('second','下一行'),row('third','第三行')];await page.addInitScript(d=>localStorage.setItem('desktop-board-preview',JSON.stringify(d)),doc);await page.goto('/');
 for(const spacing of [24,16,40,48,64]){await settings(page);await page.getByLabel('下划线间距',{exact:true}).evaluate((node,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,String(value));node.dispatchEvent(new Event('input',{bubbles:true}));},spacing);await page.getByRole('button',{name:'完成',exact:true}).click();await snapshot(page);
 const geometry=await page.locator('.paper-editor').evaluate(editor=>{const top=editor.getBoundingClientRect().top;return {rows:[...editor.querySelectorAll<HTMLElement>('[data-row]')].slice(0,3).map(n=>({y:n.getBoundingClientRect().top-top,h:n.getBoundingClientRect().height})),icons:[...editor.querySelectorAll<HTMLElement>('[data-atom]')].map(n=>({y:n.getBoundingClientRect().top-top,h:n.getBoundingClientRect().height}))};});
 for(const [index,r] of geometry.rows.entries()){expect(r.y).toBeCloseTo(index*spacing,1);expect(r.h).toBeCloseTo(spacing,1);}for(const icon of geometry.icons){expect(icon.y).toBeCloseTo(0,1);expect(icon.h).toBeCloseTo(spacing,1);}}
});

test('repeated same-row file moves use whitespace without displacing surrounding notes',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=[{id:'file',boardId:'main',type:'file',ext:'lnk',title:'程序.lnk',path:'C:/sample.lnk',position:{x:24,y:0},createdAt:''}];doc.boards[0].paperRows=[{id:'mixed',parts:[{text:'前'},{text:'                  ',width:130},{itemId:'file'},{text:'邻居'},{text:'                  ',width:130},{text:'末尾'}],height:1},row('below','下面的文字')];await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('desktop-board-preview',JSON.stringify(d));sessionStorage.setItem('seeded','1');}},doc);await page.goto('/');
 const positions=()=>page.locator('.paper-editor').evaluate(editor=>{const result:Record<string,{x:number;y:number}>={};const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode()))for(const text of ['前','邻居','末尾','下面的文字']){const start=n.textContent?.indexOf(text)??-1;if(start>=0){const r=document.createRange();r.setStart(n,start);r.setEnd(n,start+text.length);const box=r.getBoundingClientRect();result[text]={x:box.x,y:box.y};}}return result;});const before=await positions(),line=(await page.locator('[data-row=mixed]').boundingBox())!;
 for(const x of [40,290,70,335]){const icon=(await page.locator('[data-atom=file]').boundingBox())!;await page.mouse.move(icon.x+8,icon.y+8);await page.mouse.down();await page.mouse.move(line.x+x+8,line.y+8);await page.mouse.up();await snapshot(page);for(const [text,pos] of Object.entries(await positions())){expect(pos.x).toBeCloseTo(before[text].x,1);expect(pos.y).toBeCloseTo(before[text].y,1);}expect((await snapshot(page)).items.filter((i:any)=>i.id==='file')).toHaveLength(1);}
 // Dropping on existing writing must choose a nearby free slot, rather than
 // inserting the file into the sentence and moving the sentence to make room.
 const icon=(await page.locator('[data-atom=file]').boundingBox())!;await page.mouse.move(icon.x+8,icon.y+8);await page.mouse.down();await page.mouse.move(before['邻居'].x+8,line.y+8);await page.mouse.up();await snapshot(page);for(const [text,pos] of Object.entries(await positions())){expect(pos.x).toBeCloseTo(before[text].x,1);expect(pos.y).toBeCloseTo(before[text].y,1);}await page.reload();for(const [text,pos] of Object.entries(await positions())){expect(pos.x).toBeCloseTo(before[text].x,1);expect(pos.y).toBeCloseTo(before[text].y,1);}
});

test('moving a wide PDF near wrapped text and ordinary spaces preserves every existing text rectangle',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.boards[0].grid.spacing=48;doc.items=[{id:'pdf',boardId:'main',type:'file',ext:'pdf',title:'项目说明.pdf',path:'C:/sample.pdf',position:{x:24,y:0},createdAt:''}];doc.boards[0].paperRows=[{id:'source',parts:[{itemId:'pdf'},{text:'原位置文字'}],height:1},{id:'wrapped',parts:[{text:'W'.repeat(50)+'               '+ 'Y'.repeat(40)+'                  结尾'}],height:4},row('later','后面的笔记')];await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('desktop-board-preview',JSON.stringify(d));sessionStorage.setItem('seeded','1');}},doc);await page.goto('/');await snapshot(page);
 const rects=()=>page.locator('.paper-editor').evaluate(editor=>{const out:number[][]=[];const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=walker.nextNode())){if(n.parentElement?.closest('[data-atom]'))continue;const text=n.textContent??'';for(let i=0;i<text.length;i++)if(text[i]!==' '){const r=document.createRange();r.setStart(n,i);r.setEnd(n,i+1);const b=r.getBoundingClientRect();out.push([b.x,b.y,b.width,b.height]);}}return out;});const before=await rects(),target=(await page.locator('[data-row=wrapped]').boundingBox())!,icon=(await page.locator('[data-atom=pdf]').boundingBox())!;
 await page.mouse.move(icon.x+8,icon.y+8);await page.mouse.down();await page.mouse.move(target.x+140,target.y+60);await expect(page.locator('.paper-file-drag')).toBeVisible();await page.mouse.up();await snapshot(page);const after=await rects();expect(after).toHaveLength(before.length);after.forEach((r,i)=>r.forEach((v,j)=>expect(v).toBeCloseTo(before[i][j],1)));await page.reload();expect(await rects()).toEqual(after);
});

async function textBox(page:Page,text:string){return page.locator('.paper-editor').evaluate((editor,text)=>{
 const walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT),nodes:Node[]=[];let n:Node|null;
 while((n=walker.nextNode()))if(!n.parentElement?.closest('[data-atom]'))nodes.push(n);
 const start=nodes.map(n=>n.textContent??'').join('').indexOf(text);if(start<0)throw Error('Missing text '+text);
 const boxes:DOMRect[]=[];let offset=0;
 for(const node of nodes){const length=node.textContent?.length??0,from=Math.max(0,start-offset),to=Math.min(length,start+text.length-offset);
  if(from<to){const range=document.createRange();range.setStart(node,from);range.setEnd(node,to);boxes.push(...range.getClientRects());}offset+=length;
 }
 const x=Math.min(...boxes.map(b=>b.x)),y=Math.min(...boxes.map(b=>b.y));return {x,y,w:Math.max(...boxes.map(b=>b.right))-x,h:Math.max(...boxes.map(b=>b.bottom))-y};
},text);}

test('text eraser clears scattered notes in one drag, preserves pencil ink/files and supports one-step undo/reload',async({page})=>{
 const doc=initialDocument();doc.settings.onboardingDone=true;doc.items=[{id:'file',boardId:'main',type:'file',ext:'pdf',title:'文件.pdf',path:'C:/sample.pdf',position:{x:24,y:24},createdAt:''}];doc.boards[0].paperRows=[{id:'top',parts:[{text:'ABCDEF'},{text:'                  ',width:150},{text:'后方笔记'}],height:1},{id:'file-row',parts:[{itemId:'file'}],height:1},row('gap1'),row('gap2'),{id:'corner',parts:[{text:'                                   ',width:260},{text:'角落文字'}],height:1}];doc.boards[0].ink=[{id:'ink',points:[{x:24,y:12},{x:180,y:12}]}];await page.addInitScript(d=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('desktop-board-preview',JSON.stringify(d));sessionStorage.setItem('seeded','1');}},doc);await page.goto('/');await snapshot(page);
 const first=await textBox(page,'ABCDEF'),corner=await textBox(page,'角落文字'),other=await textBox(page,'后方笔记'),file=(await page.locator('[data-atom=file]').boundingBox())!,name=(await page.locator('[data-atom=file] .file-name').boundingBox())!;await tool(page,'文字橡皮擦');await expect(page.getByLabel('文字橡皮擦区域')).toBeVisible();await page.mouse.click(name.x+name.width/2,name.y+name.height/2);await expect(page.locator('[data-atom=file] .file-name')).toHaveText('文件');await expect(page.getByLabel('整板编辑区')).toContainText('ABCDEF');
 await page.mouse.move(first.x-12,first.y+first.h/2);await page.mouse.down();await page.mouse.move(first.x+first.w+12,first.y+first.h/2);await expect(page.getByLabel('整板编辑区')).not.toContainText('ABCDEF');await page.waitForTimeout(600);expect((await snapshot(page)).items.some((i:any)=>i.text?.includes('ABCDEF'))).toBe(true);
 await page.mouse.move(corner.x-12,corner.y+corner.h/2);await page.mouse.move(corner.x+corner.w+12,corner.y+corner.h/2);await page.mouse.up();await expect(page.getByLabel('整板编辑区')).not.toContainText('角落文字');let saved=await snapshot(page);expect(saved.boards[0].ink).toEqual(doc.boards[0].ink);expect(saved.items.filter((i:any)=>i.id==='file')).toHaveLength(1);expect(await textBox(page,'后方笔记')).toEqual(other);expect(await page.locator('[data-atom=file]').boundingBox()).toEqual(file);
 await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).toContainText('ABCDEF');await expect(page.getByLabel('整板编辑区')).toContainText('角落文字');await page.keyboard.press('Control+y');await expect(page.getByLabel('整板编辑区')).not.toContainText('角落文字');await snapshot(page);await page.reload();await expect(page.getByLabel('整板编辑区')).not.toContainText('ABCDEF');await expect(page.locator('.ink-free')).toHaveCount(1);expect(await textBox(page,'后方笔记')).toEqual(other);await page.getByLabel('绘图与裁剪').click();await page.screenshot({path:'erasers-check.png'});
});

test('right-click and pointer cancellation roll back text eraser previews and preserve pending typing',async({page})=>{
 await start(page,[row('first')]);await caret(page,'first',0);await page.keyboard.insertText('取消擦除');const b=await textBox(page,'取消擦除');await tool(page,'文字橡皮擦');await page.mouse.move(b.x-12,b.y+b.h/2);await page.mouse.down();await page.mouse.move(b.x+b.w+12,b.y+b.h/2);await expect(page.getByLabel('整板编辑区')).not.toContainText('取消擦除');await page.waitForTimeout(650);expect((await snapshot(page)).items.some((i:any)=>i.text==='取消擦除')).toBe(true);await page.mouse.click(b.x+b.w+12,b.y+b.h/2,{button:'right'});await page.mouse.up();await expect(page.getByLabel('整板编辑区')).toContainText('取消擦除');await expect(page.locator('.drawing-surface')).toHaveCount(0);await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).not.toContainText('取消擦除');await page.keyboard.press('Control+y');await expect(page.getByLabel('整板编辑区')).toContainText('取消擦除');
 await tool(page,'文字橡皮擦');await page.mouse.move(b.x,b.y+b.h/2);await page.mouse.down();await expect(page.getByLabel('整板编辑区')).not.toContainText('取消擦除');await page.getByLabel('文字橡皮擦区域').dispatchEvent('pointercancel');await page.mouse.up();await expect(page.getByLabel('整板编辑区')).toContainText('取消擦除');
});

test('text eraser removes whole emoji graphemes while preserving positions after soft wrapping',async({page})=>{
 await start(page,[row('wrapped','保留'+ 'W'.repeat(75)+'👨‍👩‍👧‍👦'+ 'Z'.repeat(60)+'结尾',3),row('next','下一行保留')]);await snapshot(page);const leading=await textBox(page,'保留'),end=await textBox(page,'结尾'),below=await textBox(page,'下一行保留'),emoji=await textBox(page,'👨‍👩‍👧‍👦');await tool(page,'文字橡皮擦');await page.mouse.click(emoji.x+emoji.w/2,emoji.y+emoji.h/2);await expect(page.getByLabel('整板编辑区')).not.toContainText('👨‍👩‍👧‍👦');await snapshot(page);
 for(const [text,old] of [['保留',leading],['结尾',end],['下一行保留',below]] as const){const next=await textBox(page,text);expect(next.x).toBeCloseTo(old.x,1);expect(next.y).toBeCloseTo(old.y,1);}const content=await page.getByLabel('整板编辑区').textContent();expect(content).not.toContain('\u200d');await page.keyboard.press('Control+z');await expect(page.getByLabel('整板编辑区')).toContainText('👨‍👩‍👧‍👦');
});

test('cached icons with a smaller core use the desktop-size artwork and collision silhouette',async({page})=>{
 await start(page);const result=await page.evaluate(async()=>{const {desktopBitmap}=await import('/src/icon-image.ts');const {shapeFromAlpha}=await import('/src/collision-model.ts');
 const native=document.createElement('canvas');native.width=native.height=55;const n=native.getContext('2d')!;n.fillStyle='#2377dc';n.fillRect(2,2,51,51);
 const cached=document.createElement('canvas');cached.width=cached.height=110;const c=cached.getContext('2d')!;c.fillStyle='rgba(255,255,255,.11)';c.fillRect(0,0,110,110);c.fillStyle='#2377dc';c.fillRect(41,41,28,28);
 const high=new Image(),ref=new Image();high.src=cached.toDataURL();ref.src=native.toDataURL();await Promise.all([high.decode(),ref.decode()]);const calibrated=desktopBitmap(high,55,ref),pixels=calibrated.getContext('2d')!.getImageData(0,0,calibrated.width,calibrated.height).data,shape=shapeFromAlpha(pixels,calibrated.width,calibrated.height,55);return {source:calibrated.dataset.source,width:Math.max(...shape.samples.map(p=>p.x+p.radius))-Math.min(...shape.samples.map(p=>p.x-p.radius))};});
 expect(result.source).toBe('desktop-size');expect(result.width).toBeGreaterThan(49);
});

