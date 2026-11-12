"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const fmtSize = (bytes) =>
  bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 * 1024 ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

const pad = (n) => String(n).padStart(2, "0");
const fmtTime = (iso) => {
  if (!iso) return "时间未知";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "时间未知";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const versionFromFilename = (filename) => {
  const stem = filename.replace(/\.(?:exe|dmg)$/i, "");
  return stem.match(/(?:^|[^\da-z.])v?(\d+\.\d+\.\d+)(?=$|[^\d.])/i)?.[1] || "";
};

function UpdatesAdminInner() {
  const searchParams = useSearchParams();
  const urlAppId = searchParams.get("appId") || "";
  const [token, setToken] = useState("");
  const [appInfo, setAppInfo] = useState(null);
  const [releases, setReleases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [platform, setPlatform] = useState("win32");
  const [version, setVersion] = useState("");
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const [pending, setPending] = useState("");

  useEffect(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem("ota_token") : "";
    if (saved) setToken(saved);
  }, []);

  const saveToken = (value) => {
    setToken(value);
    try { localStorage.setItem("ota_token", value); } catch { /* ignore */ }
  };

  // 加载当前通道的产品名（仅用于标题展示）
  useEffect(() => {
    if (!token || !urlAppId) return;
    let alive = true;
    fetch("/linger/api/updates?apps=1", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (!alive || !Array.isArray(data.apps)) return;
        setAppInfo(data.apps.find((a) => a.appId === urlAppId) || null);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [token, urlAppId]);

  const loadList = useCallback(async () => {
    if (!token || !urlAppId) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/linger/api/updates?list=1&appId=${encodeURIComponent(urlAppId)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReleases(data.releases || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [token, urlAppId]);

  useEffect(() => { loadList(); }, [loadList]);

  function publish(event) {
    event.preventDefault();
    if (!file) return;
    setBusy(true); setMsg("上传中…"); setProgress(0);
    try {
      const xhr = new XMLHttpRequest();
      const params = new URLSearchParams({ platform, version, filename: file.name, appId: urlAppId });
      xhr.open("POST", `/linger/api/updates?${params}`);
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const percent = Math.round((e.loaded / e.total) * 100);
          setProgress(percent);
          if (percent === 100) setMsg("上传完成，正在保存和校验…");
        }
      };
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
        if (xhr.status < 200 || xhr.status >= 300) {
          setMsg(data.error || `HTTP ${xhr.status}`);
        } else {
          setProgress(100);
          setMsg(`已发布 ${data.platform} ${data.version}`);
          setTimeout(() => { setModalOpen(false); setMsg(""); setFile(null); setVersion(""); loadList(); }, 800);
        }
        setBusy(false);
      };
      xhr.onerror = () => { setMsg("网络错误，上传失败"); setBusy(false); };
      xhr.send(file);
    } catch (e) { setMsg(e.message); setBusy(false); }
  }

  async function toggleRelease(r) {
    setPending(r.filename);
    try {
      const res = await fetch("/linger/api/updates", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: r.filename, disabled: !r.disabled, appId: urlAppId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReleases((prev) => prev.map((x) => (x.filename === r.filename ? { ...x, disabled: !x.disabled } : x)));
    } catch (e) { alert(e.message); }
    finally { setPending(""); }
  }

  async function removeRelease(r) {
    if (!confirm(`确定删除 ${r.platform} ${r.version}（${r.filename}）？此操作不可恢复。`)) return;
    setPending(r.filename);
    try {
      const res = await fetch("/linger/api/updates", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ filename: r.filename, appId: urlAppId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setReleases((prev) => prev.filter((x) => x.filename !== r.filename));
    } catch (e) { alert(e.message); }
    finally { setPending(""); }
  }

  if (!urlAppId) {
    return <main className="wrap">
      <style>{`.wrap{max-width:600px;margin:100px auto;padding:32px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#9ca3af;text-align:center}`}</style>
      <h1 style={{ fontSize: 48, margin: 0, color: "#d1d5db" }}>404</h1>
      <p style={{ fontSize: 14 }}>页面不存在</p>
    </main>;
  }

  return <main className="wrap">
    <style>{`
      .wrap{max-width:880px;margin:0 auto;padding:32px 20px 64px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2933}
      h1{font-size:24px;margin:0;font-weight:650}
      .top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px}
      .sub{color:#6b7280;font-size:14px;margin:0 0 20px}
      .tokenbar{display:flex;gap:8px;align-items:center;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:10px 14px;margin-bottom:20px}
      .tokenbar input{flex:1;border:none;background:transparent;outline:none;font-size:14px}
      .btn{border:none;border-radius:10px;padding:9px 16px;font-size:14px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap}
      .btn-primary{background:#2d8cf0;color:#fff}
      .btn-primary:hover{background:#1f7fe0}
      .btn-primary:disabled{opacity:.6;cursor:not-allowed}
      .btn-ghost{background:#fff;color:#374151;border:1px solid #d1d5db}
      .btn-ghost:hover{background:#f3f4f6}
      .btn-danger{background:#fff;color:#dc2626;border:1px solid #fecaca}
      .btn-danger:hover{background:#fef2f2}
      .btn-sm{padding:6px 12px;font-size:13px}
      .list{display:flex;flex-direction:column;gap:10px}
      .card{display:flex;align-items:center;gap:14px;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;transition:.15s}
      .card:hover{box-shadow:0 4px 14px rgba(15,23,42,.06)}
      .card.disabled{opacity:.6;background:#f9fafb}
      .badge{font-size:12px;font-weight:600;padding:3px 9px;border-radius:999px}
      .badge-win{background:#dbeafe;color:#1d4ed8}
      .badge-mac{background:#ede9fe;color:#6d28d9}
      .badge-on{background:#dcfce7;color:#15803d}
      .badge-off{background:#fee2e2;color:#b91c1c}
      .info{flex:1;min-width:0}
      .v{font-size:16px;font-weight:650}
      .meta{display:flex;flex-direction:column;gap:2px;font-size:13px;color:#6b7280;margin-top:4px}
      .meta span{overflow-wrap:anywhere}
      .meta .sha{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#9ca3af}
      .actions{display:flex;gap:8px;flex-shrink:0}
      .empty{text-align:center;color:#9ca3af;padding:40px 0}
      .overlay{position:fixed;inset:0;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:20px;z-index:50}
      .modal{background:#fff;border-radius:16px;padding:24px;width:100%;max-width:480px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
      .modal h2{margin:0 0 16px;font-size:18px}
      .field{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
      .field label{font-size:13px;color:#374151;font-weight:600}
      .field input,.field select{border:1px solid #d1d5db;border-radius:10px;padding:9px 12px;font-size:14px;outline:none}
      .field input:focus,.field select:focus{border-color:#2d8cf0}
      .progress{height:8px;background:#eee;border-radius:4px;overflow:hidden;margin:10px 0}
      .progress > div{height:100%;background:#2d8cf0;transition:width .2s}
      .modal-msg{font-size:13px;color:#6b7280;min-height:18px}
      .modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:8px}
      .err{color:#dc2626;font-size:14px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:10px 14px;margin-bottom:16px}
    `}</style>

    <div className="top">
      <h1>OTA 发布管理{appInfo ? ` · ${appInfo.productName}` : ""}</h1>
      <button className="btn btn-primary" disabled={!token} onClick={() => setModalOpen(true)}>发布新版本</button>
    </div>
    <p className="sub">通道 <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: 4, fontSize: 13 }}>{urlAppId}</code> — 按平台管理安装包，禁用后的版本不会被客户端的「检查更新」找到。</p>

    <div className="tokenbar">
      <span style={{ color: "#6b7280", fontSize: 13 }}>上传令牌</span>
      <input type="password" placeholder="由服务端 OTA_UPLOAD_TOKEN 配置" value={token}
        onChange={(e) => saveToken(e.target.value)} autoComplete="off" />
    </div>

    {error && <div className="err">{error}</div>}

    {loading ? <p className="sub">加载中…</p>
      : releases.length === 0 ? <div className="empty">
          {appInfo ? `「${appInfo.productName}」通道暂无发布记录` : "暂无发布记录"}
        </div>
        : <div className="list">
          {releases.map((r) => <div key={`${r.filename}`} className={`card${r.disabled ? " disabled" : ""}`}>
            <span className={`badge ${r.platform === "win32" ? "badge-win" : "badge-mac"}`}>
              {r.platform === "win32" ? "Windows" : "macOS"}
            </span>
            <div className="info">
              <div className="v">{r.version}</div>
              <div className="meta">
                <span>{r.filename} · {fmtSize(r.size)}</span>
                <span>上传于 {fmtTime(r.uploadedAt)} · <span className="sha">SHA-256 {r.sha256.slice(0, 12)}…</span></span>
              </div>
            </div>
            <span className={`badge ${r.disabled ? "badge-off" : "badge-on"}`}>
              {r.disabled ? "已禁用" : "已启用"}
            </span>
            <div className="actions">
              <button className="btn btn-ghost btn-sm" disabled={pending === r.filename}
                onClick={() => toggleRelease(r)}>{r.disabled ? "启用" : "禁用"}</button>
              <button className="btn btn-danger btn-sm" disabled={pending === r.filename}
                onClick={() => removeRelease(r)}>删除</button>
            </div>
          </div>)}
        </div>}

    {modalOpen && <div className="overlay" onClick={() => !busy && setModalOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>发布新版本{appInfo ? ` → ${appInfo.productName}` : ""}</h2>
        <form onSubmit={publish}>
          <div className="field">
            <label>平台</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="win32">Windows (.exe)</option>
              <option value="darwin">macOS (.dmg)</option>
            </select>
          </div>
          <div className="field">
            <label>版本号</label>
            <input required value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
          <div className="field">
            <label>安装包</label>
            <input type="file" required accept={platform === "win32" ? ".exe" : ".dmg"}
              onChange={(e) => {
                const selected = e.target.files?.[0] || null;
                setFile(selected);
                setVersion(selected ? versionFromFilename(selected.name) : "");
              }} />
          </div>
          {busy && <div className="progress"><div style={{ width: `${progress}%` }} /></div>}
          <div className="modal-msg">{busy ? `${progress}%` : msg}</div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setModalOpen(false)}>取消</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "上传中…" : "发布"}</button>
          </div>
        </form>
      </div>
    </div>}
  </main>;
}

export default function UpdatesAdmin() {
  return (
    <Suspense fallback={<main className="wrap" style={{ padding: 60, textAlign: "center", color: "#9ca3af" }}>加载中…</main>}>
      <UpdatesAdminInner />
    </Suspense>
  );
}
