import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

if (process.platform === 'darwin') {
  const root = path.resolve(import.meta.dirname, '..');
  const source = path.join(root, 'native', 'wechat-windowctl.m');
  const output = path.join(root, 'resources', 'wechat-windowctl');
  if (!fs.existsSync(output) || fs.statSync(output).mtimeMs < fs.statSync(source).mtimeMs) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    try {
      execFileSync('clang', ['-fobjc-arc', '-O2', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-o', output, source], { stdio: 'inherit' });
      fs.chmodSync(output, 0o755);
      console.log('[wechat-windowctl] 编译完成');
    } catch (error) {
      console.warn('[wechat-windowctl] 编译失败，macOS 微信窗口接入不可用：', error.message);
    }
  }
  const monitorSource = path.join(root, 'native', 'wechat-monitor.swift');
  const monitorOutput = path.join(root, 'resources', 'wechat-monitor');
  if (!fs.existsSync(monitorOutput) || fs.statSync(monitorOutput).mtimeMs < fs.statSync(monitorSource).mtimeMs) {
    try {
      fs.mkdirSync(path.dirname(monitorOutput), { recursive: true });
      const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      execFileSync('xcrun', ['swiftc', '-O', '-target', `${architecture}-apple-macosx12.3`, '-o', monitorOutput, monitorSource], { stdio: 'inherit' });
      fs.chmodSync(monitorOutput, 0o755);
      console.log('[wechat-monitor] 编译完成');
    } catch (error) {
      console.warn('[wechat-monitor] 编译失败，微信消息监听不可用：', error.message);
    }
  }
  const notificationSource = path.join(root, 'native', 'wechat-notifications.m');
  const notificationOutput = path.join(root, 'resources', 'wechat-notifications');
  if (!fs.existsSync(notificationOutput) || fs.statSync(notificationOutput).mtimeMs < fs.statSync(notificationSource).mtimeMs) {
    try {
      fs.mkdirSync(path.dirname(notificationOutput), { recursive: true });
      execFileSync('clang', ['-fobjc-arc', '-O2', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64', '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'ApplicationServices', '-o', notificationOutput, notificationSource], { stdio: 'inherit' });
      fs.chmodSync(notificationOutput, 0o755);
      console.log('[wechat-notifications] 编译完成');
    } catch (error) { console.warn('[wechat-notifications] 编译失败，系统通知监听不可用：', error.message); }
  }
}
