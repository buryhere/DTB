param(
  [Parameter(Mandatory=$true)][uint32]$OwnerPid,
  [Parameter(Mandatory=$true)][string]$ImagePath,
  [switch]$InvalidateAlpha
)
$ErrorActionPreference = 'Stop'
# Diagnostic scope is the explicitly identified overlay. Never changes Explorer
# visibility or another application. Screenshots belong in ignored test data.
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices;
using System.Drawing; using System.Drawing.Imaging;
public class PresentationProbe {
 public delegate bool CB(IntPtr h,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(CB c,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p,CB c,IntPtr l);
 [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
 [DllImport("user32.dll")] static extern int GetClassName(IntPtr h,StringBuilder b,int n);
 [DllImport("user32.dll")] public static extern IntPtr GetProp(IntPtr h,string name);
 [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
 [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
 [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h,IntPtr r);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetLayeredWindowAttributes(IntPtr h,out uint c,out byte a,out uint f);
 [DllImport("user32.dll")] public static extern bool SetLayeredWindowAttributes(IntPtr h,uint c,byte a,uint f);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
 public static IntPtr Find(uint owner) {
  IntPtr found=IntPtr.Zero; CB scan=(h,l)=>{uint p; GetWindowThreadProcessId(h,out p);
   if(p==owner){var t=new StringBuilder(256);GetWindowText(h,t,256);if(t.ToString()=="\u684c\u9762\u56fe\u6807\u52a8\u753b")found=h;}return true;};
  EnumWindows((h,l)=>{scan(h,l);EnumChildWindows(h,scan,l);return true;},IntPtr.Zero);return found;
 }
 public static void Capture(string path,int x,int y,int width,int height) {
  using(var bitmap=new Bitmap(width,height)) {using(var g=Graphics.FromImage(bitmap)) {
   g.CopyFromScreen(x,y,0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
  } bitmap.Save(path,ImageFormat.Png);}
 }
 public static IntPtr Desktop() {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,l)=>{var c=new StringBuilder(256);GetClassName(h,c,256);
   if(c.ToString()=="Progman"||c.ToString()=="WorkerW")EnumChildWindows(h,(ch,cl)=>{var name=new StringBuilder(256);GetClassName(ch,name,256);if(name.ToString()=="SHELLDLL_DefView")found=ch;return true;},IntPtr.Zero);return true;},IntPtr.Zero);
  return found;
 }
 public static int RegionType(IntPtr h){var r=CreateRectRgn(0,0,0,0);try{return GetWindowRgn(h,r);}finally{DeleteObject(r);}}
 public static double DesktopCoverage(int x,int y,int width,int height){int visible=0,total=0;
  for(int row=0;row<6;row++)for(int col=0;col<10;col++){var p=new Point{x=x+(2*col+1)*width/20,y=y+(2*row+1)*height/14};var h=GetAncestor(WindowFromPoint(p),2);var c=new StringBuilder(256);GetClassName(h,c,256);if(c.ToString()=="Progman"||c.ToString()=="WorkerW")visible++;total++;}return (double)visible/total;
 }
}
'@
$previous = [PresentationProbe]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
try {
  $overlay = [PresentationProbe]::Find($OwnerPid)
  if ($overlay -eq [IntPtr]::Zero) { throw 'Test overlay not found.' }
  [uint32]$color=0; [byte]$alpha=0; [uint32]$flags=0
  $initialized=[PresentationProbe]::GetLayeredWindowAttributes($overlay,[ref]$color,[ref]$alpha,[ref]$flags)
  $visible=[PresentationProbe]::IsWindowVisible($overlay)
  $x=[PresentationProbe]::GetSystemMetrics(76); $y=[PresentationProbe]::GetSystemMetrics(77)
  $width=[PresentationProbe]::GetSystemMetrics(78); $height=[PresentationProbe]::GetSystemMetrics(79)
  [PresentationProbe]::Capture($ImagePath,$x,$y,$width,$height)
  if ($InvalidateAlpha -and -not [PresentationProbe]::SetLayeredWindowAttributes($overlay,0,0,2)) {throw 'Could not invalidate isolated test overlay.'}
  $desktop=[PresentationProbe]::Desktop()
  @{ initialized=$initialized; alpha=$alpha; flags=$flags; visible=$visible; origin=@{x=$x;y=$y}; region=[PresentationProbe]::RegionType($desktop); clipOwner=[PresentationProbe]::GetProp($desktop,'DesktopBoard.IconClip.Owner').ToInt64(); desktopCoverage=[PresentationProbe]::DesktopCoverage($x,$y,$width,$height) } | ConvertTo-Json -Compress
} finally { [void][PresentationProbe]::SetThreadDpiAwarenessContext($previous) }
