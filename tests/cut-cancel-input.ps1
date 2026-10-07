param([ValidateSet('probe','down','up','click','escape')][string]$Action='probe',[int]$X=-1,[int]$Y=-1)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CutCancelMouse {
 public delegate bool EnumProc(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int max);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [StructLayout(LayoutKind.Sequential)] public struct POINT {public int X,Y;public POINT(int x,int y){X=x;Y=y;}}
 public static string Class(IntPtr hwnd){var b=new StringBuilder(256);GetClassName(hwnd,b,256);return b.ToString();}
 public static string[] Menus(){var menus=new List<string>();EnumWindows((h,p)=>{string c=Class(h);if(IsWindowVisible(h)&&(c=="#32768"||c.Contains("Popup")||c=="Windows.UI.Core.CoreWindow"))menus.Add(h.ToInt64()+":"+c);return true;},IntPtr.Zero);return menus.ToArray();}
}
'@
[CutCancelMouse]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
if($X -lt 0){$X=[CutCancelMouse]::GetSystemMetrics(0)-180}
if($Y -lt 0){$Y=[CutCancelMouse]::GetSystemMetrics(1)-140}
if($Action -eq 'down' -or $Action -eq 'click'){
 [CutCancelMouse]::SetCursorPos($X,$Y) | Out-Null
 Start-Sleep -Milliseconds 80
 [CutCancelMouse]::mouse_event(8,0,0,0,[UIntPtr]::Zero)
}
if($Action -eq 'up' -or $Action -eq 'click'){
 if($Action -eq 'click'){Start-Sleep -Milliseconds 90}
 [CutCancelMouse]::mouse_event(16,0,0,0,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 350
}
if($Action -eq 'escape'){
 [CutCancelMouse]::keybd_event(27,0,0,[UIntPtr]::Zero)
 [CutCancelMouse]::keybd_event(27,0,2,[UIntPtr]::Zero)
 Start-Sleep -Milliseconds 200
}
@{x=$X;y=$Y;target=[CutCancelMouse]::Class([CutCancelMouse]::WindowFromPoint([CutCancelMouse+POINT]::new($X,$Y)));menus=@([CutCancelMouse]::Menus())} | ConvertTo-Json -Compress
