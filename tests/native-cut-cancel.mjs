// Real mouse input and Explorer menu detection; requires a visible desktop.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const input=(action,x=-1,y=-1)=>JSON.parse(execFileSync('powershell',['-NoProfile','-File',resolve('tests/cut-cancel-input.ps1'),'-Action',action,'-X',String(x),'-Y',String(y)],{windowsHide:true,encoding:'utf8'}).trim());
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222'),context=browser.contexts()[0],page=context.pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);
assert.equal(await invoke('plugin:app|identifier'),'com.desktopboard.interactiontest','Only use the isolated test application.');
let doc=await invoke('load_document');assert.equal(doc.items.length,0,'Use fresh test data.');assert.equal(doc.boards.length,1);
if(!doc.settings.onboardingDone)await page.getByText('暂不开启').click();
const baseline=input('probe');assert.match(baseline.target,/SysListView32|SHELLDLL_DefView|WorkerW|Progman/,'Keep the desktop visible at the test point.');
try {
 // Positive control proves the detector sees this Windows desktop menu.
 const opened=input('click',baseline.x,baseline.y),added=opened.menus.filter(m=>!baseline.menus.includes(m));assert(added.length,'Desktop menu detector failed its positive control.');
 console.log('PASS: real desktop right-click opens a detectable menu',added.map(m=>m.split(':')[1]).join(','));input('escape');
 for(let i=0;i<3;i++){
  await invoke('plugin:window|set_focus',{label:'main'});await page.getByLabel('绘图与裁剪').click();await page.getByRole('button',{name:'剪刀裁剪',exact:true}).click();
  let overlay;await expect.poll(()=>{overlay=context.pages().find(p=>p.url().includes('overlay=cut'));return !!overlay;}).toBe(true);await expect(overlay.getByLabel('屏幕裁剪区域')).toBeVisible();
  input('down',baseline.x,baseline.y);await page.waitForTimeout(200);await expect(overlay.getByLabel('屏幕裁剪区域')).toBeVisible();assert(await invoke('cut_scene'),'Overlay must survive right button down.');
  const released=input('up',baseline.x,baseline.y);await expect.poll(()=>context.pages().some(p=>p.url().includes('overlay=cut'))).toBe(false);
  const probe=input('probe');assert.deepEqual(released.menus.filter(m=>!baseline.menus.includes(m)),[],'Right release opened a desktop menu.');assert.deepEqual(probe.menus.filter(m=>!baseline.menus.includes(m)),[]);
  assert.equal(await invoke('cut_scene'),null);assert.equal((await invoke('load_document')).boards.length,1);
 }
 console.log('PASS: 3 real right-button holds/releases cancel scissors without opening an Explorer menu');
} finally {
 input('up');input('escape');const scene=await invoke('cut_scene').catch(()=>null);if(scene)await invoke('finish_cut',{token:scene.token,gesture:null}).catch(()=>{});
 await invoke('quit_app').catch(()=>{});await browser.close();
}
