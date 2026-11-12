param(
  [ValidateSet('prepare','status','capture','inspect','click','scroll')][string]$Action = 'status',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Delta = -3,
  [long]$TargetHandle = 0,
  [string]$Output = (Join-Path $PSScriptRoot 'capture.png')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'window-selection.ps1')
trap { [Console]::Error.WriteLine((Format-WechatError $_.Exception.Message)); exit 1 }
Add-Type 'using System; using System.Runtime.InteropServices; public static class CuaDpi { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context); }'
[void][CuaDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class WechatWindowNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
'@

function Get-WechatWindowKind([IntPtr]$handle, [string]$className) {
  try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $root) { return 'unknown' }
    $loginId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'login_layout_')
    if ($root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $loginId)) { return 'login' }
    foreach ($name in @('进入微信','登录微信','扫码登录','Log in to WeChat')) {
      $loginName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $loginElements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $loginName)
      for ($i = 0; $i -lt $loginElements.Count; $i++) {
        if ($loginElements.Item($i).Current.ControlType -eq [System.Windows.Automation.ControlType]::Button) { return 'login' }
      }
    }
    foreach ($id in @('MainView','session_list')) {
      if ($root.Current.AutomationId -eq $id) { return 'chat' }
      $chatId = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
      if ($root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $chatId)) { return 'chat' }
    }
    # Weixin 4.x exposes only two generic panes through UI Automation. Its
    # logged-in main window has a native render pane and a full chat-sized frame.
    # Check login controls above first so a login window is never reused.
    if ($className -match '^Qt\d+QWindowIcon$' -and $root.Current.Name -eq '微信') {
      $renderName = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, 'MMUIRenderSubWindowHW')
      $rect = $root.Current.BoundingRectangle
      if ($rect.Width -ge 700 -and $rect.Height -ge 500 -and $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $renderName)) { return 'chat' }
    }
    # The legacy client uses a dedicated main-window class distinct from its login window.
    if ($className -in @('WeChatMainWndForPC','WeChatMainWnd')) { return 'chat' }
  } catch { return 'unknown' }
  return 'unknown'
}

function Get-WechatCandidates([object[]]$processes) {
  $byId = @{}
  foreach ($process in $processes) { $byId[[int]$process.Id] = $process }
  $windows = [System.Collections.Generic.List[object]]::new()
  $callback = [WechatWindowNative+EnumProc]{ param($h,$p)
    $pidValue = [uint32]0
    [void][WechatWindowNative]::GetWindowThreadProcessId($h,[ref]$pidValue)
    if (-not $byId.ContainsKey([int]$pidValue)) { return $true }
    $class = [System.Text.StringBuilder]::new(256)
    $title = [System.Text.StringBuilder]::new(256)
    [void][WechatWindowNative]::GetClassName($h,$class,256)
    [void][WechatWindowNative]::GetWindowText($h,$title,256)
    $className = $class.ToString()
    $caption = $title.ToString()
    if ($className -notmatch '^Qt\d+QWindowIcon$' -and $className -notin @('WeChatMainWndForPC','WeChatMainWnd')) { return $true }
    if ($caption -notin @('微信','WeChat')) { return $true }
    $r = New-Object WechatWindowNative+RECT
    [void][WechatWindowNative]::GetWindowRect($h,[ref]$r)
    $minimized = [WechatWindowNative]::IsIconic($h)
    if (-not $minimized -and (($r.Right - $r.Left) -lt 250 -or ($r.Bottom - $r.Top) -lt 200)) { return $true }
    $windows.Add(@{ Process=$byId[[int]$pidValue]; Handle=$h; className=$className; visible=[WechatWindowNative]::IsWindowVisible($h); minimized=$minimized; kind='unknown' })
    return $true
  }
  [void][WechatWindowNative]::EnumWindows($callback,[IntPtr]::Zero)
  foreach ($candidate in $windows) { $candidate.kind = Get-WechatWindowKind $candidate.Handle $candidate.className }
  return $windows.ToArray()
}

