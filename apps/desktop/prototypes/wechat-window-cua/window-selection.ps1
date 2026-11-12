function Test-WechatShouldLaunch([int]$ProcessCount) {
  return $ProcessCount -eq 0
}

function Format-WechatError([string]$Message) {
  return 'WECHAT_CUA_ERROR:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Message))
}

function Select-WechatCandidate([object[]]$Candidates) {
  $chatWindows = @($Candidates | Where-Object { $_.kind -eq 'chat' })
  $visibleChatWindows = @($chatWindows | Where-Object { $_.visible -and -not $_.minimized })
  if ($visibleChatWindows.Count -eq 1) { return $visibleChatWindows[0] }
  if ($visibleChatWindows.Count -gt 1 -or ($visibleChatWindows.Count -eq 0 -and $chatWindows.Count -gt 1)) {
    throw '检测到多个微信聊天窗口，无法确定要复用哪一个。请先保留要使用的微信窗口，再重新连接。'
  }
  if ($chatWindows.Count -eq 1) { return $chatWindows[0] }
  if (@($Candidates | Where-Object { $_.kind -eq 'login' }).Count -gt 0) {
    throw '微信已经运行，但当前找到的是登录入口。请从 Windows 系统托盘打开已登录的微信聊天窗口，然后点击“重新连接”；不会启动新的微信。'
  }
  if (@($Candidates | Where-Object { $_.kind -eq 'unknown' }).Count -gt 0) {
    throw '微信已经运行，但无法确认现有窗口是否是聊天窗口。请从系统托盘打开已登录的微信聊天窗口，然后点击“重新连接”；不会启动新的微信。'
  }
  throw '微信已经运行，但未找到聊天窗口。请从 Windows 系统托盘打开已登录的微信聊天窗口，然后点击“重新连接”；不会启动新的微信。'
}
