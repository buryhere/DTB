import { test, expect } from '@playwright/test';

test('bookmark styles persist without moving notes, and recommended colors apply only on request', async ({page})=>{
  await page.goto('/'); await page.getByText('暂不开启').click();
  await page.locator('.paper-editor').click(); await page.keyboard.type('Keep my note here');
  await expect.poll(()=>page.evaluate(()=>JSON.stringify(JSON.parse(localStorage.getItem('desktop-board-preview')??'null')?.boards[0].paperRows)??'')).toContain('Keep my note here');
  const before=await page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!));
  const paper=await page.locator('.paper').boundingBox();
  const glyphs=()=>page.locator('.paper-editor').evaluate(editor=>{const origin=editor.getBoundingClientRect(),walker=document.createTreeWalker(editor,NodeFilter.SHOW_TEXT),result=[];let node;while((node=walker.nextNode()))for(let i=0;i<(node.textContent??'').length;i++){const text=node.textContent![i];if(!text.trim())continue;const range=document.createRange();range.setStart(node,i);range.setEnd(node,i+1);const r=range.getBoundingClientRect();result.push({text,x:r.x-origin.x,y:r.y-origin.y});}return result;});
  const originalGlyphs=await glyphs();
  await page.getByLabel('更多工具',{exact:true}).click(); await page.getByText('书签样式',{exact:true}).click();
  for(const [id,name] of [['geometric','极简几何'],['pixel','像素科技'],['whale','用户'],['knot','中国结'],['heart','爱心缝线']]){
    await page.getByLabel(`书签样式：${name}`,{exact:true}).click();
    await expect(page.locator('.bookmark')).toHaveAttribute('data-style',id);
    const enlarged=id==='whale'||id==='knot';
    const box=await page.locator('.bookmark').boundingBox();expect(box!.width).toBe(enlarged?66:44);expect(box!.height).toBe(enlarged?90:60);
    const currentPaper=await page.locator('.paper').boundingBox();expect(currentPaper!.y).toBe(paper!.y);expect(currentPaper!.height).toBe(paper!.height);
    await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].bookmarkStyle)).toBe(id);
    const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!));
    expect(saved.boards[0].theme).toEqual(before.boards[0].theme);
    const contents=(rows:{id:string;height:number;parts:{text?:string;itemId?:string}[]}[])=>rows.map(r=>({id:r.id,height:r.height,text:r.parts.map(p=>p.text??p.itemId).join('')}));
    expect(contents(saved.boards[0].paperRows)).toEqual(contents(before.boards[0].paperRows));
    const actual=await glyphs();expect(actual.length).toBe(originalGlyphs.length);actual.forEach((g,i)=>{expect(g.text).toBe(originalGlyphs[i].text);expect(g.x).toBeCloseTo(originalGlyphs[i].x,1);expect(g.y).toBeCloseTo(originalGlyphs[i].y,1);});
    expect(saved.items.filter((item:{type:string})=>item.type!=='text')).toEqual(before.items.filter((item:{type:string})=>item.type!=='text'));
  }
  await page.getByLabel('书签样式：中国结',{exact:true}).click();
  await page.getByLabel('应用推荐背景：浅杏桃',{exact:true}).click();
  await page.screenshot({path:'test-results/bookmark-styles.png'});
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].theme.paper)).toBe('#fff0e8');
  await page.getByRole('button',{name:'完成',exact:true}).click(); await page.reload();
  await expect(page.locator('.bookmark')).toHaveAttribute('data-style','knot');
  await page.getByLabel('更多工具',{exact:true}).click(); await page.getByText('书签样式',{exact:true}).click();
  await page.locator('.bookmark-picker').click({button:'right'}); await expect(page.locator('.bookmark-picker')).toHaveCount(0);
});

test('heart bookmark explicitly arms edge hiding, persists, exits tools and obeys locking', async ({ page }) => {
  await page.goto('/');
  await page.getByText('暂不开启').click();
  const bookmark = page.getByRole('button', { name: '书签：开启贴边收缩', exact: true });
  await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
  const ribbon = await bookmark.boundingBox(), board = await page.locator('.board').boundingBox();
  expect(ribbon!.x).toBeLessThan(board!.x); expect(ribbon!.x + ribbon!.width).toBeGreaterThan(board!.x);
  await expect(page.locator('[title="折叠"],[title="展开"]')).toHaveCount(0);
  await page.getByLabel('绘图与裁剪', { exact: true }).click(); await page.getByText('铅笔绘画', { exact: true }).click();
  await bookmark.click();
  const armed = page.getByRole('button', { name: '展开板子并退出贴边收缩', exact: true });
  await expect(armed).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.board-caption')).toContainText('离开 1 秒隐藏');
  await expect(page.locator('.paper-document')).not.toHaveClass(/pencil-mode/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].edgeHide)).toBe(true);
  await page.reload(); await expect(armed).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('锁定板子', { exact: true }).click(); await expect(armed).toBeDisabled();
  await page.getByLabel('解锁板子', { exact: true }).click(); await armed.click();
  await expect(bookmark).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].edgeHide)).toBe(false);
});

test('legacy folded notes reopen as a full editable board with the bookmark available', async ({ page }) => {
  await page.goto('/'); await page.getByText('暂不开启').click();
  await expect.poll(() => page.evaluate(() => !!localStorage.getItem('desktop-board-preview'))).toBe(true);
  await page.evaluate(() => { const doc = JSON.parse(localStorage.getItem('desktop-board-preview')!); doc.boards[0].collapsed = true; localStorage.setItem('desktop-board-preview', JSON.stringify(doc)); });
  await page.reload();
  await expect(page.locator('.board')).not.toHaveClass(/collapsed/);
  await expect(page.getByLabel('自由书写区域', { exact: true })).toBeVisible();
  await expect(page.getByLabel('书签：开启贴边收缩', { exact: true })).toBeEnabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('desktop-board-preview')!).boards[0].collapsed)).toBe(false);
});
