import {expect,test,type Page} from '@playwright/test';
import {initialDocument} from '../src/model';

async function glyphs(page:Page){return page.locator('.paper-editor').evaluate(editor=>{
 const result:{text:string;x:number;y:number}[]=[],walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let node:Node|null;
 while((node=walker.nextNode())){if(node.parentElement?.closest('[data-atom]'))continue;
  for(const {segment,index} of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(node.textContent??'')){
   if(!segment.trim())continue;const range=document.createRange();range.setStart(node,index);range.setEnd(node,index+segment.length);const r=range.getBoundingClientRect();result.push({text:segment,x:r.x,y:r.y});
  }
 }return result;
});}

for(const [name,existing,addition] of [
 ['digits','123456','789012345678901234'],
 ['latin','abcdef','ghijklmnopqrstuvwxyz'],
 ['chinese punctuation','记录内容','……（接着填写更多信息）'],
 ['chinese closing punctuation','记录内容末','，接着填写更多信息'],
 ['emoji','A👨‍👩‍👧‍👦','abcdefghijklmnopqrstuv'],
] as const){
 test(`appending ${name} at the right edge wraps only new writing`,async({page})=>{
  const doc=initialDocument();doc.settings.onboardingDone=true;
  doc.boards[0].paperRows=[{id:'first',parts:[{text:'前面原有文字'}],height:1},{id:'gap',parts:[],height:1},{id:'later',parts:[{text:'后面笔记'}],height:1}];
  await page.addInitScript(doc=>{if(!sessionStorage.getItem('seeded')){localStorage.setItem('desktop-board-preview',JSON.stringify(doc));sessionStorage.setItem('seeded','1');}},doc);
  await page.goto('/');const line=page.locator('[data-row=first]');await line.click({position:{x:(await line.boundingBox())!.width-70,y:12}});await page.keyboard.insertText(existing);
  const before=await glyphs(page),firstY=before.find(g=>g.text===Array.from(existing)[0])!.y;
  await page.keyboard.insertText(addition);const after=await glyphs(page);
  // Compare every original glyph, skipping only the newly inserted suffix.
  const oldPrefix=before.length-4;
  expect([...after.slice(0,oldPrefix),...after.slice(-4)]).toEqual(before);
  expect(after.slice(oldPrefix,-4).some(g=>g.y>firstY)).toBe(true);
  await expect(page.getByText('已保存',{exact:true})).toBeVisible();await page.reload();expect(await glyphs(page)).toEqual(after);
 });
}
