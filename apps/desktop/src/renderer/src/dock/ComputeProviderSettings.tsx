import { useTranslation } from "../i18n";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { CodexRuntimeState, ComputeProviderId, LauncherComputeProvider } from "../../../shared/types";
import { COMPUTE_PROVIDER_IDS, enabledComputeProviders, reloadLauncherModels, useLauncher } from "../state";

/**
 * 「算力提供商」品牌图标（真实品牌 SVG，矢量、可随主题用 CSS 重新着色 / 状态置灰）。
 *  - WorkBuddy：官方绿渐变圆形徽标（workbuddy.ai 同款）；
 *  - Codex：OpenAI / ChatGPT 品牌花体标记（黑底圆角方块 + 白花，OpenAI 官方 App 图标风格）。
 *    来源：Simple Icons 的 openai 标记（ChatGPT 与 Codex 同属 OpenAI 品牌）；
 *  - DeepSeek Harness：DeepSeek 官方鲸鱼标记（品牌蓝 #4d6bfe 底 + 白鲸）。
 *    来源：Simple Icons 的 deepseek 标记。
 */
function WorkBuddyMark() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id="wb-mark-bg" x1="20" y1="0" x2="20" y2="40" gradientUnits="userSpaceOnUse">
          <stop stopColor="#0EC8A9" />
          <stop offset="1" stopColor="#01C886" />
        </linearGradient>
        <linearGradient id="wb-mark-glyph" x1="14.6642" y1="11.0783" x2="33.3762" y2="43.4885" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="0.44" stopColor="#ffffff" />
        </linearGradient>
        <clipPath id="wb-mark-clip"><rect width="40" height="40" rx="20" /></clipPath>
      </defs>
      <g clipPath="url(#wb-mark-clip)">
        <rect width="40" height="40" rx="20" fill="url(#wb-mark-bg)" />
        <path d="M28.5931 3.12762C28.9853 2.77585 29.0091 2.76226 29.2968 2.74499C29.7628 2.71096 30.1894 2.93488 30.916 3.59634C32.6132 5.13875 34.9769 8.30904 36.4462 11.0168L37.0138 12.0682L37.8156 12.4668C38.5896 12.8579 39.8593 13.6593 40.3898 14.0895C40.6297 14.2878 40.6638 14.2925 40.9133 14.1954C42.0388 13.7572 43.6506 14.3382 45.0727 15.7024C46.3529 16.9294 47.5794 19.026 48.0491 20.7757C48.1177 21.0574 48.2087 21.6628 48.2419 22.1134C48.349 23.6964 47.8414 24.9608 46.8637 25.5331C46.664 25.6484 46.6505 25.6795 46.6561 26.1774C46.7011 28.5481 46.0621 30.9144 44.7785 33.2221C43.3293 35.8133 40.7489 38.4945 37.2566 41.0199C35.3813 42.3846 30.9445 44.9701 28.9382 45.8778C24.1324 48.0414 20.2794 48.8709 16.9329 48.4609C14.9368 48.219 12.6769 47.44 11.34 46.5355C10.9885 46.2925 10.9325 46.2774 10.6637 46.3543C9.2327 46.7651 7.35867 45.9207 5.76659 44.1535C5.13165 43.4471 4.1065 41.7127 3.77404 40.7843C3.0054 38.6118 3.15852 36.6506 4.18236 35.4799C4.44671 35.1785 4.45511 35.1658 4.39735 34.6589C4.30195 33.8289 4.25837 32.6008 4.30192 31.808L4.33666 31.0674L3.22502 29.101C1.5033 26.0375 0.409325 23.4645 -0.012563 21.4992C-0.235219 20.4218 -0.221193 19.9436 0.0522186 19.5899C0.21871 19.3763 0.764928 19.1545 1.42322 19.0329C3.08041 18.742 6.69466 19.0056 10.7155 19.7155L11.1329 19.788L12.0511 18.976C13.5747 17.6264 14.587 16.8696 16.4531 15.706C18.3981 14.4891 20.5929 13.4877 23.0648 12.695L23.8577 12.4414L24.2939 11.2964C25.8547 7.17615 27.4533 4.13844 28.5931 3.12762ZM15.5182 24.243C13.7542 25.2615 12.8718 25.7706 12.2236 26.3413C9.59893 28.6526 8.61811 32.3134 9.73545 35.6274C10.0114 36.4457 10.5201 37.3283 11.5386 39.0923C12.5571 40.8564 13.0671 41.7383 13.6378 42.3864C15.9491 45.0112 19.6103 45.9929 22.9243 44.8755C23.7426 44.5995 24.6249 44.0899 26.3888 43.0714L36.5375 37.2121C38.3016 36.1936 39.184 35.6845 39.8321 35.1137C42.4568 32.8024 43.4373 29.1409 42.3198 25.8269C42.0438 25.0086 41.5342 24.1264 40.5158 22.3624C39.4973 20.5983 38.9882 19.7159 38.4175 19.0678C36.1062 16.4432 32.4454 15.4622 29.1314 16.5796C28.3131 16.8556 27.431 17.3651 25.6669 18.3836L15.5182 24.243Z" fill="url(#wb-mark-glyph)" />
        <rect x="16.4961" y="31.3344" width="4.00904" height="8.32646" rx="2.00452" transform="rotate(-30 16.4961 31.3344)" fill="#ffffff" />
        <rect x="27.3125" y="25.0894" width="4.00904" height="8.32646" rx="2.00452" transform="rotate(-30 27.3125 25.0894)" fill="#ffffff" />
      </g>
    </svg>
  );
}

