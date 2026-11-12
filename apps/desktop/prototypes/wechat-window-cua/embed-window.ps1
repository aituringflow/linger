param(
  [ValidateSet('attach','position','detach','status')][string]$Action,
  [long]$ParentHandle,
  [long]$TargetHandle,
  [long]$OriginalParent = 0,
  [long]$OriginalStyle = 0,
  [int]$OriginalX = 0,
  [int]$OriginalY = 0,
  [int]$OriginalWidth = 0,
  [int]$OriginalHeight = 0,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$Width = 400,
  [int]$Height = 400
)
$ErrorActionPreference = 'Stop'
Add-Type 'using System; using System.Runtime.InteropServices; public static class CuaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context); }'
[void][CuaDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeEmbed {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
  [DllImport("user32.dll", EntryPoint="SetWindowLongPtrW", SetLastError=true)] public static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr child, IntPtr parent);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("kernel32.dll")] public static extern void SetLastError(uint error);
}
'@
$target = [IntPtr]$TargetHandle
if (-not [NativeEmbed]::IsWindow($target)) { throw '目标窗口已关闭。' }
if ($Action -eq 'attach') {
  $parent = [IntPtr]$ParentHandle
  if (-not [NativeEmbed]::IsWindow($parent)) { throw '壳窗口已关闭。' }
  $style = [NativeEmbed]::GetWindowLongPtr($target, -16).ToInt64()
  $oldParent = [NativeEmbed]::GetParent($target).ToInt64()
  $r = New-Object NativeEmbed+RECT
  [void][NativeEmbed]::GetWindowRect($target, [ref]$r)
  $childStyle = ($style -band (-bnot [long]0x80000000)) -bor [long]0x40000000
  [void][NativeEmbed]::SetWindowLongPtr($target, -16, [IntPtr]$childStyle)
  [NativeEmbed]::SetLastError(0)
  [void][NativeEmbed]::SetParent($target, $parent)
  $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($errorCode -ne 0 -or [NativeEmbed]::GetParent($target) -ne $parent) {
    [void][NativeEmbed]::SetWindowLongPtr($target, -16, [IntPtr]$style)
    throw "SetParent 失败，Win32 错误 $errorCode"
  }
  @{ originalParent=$oldParent; originalStyle=$style; originalX=$r.Left; originalY=$r.Top; originalWidth=$r.Right-$r.Left; originalHeight=$r.Bottom-$r.Top; targetHandle=$TargetHandle } |
    ConvertTo-Json -Compress
}
if ($Action -eq 'position') {
  if (-not [NativeEmbed]::SetWindowPos($target, [IntPtr]::Zero, $X, $Y, $Width, $Height, 0x0034)) {
    throw "定位嵌入窗口失败：$([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $actual = New-Object NativeEmbed+RECT
  [void][NativeEmbed]::GetWindowRect($target, [ref]$actual)
  @{ x=$X; y=$Y; width=$Width; height=$Height; actualWidth=$actual.Right-$actual.Left; actualHeight=$actual.Bottom-$actual.Top } | ConvertTo-Json -Compress
}
if ($Action -eq 'status') {
  $r = New-Object NativeEmbed+RECT
  [void][NativeEmbed]::GetWindowRect($target, [ref]$r)
  @{ parent=[NativeEmbed]::GetParent($target).ToInt64(); left=$r.Left; top=$r.Top; width=$r.Right-$r.Left; height=$r.Bottom-$r.Top } | ConvertTo-Json -Compress
}
if ($Action -eq 'detach') {
  [void][NativeEmbed]::SetParent($target, [IntPtr]$OriginalParent)
  [void][NativeEmbed]::SetWindowLongPtr($target, -16, [IntPtr]$OriginalStyle)
  [void][NativeEmbed]::SetWindowPos($target, [IntPtr]::Zero, $OriginalX, $OriginalY, $OriginalWidth, $OriginalHeight, 0x0034)
  @{ restored=$true } | ConvertTo-Json -Compress
}
