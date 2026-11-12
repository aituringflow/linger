param(
  [ValidateSet('inspect','wheel','click')][string]$Action = 'inspect',
  [long]$TargetHandle,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Delta = 120,
  [int]$Count = 1
)
$ErrorActionPreference = 'Stop'
Add-Type 'using System; using System.Runtime.InteropServices; public static class CuaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context); }'
[void][CuaDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class BgInput {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
}
'@
$target = [IntPtr]$TargetHandle
if (-not [BgInput]::IsWindow($target)) { throw '微信窗口句柄无效。' }
$children = [System.Collections.Generic.List[object]]::new()
$callback = [BgInput+EnumProc]{ param($h,$p)
  $class = [System.Text.StringBuilder]::new(256)
  [void][BgInput]::GetClassName($h,$class,256)
  $r = New-Object BgInput+RECT
  [void][BgInput]::GetWindowRect($h,[ref]$r)
  $children.Add(@{ handle=$h.ToInt64(); class=$class.ToString(); left=$r.Left; top=$r.Top; width=$r.Right-$r.Left; height=$r.Bottom-$r.Top })
  return $true
}
[void][BgInput]::EnumChildWindows($target,$callback,[IntPtr]::Zero)
if ($Action -eq 'inspect') { @{ children=$children } | ConvertTo-Json -Depth 4 -Compress; exit }
$receiver = $target
$render = $children | Where-Object { $_.class -eq 'MMUIRenderSubWindowHW' } | Select-Object -First 1
if ($render) { $receiver = [IntPtr]$render.handle }
if ($Action -eq 'click') { $receiver = $target }
$rootRect = New-Object BgInput+RECT
[void][BgInput]::GetWindowRect($target,[ref]$rootRect)
if ($X -lt 0 -or $Y -lt 0 -or $X -ge ($rootRect.Right-$rootRect.Left) -or $Y -ge ($rootRect.Bottom-$rootRect.Top)) { throw '坐标不在微信窗口内。' }
$screenX = $rootRect.Left + $X
$screenY = $rootRect.Top + $Y
if ($Action -eq 'wheel') {
  $signed = [int32]$Delta
  $wparam = [long](([long]($signed -band 0xffff)) -shl 16)
  $lparam = [long](($screenX -band 0xffff) -bor (($screenY -band 0xffff) -shl 16))
  for ($i=0;$i -lt [Math]::Min([Math]::Max($Count,1),30);$i++) {
    if (-not [BgInput]::PostMessage($receiver,0x020A,[IntPtr]$wparam,[IntPtr]$lparam)) { throw '后台滚轮投递失败。' }
    Start-Sleep -Milliseconds 30
  }
} else {
  $childRect = New-Object BgInput+RECT
  [void][BgInput]::GetWindowRect($receiver,[ref]$childRect)
  $clientX = $screenX - $childRect.Left
  $clientY = $screenY - $childRect.Top
  $lparam = [long](($clientX -band 0xffff) -bor (($clientY -band 0xffff) -shl 16))
  if (-not [BgInput]::PostMessage($receiver,0x0200,[IntPtr]0,[IntPtr]$lparam)) { throw '后台移动投递失败。' }
  Start-Sleep -Milliseconds 50
  if (-not [BgInput]::PostMessage($receiver,0x0201,[IntPtr]1,[IntPtr]$lparam)) { throw '后台按下投递失败。' }
  Start-Sleep -Milliseconds 80
  if (-not [BgInput]::PostMessage($receiver,0x0202,[IntPtr]0,[IntPtr]$lparam)) { throw '后台抬起投递失败。' }
}
@{ action=$Action; receiver=$receiver.ToInt64(); x=$X; y=$Y; count=$Count } | ConvertTo-Json -Compress