function CodexMark() {
  return (
    <svg viewBox="0 0 56 56" aria-hidden="true">
      <rect width="56" height="56" rx="15" fill="#0b0b0f" />
      <g transform="translate(10,10) scale(1.5)">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" fill="#ffffff" />
      </g>
    </svg>
  );
}

/** DeepSeek Harness：DeepSeek 官方鲸鱼标记（蓝色底 + 白鲸），与 Codex 同一套方块徽标画法。 */
function DshMark() {
  return (
    <svg viewBox="0 0 56 56" aria-hidden="true">
      <rect width="56" height="56" rx="15" fill="#4d6bfe" />
      <g transform="translate(10,10) scale(1.5)">
        <path d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" fill="#ffffff" />
      </g>
    </svg>
  );
}

const PROVIDER_META: Record<ComputeProviderId, { label: string; mark: () => ReactElement }> = {
  workbuddy: { label: "WorkBuddy", mark: WorkBuddyMark },
  codex: { label: "Codex", mark: CodexMark },
  dsh: { label: "DeepSeek Harness", mark: DshMark },
};

/**
 * 系统设置 →「算力提供商」。
 *
 * 交互口径（WorkBuddy）：
 *  · 未登录：图标灰掉，图标上覆盖「点击登录」，点了走 CodeBuddy SDK 的浏览器授权；
 *  · 已登录：图标正常，图标下方是启动开关（开 = 已启动 / 关 = 已停止）与「登出」；
 *  · Codex 使用 CLI 检测登录态，登录由 CLI 打开浏览器授权。
 *
 * 「启动开关」落到 LauncherState.enabledComputeProviders，
 * 由 LauncherApp 转成 agentModesOverride 传给 kit —— 禁用后聊天里就选不到这个框架。
 */
