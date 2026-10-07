// Isolated real HWND/cursor verification. Never modifies normal board data.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(process.argv[2]??''),release=root.startsWith(resolve('.native-release-test-data')+'\\');
assert(release||root.startsWith(resolve('.native-interaction-test-data')+'\\'));
const port=Number(process.argv[3]??(release?9224:9222));assert.equal(port,release?9224:9222);
const source=`using System; using System.Runtime.InteropServices; using System.Text;
public class BookmarkProbe {
 public delegate bool CB(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int left,top,right,bottom;}
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(CB c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int ht,uint flags);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr r);
 [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h,IntPtr r);
 [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr h,out Rect r);
 [DllImport("gdi32.dll")] public static extern bool PtInRegion(IntPtr r,int x,int y);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 public static IntPtr Board(uint pid){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);var title=new StringBuilder(100);GetWindowText(h,title,100);if(owner==pid&&title.ToString()=="桌面待办板")found=h;return true;},IntPtr.Zero);return found;}
}`;
function ps(body){const r=spawnSync('powershell',['-NoProfile','-Command',`Add-Type -TypeDefinition '${source}';[BookmarkProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null;${body}`],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function cursor(x,y){ps(`if(-not [BookmarkProbe]::SetCursorPos(${Math.round(x)},${Math.round(y)})){throw 'Cursor move failed'}`);}
let owner,paperLeft=36;
function hover(x,y){ps(`$h=[BookmarkProbe]::Board(${owner});if(-not [BookmarkProbe]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x13)){throw 'Test raise failed'};if(-not [BookmarkProbe]::SetCursorPos(${Math.round(x)},${Math.round(y)})){throw 'Cursor move failed'}`);}
function click(x,y){ps(`[BookmarkProbe]::SetCursorPos(${Math.round(x)},${Math.round(y)})|Out-Null;[BookmarkProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 40;[BookmarkProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)`);}
function region(){return JSON.parse(ps(`$h=[BookmarkProbe]::Board(${owner});if($h -eq [IntPtr]::Zero){throw 'Own board missing'};$r=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetWindowRect($h,[ref]$r)|Out-Null;$g=[BookmarkProbe]::CreateRectRgn(0,0,0,0);$kind=[BookmarkProbe]::GetWindowRgn($h,$g);$c=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetRgnBox($g,[ref]$c)|Out-Null;$s=[BookmarkProbe]::GetDpiForWindow($h)/96.0;$gutter=[BookmarkProbe]::PtInRegion($g,[int](18*$s),[int](150*$s));$paper=[BookmarkProbe]::PtInRegion($g,[int]((${paperLeft}+1)*$s),[int](150*$s));$bookmark=[BookmarkProbe]::PtInRegion($g,[int](22*$s),[int](42*$s));$padding=[BookmarkProbe]::PtInRegion($g,[int](100*$s),[int](3*$s));[BookmarkProbe]::DeleteObject($g)|Out-Null;@{gutter=$gutter;paper=$paper;bookmark=$bookmark;padding=$padding;x=$r.left;y=$r.top;w=$r.right-$r.left;h=$r.bottom-$r.top;kind=$kind;clipW=$c.right-$c.left;clipH=$c.bottom-$c.top}|ConvertTo-Json -Compress`));}
function full(){const r=region();assert(r.kind===3&&!r.gutter&&r.paper&&r.bookmark&&!r.padding,JSON.stringify(r));}
const originalCursor=JSON.parse(ps('$p=[BookmarkProbe+Point]::new();[BookmarkProbe]::GetCursorPos([ref]$p)|Out-Null;@{x=$p.x;y=$p.y}|ConvertTo-Json -Compress'));
let browser,page;
await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:60000}).toBe(true);
page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={})=>page.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const position=()=>invoke('plugin:window|outer_position',{label:'main'});
const place=(x,y)=>invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:Math.round(x),y:Math.round(y)}}});
const armed=()=>page.getByLabel('展开板子并退出贴边收缩',{exact:true}),unarmed=()=>page.getByLabel('书签：开启贴边收缩',{exact:true});
try {
 await page.waitForFunction(()=>window.__TAURI_INTERNALS__?.invoke);assert.equal(await invoke('plugin:app|identifier'),release?'com.desktopboard.app':'com.desktopboard.interactiontest');
 await expect(page.getByText('已保存',{exact:true})).toBeVisible();let doc=await invoke('load_document');assert.equal(doc.boards.length,1);assert.equal(doc.items.length,0);assert.equal(doc.boards[0].collision,false);assert.equal(doc.boards[0].edgeHide,false);
 owner=(await invoke('read_icons')).pid;
 if(process.argv[4]){const names={heart:'爱心缝线',geometric:'极简几何',pixel:'像素科技',whale:'用户',knot:'中国结'};assert(names[process.argv[4]]);await page.getByLabel('更多工具',{exact:true}).click();await page.getByText('书签样式',{exact:true}).click();await page.getByLabel(`书签样式：${names[process.argv[4]]}`,{exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();await expect.poll(async()=>(await invoke('load_document')).boards[0].bookmarkStyle).toBe(process.argv[4]);}
 await invoke('plugin:window|set_always_on_top',{label:'main',value:true});const monitor=await invoke('plugin:window|current_monitor'),area=monitor.workArea,scale=monitor.scaleFactor;
 const xs=area.position.x,ys=area.position.y,aw=area.size.width,ah=area.size.height,w=Math.round(300*scale),h=Math.round(240*scale),bw=Math.round((['whale','knot'].includes(process.argv[4])?66:44)*scale),bh=Math.round((['whale','knot'].includes(process.argv[4])?90:60)*scale),inset=Math.round(12*scale);
 paperLeft=['whale','knot'].includes(process.argv[4])?58:36;
 const idle=()=>cursor(xs+aw/2,ys+ah/2);
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:w,height:h}}});await place(xs+150,ys+150);
 await expect.poll(async()=>{const b=(await invoke('load_document')).boards[0].bounds;return [b.w,b.h]}).toEqual([w,h]);
 doc=await invoke('load_document');doc.boards[0].paperRows=[{id:'note',height:1,parts:[{text:'Bookmark note kept'}]}];await invoke('save_board',{board:doc.boards[0],items:[],settings:doc.settings,origin:'fixture'});await page.reload();await expect(page.getByText('已保存',{exact:true})).toBeVisible();await invoke('set_level',{label:'main',level:'top'});
 // Real native hit testing must exclude the gutter even with docking disabled.
 full();hover(xs+250,ys+200);
 function hit(localX,localY){const r=region();return ps(`$h=[BookmarkProbe]::Board(${owner});$p=[BookmarkProbe+Point]::new();$p.x=${Math.round(r.x+localX*scale)};$p.y=${Math.round(r.y+localY*scale)};[BookmarkProbe]::GetAncestor([BookmarkProbe]::WindowFromPoint($p),2) -eq $h`)==='True';}
 assert.equal(hit(18,150),false);assert.equal(hit(1,150),false);assert.equal(hit(100,3),false);assert.equal(hit(paperLeft+2,150),true);assert.equal(hit(22,42),true);
 // The visible paper edge must still support real press-and-drag resizing.
 const beforeResize=region(),rx=Math.round(beforeResize.x+(paperLeft+2)*scale),ry=Math.round(beforeResize.y+150*scale);
 ps(`[BookmarkProbe]::SetCursorPos(${rx},${ry})|Out-Null;[BookmarkProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero);try{Start-Sleep -Milliseconds 150;for($i=1;$i -le 6;$i++){[BookmarkProbe]::SetCursorPos(${rx}-10*$i,${ry})|Out-Null;Start-Sleep -Milliseconds 40}}finally{[BookmarkProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}`);
 const resized=region();assert(Math.abs(resized.w-beforeResize.w-60)<=2,JSON.stringify({beforeResize,resized}));assert(Math.abs(resized.x-beforeResize.x+60)<=2);assert.equal(resized.h,beforeResize.h);full();
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:w,height:h}}});await place(xs+150,ys+150);await page.waitForTimeout(200);full();
 console.log('PASS native unarmed gutter/padding pass-through, bookmark hit and real paper-edge resize');
 const near=Math.round(8*scale),cases=[['left',xs,ys+100,xs-w+bw,ys+100,near,0],['right',xs+aw-w,ys+100,xs+aw-bw,ys+100,-near,0],['top',xs+100,ys,xs+100,ys-h+bh,0,near],['bottom',xs+100,ys+ah-h,xs+100,ys+ah-bh,0,-near]];
 for(const [edge,x,y,hx,hy,dx,dy] of cases){
  await place(x+dx,y+dy);idle();await page.waitForTimeout(1300);assert.deepEqual(await position(),{x:x+dx,y:y+dy},'Unarmed boards must never auto-snap or hide');
  hover(x+w/2,y+30);await unarmed().click();await expect(armed()).toHaveAttribute('aria-pressed','true');await expect.poll(position).toEqual({x,y});
  idle();await page.waitForTimeout(350);assert.deepEqual(await position(),{x,y},'Must remain open during the one-second leave delay');
  await expect.poll(position,{timeout:5000}).toEqual({x:hx,y:hy});await expect(armed()).toHaveClass(new RegExp(`bookmark-hidden bookmark-${edge}`));
  const r=region();assert.equal(r.clipW,bw);assert.equal(r.clipH,bh);assert.equal(r.kind,2);await expect(page.locator('.board')).toHaveCSS('opacity','0');
  const saved=await invoke('load_document');assert.equal(saved.boards[0].bounds.x,x);assert.equal(saved.boards[0].bounds.y,y);assert.equal(saved.boards[0].edgeHide,true);
  await expect.poll(()=>JSON.parse(readFileSync(join(root,'board.json'))).boards[0].bounds.x).toBe(x);
  const bx=edge==='left'?xs+bw/2:edge==='right'?xs+aw-bw/2:x+inset+bw/2,by=edge==='top'?ys+bh/2:edge==='bottom'?ys+ah-bh/2:y+inset+bh/2;
  hover(bx,by);await page.waitForTimeout(1300);assert.deepEqual(await position(),{x:hx,y:hy},'Hovering bookmark must not unfold');
  await page.screenshot({path:join(root,`bookmark-${edge}.png`)});click(bx,by);await expect.poll(position).toEqual({x,y});await expect(unarmed()).toHaveAttribute('aria-pressed','false');await expect.poll(async()=>(await invoke('load_document')).boards[0].edgeHide).toBe(false);full();idle();await page.waitForTimeout(1300);assert.deepEqual(await position(),{x,y});
  console.log(`PASS native ${edge}: explicit mode, snap, one-second delay, only ${bw}x${bh}px bookmark, hover stays closed, real click expands/disarms`);
 }
 // Crossing must work beyond the old 16px absolute-distance cutoff. Keep the
 // physical left button held while moving, then verify snapping on release.
 const depth=424;
 for(const [edge,x,y,hx,hy] of cases){
  await place(xs+300,ys+200);hover(xs+300+w/2,ys+200+h/2);await unarmed().click();
  hover(xs+300+w/2,ys+200+h/2);ps('[BookmarkProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero)');
  const tx=x+(edge==='left'?-depth:edge==='right'?depth:0),ty=y+(edge==='top'?-depth:edge==='bottom'?depth:0);
  try {await place(tx,ty);await page.waitForTimeout(350);assert.deepEqual(await position(),{x:tx,y:ty},'Held dragging must retain the user position, even outside the screen');}
  finally {ps('[BookmarkProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero)');}
  await expect.poll(position).toEqual({x,y});idle();await expect.poll(position,{timeout:5000}).toEqual({x:hx,y:hy});
  await expect(armed()).toHaveClass(new RegExp(`bookmark-hidden bookmark-${edge}`));const r=region();assert.equal(r.clipW,bw);assert.equal(r.clipH,bh);
  const bx=edge==='left'?xs+bw/2:edge==='right'?xs+aw-bw/2:x+inset+bw/2,by=edge==='top'?ys+bh/2:edge==='bottom'?ys+ah-bh/2:y+inset+bh/2;
  click(bx,by);await expect.poll(position).toEqual({x,y});await expect(unarmed()).toHaveAttribute('aria-pressed','false');full();
  console.log(`PASS native ${edge} overflow ${depth}px: no snap while held, snap on release, bookmark-only hide and real-click restore`);
 }
 // Reproduce the user's recorded 592x537 window at x=1752 on a 1920px desktop.
 // Scale the coordinates by the monitor's work area so this also runs elsewhere.
 const userW=592,userH=537,userX=xs+aw-userW+424,userY=ys+184;
 await place(xs+300,ys+200);await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:userW,height:userH}}});
 hover(xs+350,ys+250);await unarmed().click();await place(userX,userY);
 await expect.poll(position).toEqual({x:xs+aw-userW,y:userY});await armed().click();full();
 // An outward right crossing takes priority over being 1px from the top edge.
 await place(xs+300,ys+200);hover(xs+350,ys+250);await unarmed().click();await place(xs+aw-userW+200,ys+1);
 await expect.poll(position).toEqual({x:xs+aw-userW,y:ys+1});await armed().click();
 // When both sides are crossed, greater overflow decides the docking edge.
 await place(xs+300,ys+200);hover(xs+350,ys+250);await unarmed().click();await place(xs-80,ys-150);
 await expect.poll(position).toEqual({x:xs,y:ys});idle();await expect.poll(position,{timeout:5000}).toEqual({x:xs,y:ys-userH+bh});await expect(armed()).toHaveClass(/bookmark-top/);
 click(xs+inset+bw/2,ys+bh/2);await expect(unarmed()).toHaveAttribute('aria-pressed','false');await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:w,height:h}}});
 console.log('PASS native recorded user position and corners: overflow beats proximity, greater crossing wins');
 // Armed preference survives reload; moving away preserves the new location.
 await place(xs,ys+100);await unarmed().click();idle();await expect.poll(position,{timeout:5000}).toEqual({x:xs-w+bw,y:ys+100});await page.reload();await expect(page.getByText('已保存',{exact:true})).toBeVisible();await invoke('set_level',{label:'main',level:'top'});idle();await expect.poll(position,{timeout:5000}).toEqual({x:xs-w+bw,y:ys+100});
 await place(xs+150,ys+150);await expect.poll(position).toEqual({x:xs+150,y:ys+150});await expect(armed()).not.toHaveClass(/bookmark-hidden/);full();idle();await page.waitForTimeout(1500);assert.deepEqual(await position(),{x:xs+150,y:ys+150});await armed().click();
 console.log('PASS native armed reload, moving away and expanded-position persistence');
 await place(xs+100,ys+ah-h);await unarmed().click();await page.getByLabel('更多工具').click();await page.getByText('外观与设置',{exact:true}).click();idle();await page.waitForTimeout(1500);assert.equal((await position()).y,ys+ah-h);await expect(page.getByText('点击左上角书签开启贴边收缩。',{exact:false})).toBeVisible();await page.getByRole('button',{name:'完成',exact:true}).click();
 await page.getByLabel('绘图与裁剪',{exact:true}).click();await page.getByText('铅笔绘画',{exact:true}).click();idle();await page.waitForTimeout(1500);assert.equal((await position()).y,ys+ah-h);await page.locator('.toolbar').click({button:'right'});
 await page.getByLabel('锁定板子',{exact:true}).click();await expect(armed()).toBeDisabled();idle();await page.waitForTimeout(1500);assert.equal((await position()).y,ys+ah-h);await page.getByLabel('解锁板子',{exact:true}).click();idle();await expect.poll(position,{timeout:5000}).toEqual({x:xs+100,y:ys+ah-bh});
 await invoke('set_edge_hide',{label:'main',enabled:false});await expect.poll(position).toEqual({x:xs+100,y:ys+ah-h});full();doc=await invoke('load_document');doc.boards[0].edgeHide=false;await invoke('save_board',{board:doc.boards[0],items:[],settings:doc.settings,origin:'fixture'});
 for(let i=0;i<2;i++){await page.reload();await expect(page.getByText('已保存',{exact:true})).toBeVisible();full();assert.equal((await invoke('load_document')).boards[0].edgeHide,false);}
 for(const [width,height] of [[w+100,h+80],[w,h]]){await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width,height}}});await expect.poll(async()=>{const b=(await invoke('load_document')).boards[0].bounds;return [b.w,b.h]}).toEqual([width,height]);full();}
 assert((await invoke('load_document')).boards[0].paperRows.flatMap(r=>r.parts.map(p=>p.text??'')).join('').includes('Bookmark note kept'));await page.screenshot({path:join(root,'bookmark-expanded.png')});
 console.log('PASS native tool/lock suspension, disable/reload/resize region restoration and original writing');
 // Capture the real screen while the test board is inactive, where the old
 // thick native border was visible. The board remains topmost for visibility.
 const screenPath=join(root,'bookmark-inactive-screen.png').replaceAll("'","''");
 ps(`$h=[BookmarkProbe]::Board(${owner});Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$f=[Windows.Forms.Form]::new();$f.FormBorderStyle='None';$f.ShowInTaskbar=$false;$f.StartPosition='Manual';$screen=[Windows.Forms.SystemInformation]::VirtualScreen;$f.Location=[Drawing.Point]::new($screen.Right-70,$screen.Top+70);$f.Size=[Drawing.Size]::new(40,40);$f.TopMost=$true;try{$f.Show();[Windows.Forms.Application]::DoEvents();[BookmarkProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null;[BookmarkProbe]::SetWindowPos($f.Handle,[IntPtr](-1),$screen.Right-70,$screen.Top+70,40,40,0x10)|Out-Null;$point=[BookmarkProbe+Point]::new();$point.x=$screen.Right-50;$point.y=$screen.Top+90;if([BookmarkProbe]::GetAncestor([BookmarkProbe]::WindowFromPoint($point),2) -ne $f.Handle){throw 'Own focus helper is obscured'};[BookmarkProbe]::SetCursorPos($point.x,$point.y)|Out-Null;[BookmarkProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[BookmarkProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 200;[Windows.Forms.Application]::DoEvents();if([BookmarkProbe]::GetForegroundWindow() -eq $h){throw 'Test board is still active'};$r=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetWindowRect($h,[ref]$r)|Out-Null;$b=[Drawing.Bitmap]::new($r.right-$r.left,$r.bottom-$r.top);$g=[Drawing.Graphics]::FromImage($b);try{$g.CopyFromScreen($r.left,$r.top,0,0,$b.Size);$b.Save('${screenPath}',[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}}finally{$f.Close();$f.Dispose()}`);
 console.log('PASS native inactive board CopyFromScreen capture');

} finally {cursor(originalCursor.x,originalCursor.y);if(page)await invoke('quit_app').catch(()=>{});if(browser)await browser.close();}
