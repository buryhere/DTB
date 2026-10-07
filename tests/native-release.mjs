// Run only after explicitly launching the current release EXE with this isolated
// data directory and CDP port. Does not simulate physical mouse input.
import {chromium,expect} from '@playwright/test';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2] ?? '.native-release-test-data/current-20261006');
assert(root.startsWith(resolve('.native-release-test-data')+'\\'), 'Use an isolated release test directory.');
let browser;
await expect.poll(async()=>{try{browser=await chromium.connectOverCDP('http://127.0.0.1:9224',{timeout:2000});return true;}catch{return false;}},{timeout:15000}).toBe(true);
let page,overlay;
await expect.poll(()=>{page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay=icons'));overlay=browser.contexts()[0].pages().find(p=>p.url().includes('overlay=icons'));return !!page&&!!overlay;},{timeout:10000}).toBe(true);
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
assert.equal(await invoke('plugin:app|identifier'),'com.desktopboard.app');
let doc=await invoke('load_document');assert.equal(doc.items.length,0);assert.equal(doc.boards.length,1);
await expect.poll(()=>existsSync(join(root,'board.json')),{timeout:5000}).toBe(true);
assert.equal(JSON.parse(readFileSync(join(root,'board.json'))).items.length,0);
doc.settings.onboardingDone=true;
const imported=await invoke('import_paths',{paths:[resolve('tests/fixtures/preview.pdf')],mode:'ref'});
doc.items=[{id:'release-note',boardId:'main',type:'text',text:'随手记下今天的事\nEnter 可以继续换行',done:false,position:{x:72,y:96},createdAt:new Date().toISOString()}, {...imported[0],id:'release-pdf',boardId:'main',position:{x:72,y:240},createdAt:new Date().toISOString()}];
doc.boards[0].grid.spacing=48;delete doc.boards[0].paperRows;
await invoke('save_board',{board:doc.boards[0],items:doc.items,settings:doc.settings,origin:'release-fixture'});
assert.equal(JSON.parse(readFileSync(join(root,'board.json'))).items[0].id,'release-note','Data must be written into the isolated root.');
await page.reload();await expect(page.locator('.paper-editor')).toContainText('\u968f\u624b\u8bb0\u4e0b\u4eca\u5929\u7684\u4e8b');await expect(page.locator('.paper-editor')).toContainText('Enter \u53ef\u4ee5\u7ee7\u7eed\u6362\u884c');
await expect(page.locator('main')).toHaveCSS('--paper-rgb','255, 240, 245');
await expect.poll(()=>page.locator('.file-icon img').evaluateAll(images=>images.length===1&&images[0].naturalWidth>0)).toBe(true);
await page.screenshot({path:'releases/preview-current.png'});
console.log('PASS: release startup, isolated Unicode persistence, default pink paper and real PDF icon');
await overlay.evaluate(()=>window.__COLLISION_DIAGNOSTICS__=true);
const base=await invoke('read_icons');const points=s=>Object.fromEntries(s.icons.map(i=>[i.id,{x:i.x,y:i.y}]));
try{
  await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:300,height:225}}});
  await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:20,y:2}}});
  await expect(page.getByText('已保存',{exact:true})).toBeVisible();
  await page.getByLabel('更多工具').click();await page.getByText('外观与设置').click();
  await overlay.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'collision-scene',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.__collisionTestScene=e.payload)}));
  const toggle=page.getByText('桌面图标让位动画',{exact:true}).locator('input');await toggle.click();await expect(toggle).toBeChecked({timeout:12000});
  await expect.poll(()=>{const j=JSON.parse(readFileSync(join(root,'icon-recovery.json')));return !!j.clip},{timeout:12000}).toBe(true);
  assert.equal((await invoke('read_icons')).visible,true);
  await expect.poll(()=>overlay.locator('canvas').evaluate(c=>Number(c.dataset.active))).toBeGreaterThan(0);
  const image=await overlay.screenshot({path:join(root,'production-physics.png')});
  const colored=await overlay.evaluate(async png=>{const img=new Image();img.src='data:image/png;base64,'+png;await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>90)n++;return n;},image.toString('base64'));assert(colored>500,'Production WebView capture must contain icons; check real desktop separately with native-presentation.');
  assert.deepEqual(points(await invoke('read_icons')),points(base));
  let maxRotation=0;
  for(let i=0;i<20;i++){
    await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:20+i*14,y:2+i*8}}});
    await page.waitForTimeout(30);
    maxRotation=Math.max(maxRotation,await overlay.locator('canvas').evaluate(c=>Number(c.dataset.rotation)));
  }
  assert(maxRotation>.01,'Production movement must generate rotation.');
  await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:-1000,y:300}}});
  await expect.poll(()=>JSON.parse(readFileSync(join(root,'icon-recovery.json'))).clip != null,{timeout:15000}).toBe(false);
  assert.equal((await invoke('read_icons')).visible,true);
  assert.deepEqual(points(await invoke('read_icons')),points(base));
  console.log('PASS: production continuous rotation, elastic return and automatic native-layer restoration');
  await invoke('restore_icons');assert.deepEqual(points(await invoke('read_icons')),points(base));
  console.log('PASS: production guard, WebView bitmap capture, untouched native positions and full restoration; real desktop presentation is checked separately');
}catch(error){
  writeFileSync(join(root,'physics-failure.json'),JSON.stringify(await overlay.locator('canvas').evaluate(c=>({...c.dataset})),null,2));
  writeFileSync(join(root,'physics-scene.json'),JSON.stringify(await overlay.evaluate(()=>window.__collisionTestScene??null)));
  throw error;
}finally{
  await invoke('restore_icons').catch(()=>{});
  const closed=page.waitForEvent('close',{timeout:10000});await invoke('quit_app');await closed;await browser.close();
}
