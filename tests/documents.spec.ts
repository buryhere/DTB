import { test, expect } from '@playwright/test';
import { initialDocument } from '../src/model';

test('Office documents and PDF use below-icon names or an upper-left type badge without crossing ruled lines', async ({ page }) => {
  const doc = initialDocument(); doc.settings.onboardingDone = true;
  const extensions = ['docx','PPTX','xlsx','doc','pptm','xlsb','pdf','one','vsdx','accdb','pub','mpp'];
  doc.items = extensions.map((ext,i) => ({id:'f'+i,boardId:'main',type:'file',ext,title:`项目资料${i}.${ext}`,path:`C:/项目资料${i}.${ext}`,createdAt:''}));
  doc.items.push({id:'shortcut',boardId:'main',type:'file',ext:'lnk',title:'演示文稿.pptx.lnk',path:'C:/演示文稿.pptx.lnk',createdAt:''});
  doc.boards[0].paperRows = doc.items.map(i => ({id:'r'+i.id,parts:[{itemId:i.id}],height:1}));
  await page.addInitScript(d => { if(!localStorage.getItem('desktop-board-preview')) localStorage.setItem('desktop-board-preview',JSON.stringify(d)); }, doc);
  await page.goto('/');
  for (const spacing of [16,24,39,40,48,64]) {
    await page.getByLabel('更多工具').click(); await page.getByText('外观与设置',{exact:true}).click();
    await page.getByLabel('下划线间距',{exact:true}).evaluate((node,value) => {Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,String(value));node.dispatchEvent(new Event('input',{bubbles:true}));},spacing);
    await page.getByRole('button',{name:'完成',exact:true}).click();
    for (const [i,ext] of extensions.entries()) {
      const atom = page.locator(`[data-atom=f${i}]`),tile=atom.locator('.file-tile');
      await expect(tile).toHaveAttribute('aria-label',`项目资料${i}.${ext}`);
      const box=(await atom.boundingBox())!,name=(await atom.locator('.file-name').boundingBox())!;
      expect(box.height).toBeCloseTo(spacing,1); expect(name.y).toBeGreaterThanOrEqual(box.y-.1);expect(name.y+name.height).toBeLessThanOrEqual(box.y+spacing+.1);
      if(spacing<40){
        await expect(tile).toHaveClass(/document-compact/);await expect(atom.locator('.file-icon')).toHaveCount(0);
        await expect(atom.locator('.file-type')).toHaveText(ext.toUpperCase());await expect(atom.locator('.file-name')).toHaveText(`项目资料${i}`);
        const badge=(await atom.locator('.file-type').boundingBox())!;expect(badge.x+badge.width).toBeLessThanOrEqual(name.x);expect(badge.y).toBeLessThan(name.y);expect(badge.y).toBeGreaterThanOrEqual(box.y-.1);
      }else{
        await expect(tile).toHaveClass(/name-below/);await expect(atom.locator('.file-type')).toHaveCount(0);
        await expect(atom.locator('.file-name')).toHaveText(`项目资料${i}.${ext}`);const icon=(await atom.locator('.file-icon').boundingBox())!;expect(name.y).toBeGreaterThanOrEqual(icon.y+icon.height);
      }
    }
    await expect(page.locator('[data-atom=shortcut] .file-name')).toHaveCount(0);
    if(spacing===24||spacing===48)await page.screenshot({path:`documents-${spacing}-check.png`});
  }
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].grid.spacing)).toBe(64);
  await page.reload();await expect(page.locator('.name-below')).toHaveCount(extensions.length);
  expect(await page.locator('[data-atom]').count()).toBe(doc.items.length);
});

test('compact Office labels drag immediately, preserve surrounding writing, undo and persist as a single file', async ({ page }) => {
  const doc=initialDocument();doc.settings.onboardingDone=true;
  doc.items=[{id:'ppt',boardId:'main',type:'file',ext:'pptx',title:'季度经营情况.pptx',path:'C:/季度经营情况.pptx',createdAt:''}];
  doc.boards[0].paperRows=[{id:'source',parts:[{text:'前'},{itemId:'ppt'},{text:'邻居'}],height:1},...Array.from({length:8},(_,i)=>({id:'r'+i,parts:i===1?[{text:'后面的笔记'}]:[],height:1}))];
  await page.addInitScript(d=>{if(!localStorage.getItem('desktop-board-preview'))localStorage.setItem('desktop-board-preview',JSON.stringify(d));},doc);await page.goto('/');
  const positions=()=>page.locator('.paper-editor').evaluate(editor=>{const out:Record<string,number[]>={};const walk=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT);let node;while(node=walk.nextNode())if(['前','邻居','后面的笔记'].includes(node.textContent!)){const r=document.createRange();r.selectNodeContents(node);const b=r.getBoundingClientRect();out[node.textContent!]=[b.x,b.y];}return out;});
  const before=await positions(),atom=page.locator('[data-atom=ppt]'),origin=(await atom.boundingBox())!,dest=(await page.locator('[data-row=r6]').boundingBox())!;
  await page.mouse.move(origin.x+35,origin.y+12);await page.mouse.down();await page.mouse.move(dest.x+130,dest.y+12);await expect(page.locator('.paper-file-drag .file-type')).toHaveText('PPTX');await page.mouse.up();
  await expect.poll(positions).toEqual(before);await expect(atom.locator('.file-name')).toHaveText('季度经营情况');await page.keyboard.press('Control+z');await expect.poll(async()=>atom.boundingBox()).toEqual(origin);
  await page.keyboard.press('Control+y');await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!).items.filter((i:any)=>i.id==='ppt').length)).toBe(1);await page.waitForTimeout(650);await page.reload();await expect(atom.locator('.file-type')).toHaveText('PPTX');expect(await positions()).toEqual(before);
});
