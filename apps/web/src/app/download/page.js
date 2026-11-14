// 下载页（Server Component）：从 OTA 发布目录读取各应用、各平台最新版本，
// 把「应用 → 平台 → 最新 release」传给客户端组件渲染下载按钮。
// 默认通道（agent）存放在 ota-releases/ 根目录，其余通道存放在子目录。
import path from "node:path";
import fs from "node:fs";
import DownloadClient from "./DownloadClient";

// 下载页的「真正内容」依赖 ?appId=（不带参数会渲染一屏 404），所以 metadata 也要跟着参数走：
// 不带 appId 时给 noindex（否则搜索器会把一个空白 404 页收进去，还占掉 /download 这个好路径）；
// 带 appId 时 canonical 必须带上参数，否则 canonical 指向的就是那个 404 版。
export async function generateMetadata({ searchParams }) {
  const { appId } = await searchParams;
  if (!appId) {
    return {
      title: "页面不存在",
      robots: { index: false, follow: false },
      alternates: { canonical: "/linger/download" },
    };
  }
  return {
    title: "下载灵儿桌面客户端",
    description: "下载灵儿（Linger）：图灵环流开源的桌面个人智能体（Personal Agent），支持 macOS 与 Windows，把对话、任务、文件和知识库放进同一个工作环境。",
    alternates: { canonical: `/linger/download?appId=${appId}` },
  };
}

// 永远按请求时读取，保证页面反映 OTA 目录里最新的发布
export const dynamic = "force-dynamic";

// 当前 OTA 支持的桌面平台（与 ota-server.ts 的 validPlatform 保持一致）
const PLATFORMS = [
  { key: "win32", label: "Windows", hint: "Windows 10 / 11 · 64 位" },
  { key: "darwin", label: "macOS", hint: "macOS 13+ · Apple 芯片" },
];

const compareVersion = (a, b) => b.localeCompare(a, undefined, { numeric: true });

function readPlatformReleases(platform, dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, `${platform}.json`), "utf8"));
    const list = Array.isArray(raw?.releases)
      ? raw.releases
      : raw && typeof raw.version === "string"
        ? [raw]
        : [];
    return list
      .filter((r) => !r.disabled)
      .sort((a, b) => compareVersion(a.version, b.version));
  } catch {
    return [];
  }
}

// 解析应用清单：统一为 agent（默认通道，存放在 ota-releases/ 根目录）
// 与 launcher（launcher 桌面端，存放在 ota-releases/launcher/）。
// OTA_APPS 可追加或覆盖更多通道；仅展示有发布记录的通道。
function parseAppsFromEnv(storageDir, defaultAppId) {
  const apps = [{
    appId: defaultAppId,
    productName: "Linger",
    dir: storageDir,
    isDefault: true,
  }];
  if (defaultAppId !== "launcher") {
    apps.push({
      appId: "launcher",
      productName: "Linger",
      dir: path.join(storageDir, "launcher"),
      isDefault: false,
    });
  }
  const env = process.env.OTA_APPS?.trim();
  if (env) {
    for (const pair of env.split(",")) {
      const [id, name] = pair.split(":").map((s) => s.trim());
      if (id && /^[a-z][a-z0-9_-]*$/.test(id) && id !== defaultAppId && !apps.some((a) => a.appId === id)) {
        apps.push({
          appId: id,
          productName: name || id,
          dir: path.join(storageDir, id),
          isDefault: false,
        });
      }
    }
  }
  return apps;
}

export default async function DownloadPage({ searchParams }) {
  const storageDir =
    process.env.OTA_STORAGE_DIR || path.join(process.cwd(), "ota-releases");
  const defaultAppId = process.env.OTA_DEFAULT_APP || "agent";

  // 与发布页（updates-admin）一致：必须带 ?appId=xxx 定向展示对应通道，
  // 不带 appId 一律 404，避免把全部通道（多应用 Tab）暴露给访问者。
  // 注意：Server Component 的 searchParams 是 Promise，必须 await。
  const { appId: urlAppId } = await searchParams;
  if (!urlAppId) {
    return <main className="wrap">
      <style>{`.wrap{max-width:600px;margin:100px auto;padding:32px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#9ca3af;text-align:center}`}</style>
      <h1 style={{ fontSize: 48, margin: 0, color: "#d1d5db" }}>404</h1>
      <p style={{ fontSize: 14 }}>页面不存在</p>
    </main>;
  }

  const apps = parseAppsFromEnv(storageDir, defaultAppId).map((app) => {
    const platforms = PLATFORMS.map((p) => {
      const releases = readPlatformReleases(p.key, app.dir);
      const latest = releases[0] || null;
      return {
        ...p,
        release: latest
          ? {
              version: latest.version,
              filename: latest.filename,
              url: latest.url,
              size: latest.size,
            }
          : null,
      };
    });
    // 跨平台取最大版本号
    const latestVersion = platforms.reduce((max, p) => {
      if (p.release && (!max || compareVersion(p.release.version, max) > 0)) {
        return p.release.version;
      }
      return max;
    }, null);
    return { ...app, platforms, latestVersion };
  });

  // 只展示有发布记录的应用
  const visibleApps = apps.filter((a) => a.platforms.some((p) => p.release));

  // URL 带 ?appId=xxx 时只展示该应用
  const filteredApps = visibleApps.filter((a) => a.appId === urlAppId);

  // 该通道还没有发布记录：仍然给出介绍与平台卡片（按钮显示「即将推出」），避免空白页
  if (!filteredApps.length) {
    return (
      <DownloadClient
        apps={[{
          appId: urlAppId,
          productName: "Linger",
          isDefault: true,
          latestVersion: null,
          platforms: PLATFORMS.map((p) => ({ ...p, release: null })),
        }]}
      />
    );
  }

  return <DownloadClient apps={filteredApps} />;
}
