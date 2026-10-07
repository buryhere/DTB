// Requires an isolated application and the actual desktop visible. CDP captures
// are deliberately not used as evidence of Windows presenting the overlay.
import {chromium,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]);
assert(root.startsWith(resolve('.native-interaction-test-data')+'\\')||root.startsWith(resolve('.native-release-test-data')+'\\'));
const port=Number(process.argv[3]??9222);
let browser,page,overlay;
await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:15000}).toBe(true);
await expect.poll(()=>{page=browser.contexts()[0].pages().find(p=>p.url()!=='about:blank'&&!p.url().includes('overlay=icons'));overlay=browser.contexts()[0].pages().find(p=>p.url().includes('overlay=icons'));return !!page&&!!overlay},{timeout:15000}).toBe(true);
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const identifier=await invoke('plugin:app|identifier');
assert.equal(identifier,port===9222?'com.desktopboard.interactiontest':'com.desktopboard.app');
const journal=()=>{try{return JSON.parse(readFileSync(join(root,'icon-recovery.json')))}catch{return null}};
const positions=s=>Object.fromEntries(s.icons.map(i=>[i.id,{x:i.x,y:i.y}]));
let doc=await invoke('load_document');assert.equal(doc.items.length,0);assert.equal(doc.boards.length,1);
const baseline=await invoke('read_icons');assert.equal(baseline.visible,true);
const capture=(name,invalidate=false)=>JSON.parse(execFileSync('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',resolve('tests/desktop-presentation.ps1'),'-OwnerPid',String(baseline.pid),'-ImagePath',join(root,name),...(invalidate?['-InvalidateAlpha']:[])],{encoding:'utf8',windowsHide:true}));
try {
 await overlay.evaluate(()=>window.__COLLISION_DIAGNOSTICS__=true);
 await overlay.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'collision-scene',target:{kind:'Any'},handler:window.__TAURI_INTERNALS__.transformCallback(e=>window.__collisionTestScene=e.payload)}));
 if(!doc.settings.onboardingDone)await page.getByText('暂不开启').click();
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:300,height:225}}});
 await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:20,y:2}}});
 await expect(page.getByText('已保存',{exact:true})).toBeVisible();
 await page.getByLabel('更多工具').click();await page.getByText('外观与设置').click();
 const toggle=page.getByText('桌面图标让位动画',{exact:true}).locator('input');
 if(await toggle.isChecked()){await toggle.click();await expect.poll(()=>toggle.isChecked(),{timeout:15000}).toBe(false);await expect.poll(()=>!!journal()?.clip,{timeout:12000}).toBe(false);}
 const before=capture('native-before.png');
 assert(before.desktopCoverage>.75,'Desktop is covered by other applications. Keep it visible for this test.');
 await toggle.click();await expect.poll(()=>!!journal()?.clip,{timeout:12000}).toBe(true);
 if(await page.locator('.notice').count())await page.getByLabel('关闭提示').click();
 await page.getByRole('button',{name:'完成',exact:true}).click();
 await expect.poll(()=>overlay.locator('canvas').evaluate(c=>Number(c.dataset.active))).toBeGreaterThan(0);
 assert.equal((await invoke('read_icons')).visible,true);
 await overlay.evaluate(()=>window.__COLLISION_PAUSE__=true);await page.waitForTimeout(200);
 const native=capture('desktop-presented.png');
 assert.equal(native.clipOwner,journal().clip.owner);assert(native.region>0);
 assert(native.initialized&&native.visible&&native.alpha===255&&(native.flags&2),'Native layered window must be initialized and visible.');
 const result=await overlay.evaluate(async({beforePng,afterPng,origin,icons,size,grid})=>{
  const decode=async png=>{const image=new Image();image.src='data:image/png;base64,'+png;await image.decode();const c=document.createElement('canvas');c.width=image.naturalWidth;c.height=image.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return{width:c.width,height:c.height,data:ctx.getImageData(0,0,c.width,c.height).data}};
  const before=await decode(beforePng),after=await decode(afterPng),canvas=document.querySelector('canvas'),expected=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
  const states=JSON.parse(canvas.dataset.states),unchanged=new Set(states.filter(s=>!s.active).map(s=>s.id));
  let imageTested=0,imageMatched=0,labelTested=0,labelMatched=0,activeTested=0,activeMatched=0;
  const same=(a,b,p)=>Math.max(...[0,1,2].map(n=>Math.abs(a[p+n]-b[p+n])))<=24;
  for(const icon of icons)if(unchanged.has(icon.id)){
   for(let y=3;y<size-3;y+=3)for(let x=3;x<size-3;x+=3){const px=Math.round(icon.x+x-origin.x),py=Math.round(icon.y+y+3-origin.y);if(px<0||py<0||px>=after.width||py>=after.height)continue;const p=(py*after.width+px)*4;imageTested++;if(same(before.data,after.data,p))imageMatched++;}
   for(let y=size+8;y<grid.y-8;y+=2)for(let x=-(grid.x-size)/2+2;x<(grid.x+size)/2-2;x+=2){const px=Math.round(icon.x+x-origin.x),py=Math.round(icon.y+y-origin.y);if(px<0||py<0||px>=after.width||py>=after.height)continue;const p=(py*after.width+px)*4;if(Math.min(before.data[p],before.data[p+1],before.data[p+2])<235)continue;labelTested++;if(same(before.data,after.data,p))labelMatched++;}
  }
  for(let y=0;y<canvas.height;y+=2)for(let x=0;x<canvas.width;x+=2){const p=(y*canvas.width+x)*4;if(expected[p+3]<250)continue;activeTested++;if(same(expected,after.data,p))activeMatched++;}
  return {imageTested,imageRatio:imageMatched/Math.max(1,imageTested),labelTested,labelRatio:labelMatched/Math.max(1,labelTested),activeTested,activeRatio:activeMatched/Math.max(1,activeTested)};
 },{beforePng:readFileSync(join(root,'native-before.png')).toString('base64'),afterPng:readFileSync(join(root,'desktop-presented.png')).toString('base64'),origin:native.origin,icons:baseline.icons,size:baseline.iconSize,grid:baseline.grid});
 assert(result.imageTested>2000&&result.imageRatio>.85,`Native icon images changed: ${JSON.stringify(result)}`);
 assert(result.labelTested>100&&result.labelRatio>.8,`Native filename text changed: ${JSON.stringify(result)}`);
 assert(result.activeTested>500&&result.activeRatio>.85,`Animated sprites not presented: ${JSON.stringify(result)}`);
 const quality=await overlay.evaluate(async()=>{const scene=window.__collisionTestScene;const icons=await Promise.all(scene.icons.map(async i=>{const image=new Image();image.src=i.image;await image.decode();return image.naturalWidth}));return{minimum:Math.min(...icons),target:scene.iconSize};});
 assert(quality.minimum>0);
 console.log('PASS: actual native icons and filename text preserved; calibrated active sprites presented',result,quality);
 // Simulate an inaccessible or corrupt image after the scene is running. Only
 // that icon should return to Explorer; other icons must continue animating.
 const originalScene=await overlay.evaluate(()=>structuredClone(window.__collisionTestScene));
 const affected=await overlay.locator('canvas').evaluate(c=>JSON.parse(c.dataset.states).find(s=>s.active)?.id);
 assert(affected,'A participating icon is needed for the unavailable-image regression.');
 for(const image of ['', 'data:image/png;base64,broken']){
  const scene=structuredClone(originalScene);scene.icons.find(i=>i.id===affected).image=image;
  await invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label:'icons-overlay'},event:'collision-scene',payload:scene});
  await expect.poll(()=>overlay.locator('canvas').evaluate((c,id)=>{const s=JSON.parse(c.dataset.states??'[]');return s.some(i=>i.id===id&&!i.active)&&s.some(i=>i.id!==id&&i.active)},affected),{timeout:10000}).toBe(true);
  assert.equal((await invoke('load_document')).boards[0].collision,true);
  assert.deepEqual(positions(await invoke('read_icons')),positions(baseline));
 }
 await invoke('plugin:event|emit_to',{target:{kind:'WebviewWindow',label:'icons-overlay'},event:'collision-scene',payload:originalScene});
 await overlay.evaluate(()=>window.__COLLISION_PAUSE__=false);
 await expect.poll(()=>overlay.locator('canvas').evaluate((c,id)=>JSON.parse(c.dataset.states??'[]').some(s=>s.id===id&&s.active),affected),{timeout:10000}).toBe(true);
 console.log('PASS: unavailable and corrupt sprites preserve native icons, keep other animation alive and recover');
 let rotation=0;
 for(let i=0;i<12;i++){await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:20+i*14,y:2+i*8}}});await page.waitForTimeout(40);rotation=Math.max(rotation,await overlay.locator('canvas').evaluate(c=>Number(c.dataset.rotation)));}
 assert(rotation>.01);capture('desktop-rotating.png');assert.deepEqual(positions(await invoke('read_icons')),positions(baseline));
 await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:-1000,y:300}}});
 await expect.poll(()=>!!journal()?.clip,{timeout:15000}).toBe(false);assert.equal((await invoke('read_icons')).visible,true);
 assert.equal(capture('after-return.png').region,0);
 await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:20,y:2}}});
 await expect.poll(()=>!!journal()?.clip,{timeout:12000}).toBe(true);
 capture('before-presentation-failure.png',true);
 await expect.poll(()=>!!journal()?.clip,{timeout:6000}).toBe(false);
 assert.equal(capture('after-failure.png').region,0);
 assert.equal((await invoke('read_icons')).visible,true);assert.equal((await invoke('load_document')).boards[0].collision,false);
 assert.deepEqual(positions(await invoke('read_icons')),positions(baseline));
 console.log('PASS: rotation, elastic return and loss of layer visibility restore native icons automatically');
}finally {
 await invoke('restore_icons').catch(()=>{});
 await invoke('quit_app').catch(()=>{});await browser.close().catch(()=>{});
}
