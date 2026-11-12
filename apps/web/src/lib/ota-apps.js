// OTA 应用通道注册表：/api/updates（清单）与 /api/updates/[filename]（产物下载）
// 必须共用同一份配置，否则清单能列出某个通道、下载却判定「未知通道」直接 404。
// 默认通道 agent 存放在 ota-releases/ 根目录，launcher 通道存放在 ota-releases/launcher/。
// OTA_APPS=id:Name,id2:Name2 可追加或覆盖通道（id 须小写字母开头，仅含小写字母/数字/连字符/下划线）。
const DEFAULT_APP_ID = "agent";

export const OTA_DEFAULT_APP_ID = DEFAULT_APP_ID;

export function parseOtaApps() {
  const apps = {
    agent: { productName: "Agent" },
    launcher: { productName: "Launcher" },
  };
  const env = process.env.OTA_APPS?.trim();
  if (env) {
    for (const pair of env.split(",")) {
      const [id, name] = pair.split(":").map((s) => s.trim());
      if (id && /^[a-z][a-z0-9_-]*$/.test(id) && name) apps[id] = { productName: name };
    }
  }
  return apps;
}
