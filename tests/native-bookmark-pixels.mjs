// Real desktop compositing over an owned, solid background. Internal PNG alpha
// is the oracle for transparent bookmark corners, not a screenshot substitute.
import {chromium,expect} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=resolve(process.argv[2]??''),release=root.startsWith(resolve('.native-release-test-data')+'\\');
assert(release||root.startsWith(resolve('.native-interaction-test-data')+'\\'));
const port=Number(process.argv[3]??(release?9224:9222));assert.equal(port,release?9224:9222);
const source=readFileSync('tests/native-bookmark.mjs','utf8').match(/const source=`([\s\S]*?)`;/)[1].replace(' public static IntPtr Board(uint pid)',`
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static IntPtr BoardAt(uint pid,int x,int y){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);Rect r;GetWindowRect(h,out r);if(owner==pid&&IsWindowVisible(h)&&r.left==x&&r.top==y)found=h;return true;},IntPtr.Zero);return found;}
 public static IntPtr Board(uint pid)`);
function ps(body){return execFileSync('powershell',['-NoProfile','-Command',`Add-Type -TypeDefinition '${source}';[BookmarkProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null;${body}`],{encoding:'utf8',windowsHide:true}).trim();}
const originalCursor=JSON.parse(ps('$p=[BookmarkProbe+Point]::new();[BookmarkProbe]::GetCursorPos([ref]$p)|Out-Null;@{x=$p.x;y=$p.y}|ConvertTo-Json -Compress'));
let browser,page;
await expect.poll(async()=>{try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{timeout:1500});return true}catch{return false}},{timeout:60000}).toBe(true);
page=browser.contexts()[0].pages().find(p=>!p.url().includes('overlay='));
const invoke=(name,args={},target=page)=>target.evaluate(({name,args})=>window.__TAURI_INTERNALS__.invoke(name,args),{name,args});
const compare=String.raw`
from PIL import Image
import sys,json
reference=Image.open(sys.argv[1]).convert('RGBA');screen=Image.open(sys.argv[2]).convert('RGB');scale=float(sys.argv[3]);paperLeft=float(sys.argv[4]);bookmarkHeight=float(sys.argv[5])
# A fractional logical WebView width can add one raster pixel at 125% DPI.
# Compare the unchanged bookmark origin/region, not the far paper boundary.
assert all(abs(a-b)<=1 for a,b in zip(reference.size,screen.size)),(reference.size,screen.size)
background=(30,40,50);transparent=[];opaque=[];allPixels=[]
for y in range(round(12*scale),round((12+bookmarkHeight)*scale)):
 for x in range(round(paperLeft*scale)):
  rgba=reference.getpixel((x,y));actual=screen.getpixel((x,y))
  expected=[round(c*rgba[3]/255+b*(1-rgba[3]/255)) for c,b in zip(rgba[:3],background)]
  allPixels.append(max(abs(a-b) for a,b in zip(actual,expected)))
  if rgba[3]<=2:transparent.append(max(abs(a-b) for a,b in zip(actual,background)))
  elif rgba[3]>=192:
   opaque.append(max(abs(a-b) for a,b in zip(actual,expected)))
metrics={'transparentSamples':len(transparent),'transparentWrong':sum(d>6 for d in transparent),'opaqueSamples':len(opaque),'opaqueMatch':sum(d<=8 for d in opaque)/max(1,len(opaque)),'allPixels':len(allPixels),'allMatch':sum(d<=8 for d in allPixels)/max(1,len(allPixels))}
print(json.dumps(metrics));assert len(transparent)>50 and metrics['transparentWrong']==0,metrics
assert len(opaque)>500 and metrics['opaqueMatch']>.995,metrics
assert metrics['allMatch']>.995,metrics
`;
let owner,scale;
async function capture(target,label,name){
 const position=await invoke('plugin:window|outer_position',{label},target),ref=join(root,name+'-webview.png'),screen=join(root,name+'-screen.png');
 await target.screenshot({path:ref,omitBackground:true});
 const escape=p=>p.replaceAll("'","''");
 // A temporary background form supplies known pixels beneath this board. The
 // board is raised without activation; real clicks alternate focus safely.
 ps(`Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$h=[BookmarkProbe]::BoardAt(${owner},${position.x},${position.y});if($h -eq [IntPtr]::Zero){throw 'Own window missing'};$r=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetWindowRect($h,[ref]$r)|Out-Null;$s=[BookmarkProbe]::GetDpiForWindow($h)/96.0;$f=[Windows.Forms.Form]::new();$f.FormBorderStyle='None';$f.ShowInTaskbar=$false;$f.StartPosition='Manual';$f.Location=[Drawing.Point]::new($r.left-50,$r.top-50);$f.Size=[Drawing.Size]::new($r.right-$r.left+100,$r.bottom-$r.top+100);$f.BackColor=[Drawing.Color]::FromArgb(30,40,50);$f.TopMost=$true;function Click($x,$y){[BookmarkProbe]::SetWindowPos($f.Handle,[IntPtr](-1),0,0,0,0,0x13)|Out-Null;[BookmarkProbe]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x13)|Out-Null;[Windows.Forms.Application]::DoEvents();$cp=[BookmarkProbe+Point]::new();$cp.x=$x;$cp.y=$y;$root=[BookmarkProbe]::GetAncestor([BookmarkProbe]::WindowFromPoint($cp),2);if($root -ne $h -and $root -ne $f.Handle){$fr=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetWindowRect($f.Handle,[ref]$fr)|Out-Null;throw ('Own click target is obscured: rect='+$fr.left+','+$fr.top+','+$fr.right+','+$fr.bottom+' visible='+[BookmarkProbe]::IsWindowVisible($f.Handle)+'  point='+$x+','+$y+' hit='+$root+' board='+$h+' backdrop='+$f.Handle)};[BookmarkProbe]::SetCursorPos($x,$y)|Out-Null;[BookmarkProbe]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[BookmarkProbe]::mouse_event(4,0,0,0,[UIntPtr]::Zero);Start-Sleep -Milliseconds 80;[Windows.Forms.Application]::DoEvents()};try{$f.Show();[Windows.Forms.Application]::DoEvents();[BookmarkProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))|Out-Null;[BookmarkProbe]::SetWindowPos($f.Handle,[IntPtr](-1),$r.left-50,$r.top-50,$r.right-$r.left+100,$r.bottom-$r.top+100,0x10)|Out-Null;[BookmarkProbe]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x13)|Out-Null;for($i=0;$i -lt 3;$i++){Click ([int]($r.left+120*$s)) ([int]($r.top+25*$s));Click ($r.left-30) ($r.top-30)};if([BookmarkProbe]::GetForegroundWindow() -eq $h){throw 'Board is still active'};$hit=[BookmarkProbe]::SendMessage($h,0x84,[IntPtr]::Zero,[IntPtr]((($r.top+[int](20*$s))-shl 16)-bor (($r.left+[int](1*$s))-band 65535)));if($hit.ToInt64() -ne 1){throw 'Bookmark edge inherited native resize hit'};[BookmarkProbe]::SetWindowPos($h,[IntPtr](-1),0,0,0,0,0x13)|Out-Null;[BookmarkProbe]::SetWindowPos($f.Handle,$h,0,0,0,0,0x13)|Out-Null;Start-Sleep -Milliseconds 250;[Windows.Forms.Application]::DoEvents();$point=[BookmarkProbe+Point]::new();$point.x=$r.left+1;$point.y=$r.top+[int](150*$s);if([BookmarkProbe]::GetAncestor([BookmarkProbe]::WindowFromPoint($point),2) -ne $f.Handle){$fr=[BookmarkProbe+Rect]::new();[BookmarkProbe]::GetWindowRect($f.Handle,[ref]$fr)|Out-Null;throw ('Controlled backdrop is obscured; form='+$fr.left+','+$fr.top+','+$fr.right+','+$fr.bottom+' point='+$point.x+','+$point.y)};$b=[Drawing.Bitmap]::new($r.right-$r.left,$r.bottom-$r.top);$g=[Drawing.Graphics]::FromImage($b);try{$g.CopyFromScreen($r.left,$r.top,0,0,$b.Size);$b.Save('${escape(screen)}',[Drawing.Imaging.ImageFormat]::Png)}finally{$g.Dispose();$b.Dispose()}}finally{$f.Close();$f.Dispose()}`);
 const paper=await target.locator('.board').boundingBox(),bookmark=await target.locator('.bookmark').boundingBox();
 const result=execFileSync('python',['-c',compare,ref,screen,String(scale),String(paper.x),String(bookmark.height)],{encoding:'utf8',windowsHide:true}).trim();console.log(`PASS ${name}: real inactive pixels and bookmark resize exclusion ${result}`);
}
try{
 await page.locator('.save-state').waitFor();assert.equal(await invoke('plugin:app|identifier'),release?'com.desktopboard.app':'com.desktopboard.interactiontest');
 const doc=await invoke('load_document');assert.equal(doc.boards.length,1);assert.equal(doc.items.length,0);assert.equal(doc.boards[0].collision,false);assert.equal(doc.boards[0].edgeHide,false);assert.equal(doc.boards[0].autoFade.enabled,false);
 owner=(await invoke('read_icons')).pid;scale=(await invoke('plugin:window|current_monitor')).scaleFactor;
 await invoke('plugin:window|set_size',{label:'main',value:{Physical:{width:Math.round(300*scale),height:Math.round(240*scale)}}});await invoke('plugin:window|set_position',{label:'main',value:{Physical:{x:500,y:300}}});await invoke('set_level',{label:'main',level:'top'});ps('[BookmarkProbe]::SetCursorPos(450,250)|Out-Null');
 for(const [id,name] of [['heart','爱心缝线'],['geometric','极简几何'],['pixel','像素科技'],['whale','用户'],['knot','中国结']]){
  await page.getByLabel('更多工具',{exact:true}).click();await page.getByText('书签样式',{exact:true}).click();await page.getByLabel(`书签样式：${name}`,{exact:true}).click();await page.getByRole('button',{name:'完成',exact:true}).click();
  await expect.poll(async()=>(await invoke('load_document')).boards[0].bookmarkStyle).toBe(id);
  ps('[BookmarkProbe]::SetCursorPos(450,250)|Out-Null');await capture(page,'main',`bookmark-inactive-${id}`);
 }
 await page.reload();await page.locator('.save-state').waitFor();await invoke('set_level',{label:'main',level:'top'});await capture(page,'main','bookmark-reload');
 await page.getByLabel('锁定板子',{exact:true}).click();await page.getByLabel('解锁板子',{exact:true}).click();ps('[BookmarkProbe]::SetCursorPos(450,250)|Out-Null');await capture(page,'main','bookmark-unlocked');
 await page.getByLabel('更多工具').click();await page.getByText('新建板子',{exact:true}).click();
 await expect.poll(async()=>(await invoke('load_document')).boards.length).toBe(2);
 const child=browser.contexts()[0].pages().find(p=>p!==page&&!p.url().includes('overlay='));assert(child);await child.locator('.save-state').waitFor();const childDoc=await invoke('load_document'),id=childDoc.boards.find(b=>b.id!=='main').id,label='board-'+id;
 assert.equal(childDoc.boards.find(b=>b.id===id).bookmarkStyle,'knot');await expect(child.locator('.bookmark')).toHaveAttribute('data-style','knot');
 await invoke('plugin:window|set_position',{label,value:{Physical:{x:500,y:300}}},child);await invoke('plugin:window|hide',{label:'main'});await invoke('set_level',{label,level:'top'},child);ps('[BookmarkProbe]::SetCursorPos(450,250)|Out-Null');await capture(child,label,'bookmark-child');
}finally{ps(`[BookmarkProbe]::SetCursorPos(${originalCursor.x},${originalCursor.y})|Out-Null`);if(page)await invoke('quit_app').catch(()=>{});if(browser)await browser.close();}
