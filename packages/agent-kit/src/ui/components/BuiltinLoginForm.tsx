"use client";
import { useEffect, useState, type FormEvent } from "react";

/**
 * 应用内登录窗（Electron 壳）通过 preload 暴露的凭据桥。
 *
 * 网页端没有这个对象 —— 浏览器（Chrome / Safari）自己会弹「是否保存密码」并下次自动填充；
 * Electron 不打包这套密码管理器，也没有 savePassword API，所以只有应用内需要自己记：
 * 密码由主进程用 safeStorage 加密（macOS = 系统钥匙串），页面这边只负责读写。
 */
interface LoginCredentialBridge {
  getCredential: () => Promise<{ username: string; password: string } | null>;
  saveCredential: (credential: { username: string; password: string }) => Promise<boolean>;
  clearCredential: () => Promise<boolean>;
}

const LAST_USERNAME_KEY = "agent-kit:last-username";

function credentialBridge(): LoginCredentialBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as Window & { launcherLogin?: LoginCredentialBridge }).launcherLogin;
  return bridge && typeof bridge.getCredential === "function" ? bridge : null;
}

export function BuiltinLoginForm({ basePath, next, loginProviders = "" }: { basePath: string; next: string; loginProviders?: string }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const [bridge, setBridge] = useState<LoginCredentialBridge | null>(null);
  // 已保存的密码只有在「记住密码」保持勾选时才继续沿用，取消勾选后不再回填
  const [remembered, setRemembered] = useState(false);

  // 回填只能放在挂载后：服务端渲染时没有 window / preload，直接读会和首屏 HTML 不一致。
  useEffect(() => {
    const api = credentialBridge();
    setBridge(api);
    if (api) {
      let active = true;
      void api.getCredential().then((saved) => {
        if (!active || !saved) return;
        setUsername(saved.username);
        if (saved.password) {
          setPassword(saved.password);
          setRemember(true);
          setRemembered(true);
        }
      }).catch(() => { /* 读不到就当没有 */ });
      return () => { active = false; };
    }
    try {
      const saved = window.localStorage.getItem(LAST_USERNAME_KEY);
      if (saved) setUsername(saved);
    } catch { /* storage unavailable */ }
    return undefined;
  }, []);

  /** 登录成功后落地「上次账号」：应用内写加密文件，网页端至少把用户名记在 localStorage。 */
  function persistCredential() {
    try { window.localStorage.setItem(LAST_USERNAME_KEY, username); } catch { /* storage unavailable */ }
    if (!bridge) return;
    // 注册时只记用户名（此时用户还没「登录过」这个账号）；登录时按勾选决定是否存密码。
    const keepPassword = mode === "login" && remember;
    // 取消勾选 = 覆盖成「只有用户名」，等于把之前存的密码忘掉
    void bridge.saveCredential({ username, password: keepPassword ? password : "" }).catch(() => {});
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (mode === "register" && password !== confirmation) { setError("两次输入的密码不一致"); return; }
    setBusy(true);
    setError("");
    try {
      // 带上 App 传入的 ?providers=：服务端据此判定 builtin 是否可用，与登录页同源。
      const providersQuery = loginProviders ? `?providers=${encodeURIComponent(loginProviders)}` : "";
      const url = `${basePath}/api/auth/${mode === "register" ? "register" : "login"}${providersQuery}`;
      const request = () => fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, next }), credentials: "same-origin",
      });
      let response: Response;
      try {
        response = await request();
      } catch (requestError) {
        if (mode !== "login") throw requestError;
        // 远端反代偶发断连时只重试一次；认证失败（401）不会走这里。
        await new Promise((resolve) => setTimeout(resolve, 350));
        response = await request();
      }
      if (mode === "login" && [404, 502, 503, 504].includes(response.status) && !response.headers.get("content-type")?.includes("application/json")) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        response = await request();
      }
      if (!response.headers.get("content-type")?.includes("application/json")) {
        setError("登录服务暂时不可用，请稍后重试");
        return;
      }
      const data = await response.json();
      if (!response.ok) { setError(data.error || (mode === "register" ? "注册失败" : "登录失败")); return; }
      persistCredential();
      window.location.assign(data.next || next);
    } catch (cause) {
      console.error("[agent-kit auth] login request failed", cause);
      setError("无法连接登录服务，请检查网络后重试");
    }
    finally { setBusy(false); }
  }
  function switchMode() {
    setMode(mode === "login" ? "register" : "login");
    setPassword(""); setConfirmation(""); setError("");
    // 从注册切回登录时，把记住的密码再填回来
    if (mode === "register" && bridge && remembered) {
      void bridge.getCredential().then((saved) => { if (saved?.password) setPassword(saved.password); }).catch(() => {});
    }
  }
  return <form className="login-builtin-form" onSubmit={submit}>
    <label htmlFor="login-username">用户名</label>
    <input id="login-username" name="username" type="text" autoComplete="username" minLength={3} maxLength={128} required value={username} onChange={e => setUsername(e.target.value)} />
    <label htmlFor="login-password">密码</label>
    <input id="login-password" name="password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 6 : undefined} required value={password} onChange={e => setPassword(e.target.value)} />
    {mode === "register" && <>
      <label htmlFor="login-confirmation">确认密码</label>
      <input id="login-confirmation" name="confirmation" type="password" autoComplete="new-password" required value={confirmation} onChange={e => setConfirmation(e.target.value)} />
      <p className="login-register-hint">用户名使用至少 3 位英文字母或数字；密码至少 6 位。</p>
    </>}
    {error && <div className="login-error" role="alert">{error}</div>}
    {bridge && mode === "login" && <label className="login-remember">
      <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} disabled={busy} />
      <span>记住密码</span>
    </label>}
    <button type="submit" className="login-provider-button" disabled={busy}>{busy ? "请稍候…" : mode === "register" ? "注册并登录" : "登录"}</button>
    <button type="button" className="login-register-toggle" onClick={switchMode} disabled={busy}>
      {mode === "register" ? "已有账号？返回登录" : "没有账号？注册"}
    </button>
  </form>;
}