export default function ComputeProviderSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const enabled = enabledComputeProviders(launcher);
  const [providers, setProviders] = useState<LauncherComputeProvider[] | null>(null);
  const [pending, setPending] = useState<ComputeProviderId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dshDialog, setDshDialog] = useState(false);
  const [dshKey, setDshKey] = useState("");
  function closeDshDialog() { setDshKey(""); setError(null); setDshDialog(false); }
  useEffect(() => {
    if (!dshDialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pending !== "dsh") closeDshDialog();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dshDialog, pending]);
  async function saveKey() {
    setPending("dsh"); setError(null);
    try {
      const result = await window.launcher.saveDshKey(dshKey);
      if (!result.ok) { setError(result.error ?? t("compute.saveFailed")); return; }
      dispatch({ type: "SET_COMPUTE_PROVIDER_ENABLED", provider: "dsh", enabled: true });
      window.dispatchEvent(new Event("launcher:dsh-models-changed"));
      setDshKey(""); setDshDialog(false); await load(true);
    } catch { setError(t("compute.saveFailed")); } finally { setPending(null); }
  }
  async function deleteKey() {
    setPending("dsh"); setError(null);
    try {
      const result = await window.launcher.deleteDshKey();
      if (!result.ok) { setError(result.error ?? t("compute.deleteFailed")); return; }
      window.dispatchEvent(new Event("launcher:dsh-models-changed"));
      if (enabled.includes("dsh")) {
        if (enabled.length === 1) dispatch({ type: "SET_COMPUTE_PROVIDER_ENABLED", provider: "workbuddy", enabled: true });
        dispatch({ type: "SET_COMPUTE_PROVIDER_ENABLED", provider: "dsh", enabled: false });
      }
      setDshKey(""); setDshDialog(false); await load(true); await syncModels();
    } catch { setError(t("compute.deleteFailed")); } finally { setPending(null); }
  }
  // 登录/登出的 IPC 可能挂几分钟（等浏览器授权）：组件卸载后别再 setState。
  // 挂载时要显式置回 true —— StrictMode 的双挂载会先跑一次 cleanup，否则标记永远停在 false。
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Codex CLI 的平台包（437MB）不打进安装包：挂载时读一次状态，之后跟着下载进度更新。
  const [codexRuntime, setCodexRuntime] = useState<CodexRuntimeState | null>(null);
  useEffect(() => {
    void window.launcher.getCodexRuntime()
      .then((next) => { if (aliveRef.current) setCodexRuntime(next); })
      .catch(() => { /* 读不到就按「未知」渲染，不影响其它提供商 */ });
    return window.launcher.onCodexRuntimeState((next) => { if (aliveRef.current) setCodexRuntime(next); });
  }, []);

  async function downloadCodex() {
    if (pending) return;
    setPending("codex");
    setError(null);
    try {
      const result = await window.launcher.installCodexRuntime();
      if (!aliveRef.current) return;
      if (!result.ok) { setError(result.error || t("compute.downloadFailed")); return; }
      await load(true);
      await syncModels();
    } catch {
      if (aliveRef.current) setError(t("compute.downloadFailed"));
    } finally {
      if (aliveRef.current) setPending(null);
    }
  }

  const load = useCallback(async (force = false) => {
    try {
      const list = await window.launcher.getComputeProviders(force);
      if (aliveRef.current) setProviders(list);
    } catch (err) {
      console.error("[launcher] 读取算力提供商状态失败：", err);
      if (aliveRef.current) { setProviders([]); setError(t("compute.loadFailed")); }
    }
  }, [t]);

  useEffect(() => {
    // 走缓存：设置窗切换分类会把本组件卸载再挂载，强制探测每次都拉一个 CLI 子进程。
    // 登录 / 登出 / 重新聚焦时主进程会 invalidate 并广播，这里的监听会拿到最新值。
    void load();
    return window.launcher.onComputeProvidersChanged(() => { void load(); });
  }, [load]);

  /** 登录/登出后模型列表会变（未登录只有 models.json 的自定义模型），重新拉一次交给聊天窗。 */
  async function syncModels() {
    dispatch({ type: "SET_MODELS_LOADING" });
    const models = await reloadLauncherModels();
    if (aliveRef.current) dispatch(models === null ? { type: "SET_MODELS_FAILED" } : { type: "SET_MODELS", models });
  }

  async function signIn(provider: ComputeProviderId) {
    if (pending) return;
    setPending(provider);
    setError(null);
    try {
      const result = await window.launcher.loginComputeProvider(provider);
      if (!aliveRef.current) return;
      if (result.ok) {
        await load(true);
        await syncModels();
      } else {
        setError(result.error || t("compute.loginFailed"));
      }
    } catch {
      if (aliveRef.current) setError(t("compute.loginError"));
    } finally {
      if (aliveRef.current) setPending(null);
    }
  }

  async function signOut(provider: ComputeProviderId) {
    if (pending) return;
    setPending(provider);
    setError(null);
    try {
      const result = await window.launcher.logoutComputeProvider(provider);
      if (!aliveRef.current) return;
      if (result.ok) {
        await load(true);
        await syncModels();
      } else {
        setError(result.error ?? t("compute.logoutFailed"));
      }
    } catch (err) {
      if (aliveRef.current) setError(err instanceof Error ? err.message : t("compute.logoutFailed"));
    } finally {
      if (aliveRef.current) setPending(null);
    }
  }

  function toggleEnabled(provider: ComputeProviderId) {
    const next = !enabled.includes(provider);
    // 关掉最后一个已启动的提供商 = 聊天没有框架可用：不给它静默失效，直接把原因说出来。
    if (!next && enabled.length <= 1) {
      setError(t("compute.oneRequired"));
      return;
    }
    setError(null);
    dispatch({ type: "SET_COMPUTE_PROVIDER_ENABLED", provider, enabled: next });
  }

  return (
    <section className="compute-providers" aria-label={t("compute.providers")}>
      <div className="appearance-section-head appearance-section-head--first">{t("compute.providers")}</div>
      <div className="compute-provider-grid">
        {COMPUTE_PROVIDER_IDS.map((id) => {
          const meta = PROVIDER_META[id];
          const live = providers?.find((item) => item.id === id);
          // providers 还没回来时按「检测中」渲染：此时既不能登录也不能启动。
          const checking = providers === null;
          const authenticated = Boolean(live?.authenticated);
          const configured = id === "dsh" && Boolean(live?.configured);
          const available = live?.available ?? id === "workbuddy";
          const isEnabled = enabled.includes(id);
          const busy = pending === id;
          const offline = !authenticated;
          const onlyEnabled = isEnabled && enabled.length <= 1;
          // Codex 平台包按需下载（437MB）：未安装时代替「点击登录」显示下载入口与进度。
          const runtimeMissing = id === "codex" && codexRuntime !== null && !codexRuntime.installed;
          const runtimePercent = codexRuntime && codexRuntime.total > 0
            ? Math.min(100, Math.round((codexRuntime.downloaded / codexRuntime.total) * 100))
            : 0;
          const Mark = meta.mark;
          return (
            <div
              key={id}
              className={`compute-provider${offline ? " is-offline" : ""}${!available || (!isEnabled && authenticated) ? " is-inactive" : ""}`}
              data-provider={id}
              // 探测失败（CLI 缺失 / 环境异常）时把原因挂在 title 上，不额外占版面。
              title={live?.error || undefined}
            >
              <div className="compute-provider-mark">
                <Mark />
                {checking ? (
                  <span className="compute-provider-overlay is-busy">{t("compute.checking")}</span>
                ) : null}
                {!checking && runtimeMissing ? (
                  <button
                    type="button"
                    className="compute-provider-overlay"
                    onClick={() => void downloadCodex()}
                    disabled={busy || codexRuntime?.downloading}
                    aria-label={t("compute.download")}
                    title={codexRuntime?.error || t("compute.missingRuntime")}
                  >
                    {codexRuntime?.downloading
                      ? t("compute.downloading", { percent: runtimePercent })
                      : t("compute.download")}
                  </button>
                ) : null}
                {!checking && !runtimeMissing && available && !authenticated ? (
                  <button
                    type="button"
                    className="compute-provider-overlay"
                    onClick={() => id === "dsh" ? setDshDialog(true) : void signIn(id)}
                    disabled={busy}
                    aria-label={id === "dsh" ? t("compute.configureKey") : t("compute.signInProvider", { provider: meta.label })}
                  >
                    {busy ? t("compute.waiting") : id === "dsh" ? configured ? t("compute.updateKey") : t("compute.setKey") : t("compute.signIn")}
                  </button>
                ) : null}
              </div>
              <span className="compute-provider-name">
                {meta.label}
                {authenticated
                  ? <i className={`compute-provider-dot${isEnabled ? " is-on" : ""}`} aria-hidden="true" />
                  : null}
              </span>
              {authenticated ? (
                <div className="compute-provider-actions">
                  <span className="compute-provider-toggle">
                    <button
                      type="button"
                      role="switch"
                      className="appearance-switch compute-provider-switch"
                      aria-label={t("compute.enableProvider", { provider: meta.label })}
                      aria-checked={isEnabled}
                      disabled={busy}
                      title={isEnabled
                        ? (onlyEnabled ? t("compute.onlyEnabled") : t("compute.enabledHint"))
                        : t("compute.disabledHint")}
                      onClick={() => toggleEnabled(id)}
                    >
                      <span aria-hidden="true" />
                    </button>
                    <span className={`compute-provider-state${isEnabled ? " is-on" : ""}`}>
                      {isEnabled ? t("compute.enabled") : t("compute.disabled")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="compute-provider-action"
                    disabled={busy}
                    // dsh 没有浏览器授权可退，登出就是删掉本机保存的 API Key。
                    onClick={() => void (id === "dsh" ? deleteKey() : signOut(id))}
                  >
                    {busy ? t("compute.processing") : t("compute.signOut")}
                  </button>
                </div>
              ) : null}
              {!available
                ? <span className="compute-provider-hint">{runtimeMissing ? t("compute.missingRuntime") : t("compute.unavailable")}</span>
                : null}
              {/* 复用本机已装的同版本 codex：明确告知没走下载，避免用户以为装了两份。 */}
              {id === "codex" && codexRuntime?.source === "local"
                ? <span className="compute-provider-hint">{t("compute.localRuntime", { version: codexRuntime.version })}</span>
                : null}
              {id === "dsh" && configured && !authenticated && live?.error ? <span className="compute-provider-error" role="status">{live.error}</span> : null}
            </div>
          );
        })}
      </div>
      {dshDialog ? createPortal(<div className="desktop-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && pending !== "dsh") closeDshDialog(); }}>
        <form className="dsh-settings" role="dialog" aria-modal="true" aria-labelledby="dsh-settings-title" onSubmit={(event) => { event.preventDefault(); if (dshKey.trim() && pending !== "dsh") void saveKey(); }}>
          <h3 id="dsh-settings-title">{t("compute.configureKey")}</h3>
          <label><input aria-label="API Key" autoFocus type="password" autoComplete="off" value={dshKey} onChange={(event) => setDshKey(event.target.value)} placeholder={providers?.find(p => p.id === "dsh")?.configured ? t("compute.replaceKey") : t("compute.enterKey")} /></label>
          <p>{t("compute.keyStorage")}</p>
          {error ? <p className="compute-provider-error" role="alert">{error}</p> : null}
          <div><button type="submit" disabled={!dshKey.trim() || pending === "dsh"}>{t("compute.saveKey")}</button>{providers?.find(p => p.id === "dsh")?.configured ? <button type="button" disabled={pending === "dsh"} onClick={() => void deleteKey()}>{t("compute.deleteKey")}</button> : null}<button type="button" disabled={pending === "dsh"} onClick={closeDshDialog}>{t("compute.cancel")}</button></div>
        </form>
      </div>, document.body) : null}
      {!dshDialog && error ? <p className="compute-provider-error" role="alert">{error}</p> : null}
    </section>
  );
}