function Get-WechatWindow {
  if ($TargetHandle -ne 0) {
    $handle = [IntPtr]$TargetHandle
    if (-not [WechatWindowNative]::IsWindow($handle)) { throw '微信窗口句柄已失效。' }
    $pidValue = [uint32]0
    [void][WechatWindowNative]::GetWindowThreadProcessId($handle, [ref]$pidValue)
    $process = Get-Process -Id $pidValue -ErrorAction Stop
    if ($process.ProcessName -notin @('Weixin','WeChat')) { throw '窗口句柄不属于微信。' }
    return @{ Process = $process; Handle = $handle }
  }
  $processes = @(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue)
  if ($processes.Count -eq 0) { throw '微信尚未运行。请先启动微信并打开已登录的聊天窗口。' }
  $candidates = @(Get-WechatCandidates $processes)
  return Select-WechatCandidate -Candidates $candidates
}

function Start-WechatIfNeeded {
  $processes = @(Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue)
  if (-not (Test-WechatShouldLaunch $processes.Count)) { return }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Tencent\Weixin\Weixin.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Tencent\Weixin\Weixin.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Weixin\Weixin.exe')
  )
  $executable = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $executable) { throw '未找到微信安装路径；请先手动启动微信。' }
  Start-Process -FilePath $executable
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if (Get-Process -Name Weixin,WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1) { return }
  }
  throw '微信已启动，但 15 秒内未出现主窗口；可能需要登录。'
}

function Get-WindowBounds([IntPtr]$handle) {
  $r = New-Object WechatWindowNative+RECT
  if (-not [WechatWindowNative]::GetWindowRect($handle, [ref]$r)) { throw '无法读取窗口边界。' }
  return @{ left = $r.Left; top = $r.Top; width = $r.Right-$r.Left; height = $r.Bottom-$r.Top }
}

function Focus-Wechat([IntPtr]$handle) {
  if ([WechatWindowNative]::IsIconic($handle)) { [void][WechatWindowNative]::ShowWindow($handle, 9) }
  [void][WechatWindowNative]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 150
  if ([WechatWindowNative]::GetForegroundWindow() -ne $handle) { throw '微信不是前台窗口，已取消操作。' }
}

if ($Action -eq 'prepare') { Start-WechatIfNeeded }
$target = Get-WechatWindow
$handle = $target.Handle
if ($Action -eq 'prepare' -and (-not $target.visible -or $target.minimized)) {
  [void][WechatWindowNative]::ShowWindow($handle, 4)
  Start-Sleep -Milliseconds 150
  if (-not [WechatWindowNative]::IsWindowVisible($handle)) { throw '未能恢复微信窗口，请从系统托盘打开已登录的微信聊天窗口，然后点击“重新连接”。' }
}

if ($Action -in @('click','scroll')) { Focus-Wechat $handle }
$bounds = Get-WindowBounds $handle
if ($Action -eq 'capture') {
  $bitmap = New-Object System.Drawing.Bitmap($bounds.width, $bounds.height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $dc = $graphics.GetHdc()
    try { $printed = [WechatWindowNative]::PrintWindow($handle, $dc, 2) }
    finally { $graphics.ReleaseHdc($dc) }
    if (-not $printed) { throw '微信窗口捕获失败；未使用可能被其他窗口遮挡的桌面截图。' }
    $full = [System.IO.Path]::GetFullPath($Output)
    [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($full)) | Out-Null
    $bitmap.Save($full, [System.Drawing.Imaging.ImageFormat]::Png)
    $bounds.output = $full
  } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
if ($Action -eq 'inspect') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  for ($i = 0; $i -lt [Math]::Min($nodes.Count, 20); $i++) {
    $current = $nodes.Item($i).Current
    $items += @{ type = $current.ControlType.ProgrammaticName; name = $current.Name }
  }
  $bounds.uiAutomation = @{ count = $nodes.Count; sample = $items }
}
if ($Action -in @('click','scroll')) {
  if ($X -lt 0 -or $X -ge $bounds.width -or $Y -lt 0 -or $Y -ge $bounds.height) {
    throw "坐标必须位于微信窗口内：0..$($bounds.width-1), 0..$($bounds.height-1)。"
  }
  $screenX = $bounds.left + $X
  $screenY = $bounds.top + $Y
  [void][WechatWindowNative]::SetCursorPos($screenX, $screenY)
  if ($Action -eq 'click') {
    [WechatWindowNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [WechatWindowNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    $wheel = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]($Delta * 120)), 0)
    [WechatWindowNative]::mouse_event(0x0800, 0, 0, $wheel, [UIntPtr]::Zero)
  }
}
@{ action = $Action; processId = $target.Process.Id; handle = $handle.ToInt64(); title = $target.Process.MainWindowTitle; bounds = $bounds } |
  ConvertTo-Json -Depth 5 -Compress
