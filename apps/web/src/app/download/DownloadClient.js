"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./DownloadClient.module.css";

import SiteHeader from "../../components/site-header";
import { PLATFORM_ICONS } from "@turingflow/agent-kit/ui";

function detectPlatform() {
  if (typeof navigator === "undefined") return null;
  const p = navigator.platform || "";
  const ua = navigator.userAgent || "";
  if (/Win/i.test(p) || /Windows/i.test(ua)) return "win32";
  if (/Mac/i.test(p) || /Macintosh|Mac OS X/i.test(ua)) return "darwin";
  return null;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${Math.round(mb)} MB`;
}

// 用户可见的安装包名（OTA 内部以产品名 x.y.z.exe 存储与分发）
function downloadName(app, platform, version) {
  const product = app?.productName || "Linger";
  return platform.key === "win32"
    ? `${product}-Setup-${version}.exe`
    : `${product}-${version}.dmg`;
}

// 走专用的下载路由（/linger/api/download/<file>?name=<友好名>&appId=<通道>）
function downloadHref(app, release) {
  const name = downloadName(app, { key: release.platform || "" }, release.version);
  let url = `/linger/api/download/${release.filename}?name=${encodeURIComponent(name)}`;
  if (app && !app.isDefault) url += `&appId=${encodeURIComponent(app.appId)}`;
  return url;
}

export default function DownloadClient({ apps }) {
  const [current, setCurrent] = useState(null);
  const [activeAppId, setActiveAppId] = useState(apps[0]?.appId || "");

  useEffect(() => {
    setCurrent(detectPlatform());
  }, []);

  useEffect(() => {
    if (!activeAppId && apps[0]) setActiveAppId(apps[0].appId);
  }, [apps, activeAppId]);

  const activeApp = useMemo(
    () => apps.find((a) => a.appId === activeAppId) || apps[0],
    [apps, activeAppId]
  );

  const orderedPlatforms = useMemo(() => {
    if (!activeApp || !current) return activeApp?.platforms || [];
    const list = activeApp.platforms;
    const idx = list.findIndex((p) => p.key === current);
    if (idx <= 0) return list;
    const copy = [...list];
    const [hit] = copy.splice(idx, 1);
    return [hit, ...copy];
  }, [activeApp, current]);

  // 多应用时显示 Tab，单应用时隐藏
  const showTabs = apps.length > 1;
  const latestVersion = activeApp?.latestVersion || null;

  return (
    <div className={styles.page}>
      <SiteHeader active="download" showCta={false} />

      <main>
        <section className={styles.hero}>
          <div className={styles.badge}>
            灵儿 · 桌面客户端{latestVersion ? ` · v${latestVersion}` : ""}
          </div>
          <h1 className={styles.title}>灵儿，装进你的电脑。</h1>
          <p className={styles.lede}>
            灵儿是一个开源桌面个人智能体：把对话、任务、文件和知识库放进同一个工作环境。
            装好之后，开口就能交办，桌面替你摆好，资料留在你自己的电脑上。
          </p>

          {showTabs && (
            <div className={styles.tabs}>
              {apps.map((a) => (
                <button
                  key={a.appId}
                  className={`${styles.tab} ${a.appId === activeAppId ? styles.tabActive : ""}`}
                  onClick={() => setActiveAppId(a.appId)}
                >
                  {a.productName}
                  {a.latestVersion ? <span className={styles.tabVer}>v{a.latestVersion}</span> : null}
                </button>
              ))}
            </div>
          )}

          <div className={styles.platforms}>
            {orderedPlatforms.map((p) => (
              <DownloadCard key={p.key} app={activeApp} platform={p} isCurrent={current === p.key} />
            ))}
          </div>
        </section>

        <footer className={styles.footer}>
          <p className={styles.copyright}>Copyright © 2026 图灵环流. All rights reserved.</p>
        </footer>
      </main>
    </div>
  );
}

function DownloadCard({ app, platform, isCurrent, compact = false }) {
  const Icon = PLATFORM_ICONS[platform.key];
  const { release } = platform;
  return (
    <div className={`${styles.card2} ${isCurrent ? styles.current : ""} ${compact ? styles.compact : ""}`}>
      {isCurrent && <span className={styles.rec}>推荐</span>}
      {Icon ? <Icon className={styles.picon} /> : null}
      <div className={styles.pname}>{platform.label}</div>
      <div className={styles.phint}>{platform.hint}</div>
      {release ? (
        <a
          className={styles.btn}
          href={downloadHref(app, { ...release, platform: platform.key })}
          download={downloadName(app, platform, release.version)}
        >
          下载{release.version ? ` v${release.version}` : ""}
          {release.size ? <span className={styles.size}>{formatSize(release.size)}</span> : null}
        </a>
      ) : (
        <button className={`${styles.btn} ${styles.disabled}`} disabled>
          即将推出
        </button>
      )}
    </div>
  );
}
