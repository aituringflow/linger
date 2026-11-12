import { app, BrowserWindow } from "electron";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { OtaClient, type OtaRelease } from "../../../../packages/agent-kit/src/server/ota-client.ts";
import { APP_BUNDLE_ID } from "../shared/app-identity.js";

const run = promisify(execFile);

// ---- Windows 安装助手（VBS，GUI 宿主 wscript，无控制台依赖） ----
// 等旧进程退出 → 静默跑 NSIS 安装包（/S）→ 自动重启新应用
const WIN_INSTALL_HELPER = String.raw`' Launcher Windows OTA install helper (VBS, GUI host: wscript.exe)
' args: OldPid Installer AppPath LogFile
Option Explicit
Dim OldPid, Installer, AppPath, LogFile
If WScript.Arguments.Count < 4 Then WScript.Quit 1
OldPid = CStr(WScript.Arguments(0))
Installer = CStr(WScript.Arguments(1))
AppPath = CStr(WScript.Arguments(2))
LogFile = CStr(WScript.Arguments(3))

Dim fso, sh
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

Dim log
On Error Resume Next
Set log = fso.OpenTextFile(LogFile, 8, True)
On Error GoTo 0

Sub LogMsg(m)
  On Error Resume Next
  log.WriteLine Now() & " " & m
  log.Flush
  On Error GoTo 0
End Sub

Function IsProcessAlive(pid)
  Dim p, wmi
  IsProcessAlive = False
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  For Each p In wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
    IsProcessAlive = True
  Next
  On Error GoTo 0
End Function

Sub KillProcess(pid)
  On Error Resume Next
  GetObject("winmgmts:\\.\root\cimv2").Get("Win32_Process.Handle='" & pid & "'").Terminate()
  On Error GoTo 0
End Sub

LogMsg "helper start oldPid=" & OldPid & " installer=" & Installer & " app=" & AppPath

' 1) wait for old app to exit gracefully (max 30s), then force stop fallback
Dim deadline, waiting
deadline = DateAdd("s", 30, Now())
waiting = True
Do While waiting
  If Not IsProcessAlive(OldPid) Then
    waiting = False
  ElseIf Now() > deadline Then
    LogMsg "old app still running after 30s, force stopping"
    KillProcess OldPid
    WScript.Sleep 2000
    waiting = False
  Else
    WScript.Sleep 500
  End If
Loop

' 2) run installer silently and wait for it to finish
Dim code
code = sh.Run("""" & Installer & """ /S", 0, True)
LogMsg "installer exit code=" & code

' 3) relaunch the app (new build installed in place)
If fso.FileExists(AppPath) Then
  sh.Run """" & AppPath & """", 1, False
  LogMsg "app relaunched"
Else
  LogMsg "app path missing after install"
End If

LogMsg "helper done"
log.Close
WScript.Quit 0
`;

// ---- macOS 安装助手（sh 脚本，detached 运行） ----
// 等旧进程退出 → 替换 .app → open -n 启动新应用
const MAC_INSTALL_HELPER = `#!/bin/sh
set -eu
staged="$1"
target="$2"
old_pid="$3"
backup="${'$'}{target}.ota-backup-${'$'}{old_pid}"
attempt=0
while kill -0 "$old_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 120 ]; then exit 1; fi
  sleep 1
done
mv "$target" "$backup"
if ! mv "$staged" "$target"; then
  mv "$backup" "$target"
  exit 1
fi
if ! /usr/bin/open -n "$target"; then
  mv "$target" "$staged"
  mv "$backup" "$target"
  /usr/bin/open -n "$target" || true
  exit 1
fi
rm -rf "$backup"
rm -rf "$(dirname "$staged")"
`;

// ---- 应用身份常量（与 electron-builder.yml 保持一致） ----
const APP_ID = "launcher";

async function installWindowsInstaller(file: string, release: OtaRelease, downloadDir: string): Promise<void> {
  if (!app.isPackaged) throw new Error("请从已安装的应用中执行更新");
  const appPath = process.execPath;
  const helper = path.join(downloadDir, `launcher-win-install-${process.pid}.vbs`);
  await fs.writeFile(helper, WIN_INSTALL_HELPER, "ascii");
  const wscript = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  const child = spawn(wscript, [
    "//B", "//Nologo", helper,
    String(process.pid), file, appPath, path.join(downloadDir, "launcher-win-install.log"),
  ], { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  app.quit();
}

async function installMacDmg(file: string, release: OtaRelease, downloadDir: string): Promise<void> {
  if (!app.isPackaged) throw new Error("请从已安装的应用中执行更新");
  const target = path.dirname(path.dirname(path.dirname(process.execPath)));
  if (!target.endsWith(".app")) throw new Error("无法定位当前应用，请重新安装");
  try { await fs.access(path.dirname(target), constants.W_OK); }
  catch { throw new Error("当前应用所在目录不可写，请将 Linger.app 移到有写入权限的位置后重试"); }
  const workDir = await fs.mkdtemp(path.join(downloadDir, "launcher-mac-install-"));
  const mountPoint = path.join(workDir, "volume");
  const staged = path.join(workDir, path.basename(target));
  let mounted = false;
  let prepared = false;
  try {
    await fs.mkdir(mountPoint);
    await run("/usr/bin/hdiutil", ["attach", file, "-nobrowse", "-readonly", "-mountpoint", mountPoint], { timeout: 120_000 });
    mounted = true;
    const source = path.join(mountPoint, path.basename(target));
    const plist = path.join(source, "Contents", "Info.plist");
    const [{ stdout: bundleId }, { stdout: version }] = await Promise.all([
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist]),
      run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist]),
    ]);
    if (bundleId.trim() !== APP_BUNDLE_ID || version.trim() !== release.version)
      throw new Error(`安装包身份不匹配：期望 ${APP_BUNDLE_ID}@${release.version}，实际 ${bundleId.trim()}@${version.trim()}`);
    await run("/usr/bin/ditto", [source, staged], { timeout: 5 * 60_000 });
    prepared = true;
  } finally {
    if (mounted) await run("/usr/bin/hdiutil", ["detach", mountPoint], { timeout: 60_000 }).catch(() => {});
    if (!prepared) await fs.rm(workDir, { recursive: true, force: true });
  }
  const helper = path.join(workDir, "install.sh");
  await fs.writeFile(helper, MAC_INSTALL_HELPER, { mode: 0o700 });
  const log = await fs.open(path.join(downloadDir, "launcher-mac-install.log"), "a");
  try {
    const child = spawn("/bin/sh", [helper, staged, target, String(process.pid)], {
      detached: true, stdio: ["ignore", log.fd, log.fd],
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true });
    throw error;
  } finally { await log.close(); }
  setTimeout(() => app.quit(), 500);
}

export function createLauncherUpdater(base: URL, win: BrowserWindow): OtaClient {
  if (process.platform !== "win32" && process.platform !== "darwin") throw new Error("当前平台不支持 OTA");
  const downloadDir = path.join(app.getPath("userData"), "updates");
  return new OtaClient({
    baseUrl: base,
    platform: process.platform,
    version: app.getVersion(),
    downloadDir,
    appId: APP_ID,
    onAvailable: (release) => { if (!win.isDestroyed()) win.webContents.send("update:available", release); },
    onDownloadState: (state) => { if (!win.isDestroyed()) win.webContents.send("update:download-state", state); },
    installArtifact: async (file, release) => {
      if (process.platform === "win32") {
        await installWindowsInstaller(file, release, downloadDir);
      } else {
        await installMacDmg(file, release, downloadDir);
      }
    },
  });
}
