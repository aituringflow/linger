import { app } from "electron";

/**
 * 应用在界面上的显示名（与 `app-name.ts` 的 APP_PROJECT_NAME 无关，那个是
 * `~/.linger` 数据目录名，不能跟随语言变化）。
 *
 * macOS 走的是 bundle 本地化：`resources/zh_CN.lproj|zh-Hans.lproj` 里的
 * `CFBundleDisplayName`，Finder / Dock / 菜单栏由系统按偏好语言自己挑，代码不用管。
 * Windows 没有这套机制（exe 文件名固定为 Linger），所以运行期能自己决定的部分
 * ——窗口标题、任务栏悬浮、Alt-Tab、关于窗口——在这里统一判断。
 *
 * 只看**系统区域**（getSystemLocale），不看 `--lang` 或应用内语言设置：应用名应该
 * 跟随系统语言，而不是跟随用户在界面里临时切走的 UI 语言。
 */
export function appDisplayName(): string {
  return /^zh([-_]|$)/i.test(systemLocale()) ? "灵儿" : "Linger";
}

function systemLocale(): string {
  // 三个来源按可靠性降序取第一个非空：getSystemLocale 是系统区域（不受 --lang 影响），
  // getLocale 受 --lang / 环境变量影响，getPreferredSystemLanguages 是兜底。
  const readers = [
    () => app.getSystemLocale(),
    () => app.getLocale(),
    () => app.getPreferredSystemLanguages()[0] ?? "",
  ];
  for (const read of readers) {
    try {
      const value = read();
      if (value) return value;
    } catch { /* 容器镜像等无 locale 环境，换下一个 */ }
  }
  return "";
}
