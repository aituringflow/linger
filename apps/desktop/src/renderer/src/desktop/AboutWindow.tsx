import { useTranslation } from "../i18n";
import { useEffect, useState } from "react";
import { useLauncher } from "../state";
import { wallpaperSkinId } from "../wallpapers";
import { AppIcon } from "../icons";
import WindowFrame from "../dock/WindowFrame";
import turingflowLogo from "../assets/turingflow_logo.png";

/** 弹窗高度估值：只用来把它摆在屏幕正中（高度实际由内容撑开，fitContent）。 */
const DIALOG_HEIGHT = 236;

/**
 * 展示用的应用名由主进程按系统语言给出（中文系统「灵儿」/ 其它 Linger），
 * 见 apps/desktop/src/main/app-display-name.ts；`app.getName()` 取的是
 * package.json 的 name（"desktop"），不适合给用户看。版本同样走主进程。
 */
const APP_DISPLAY_NAME_FALLBACK = "Linger";

type AppInfo = Awaited<ReturnType<typeof window.launcher.getAppInfo>>;

/**
 * 「关于」窗口。
 *
 * 与「选择数域」/「系统设置」同一套 WindowFrame 渲染的真窗口（只有关闭按钮、不可缩放、
 * 屏幕正中）。内容：旋转的 Home 图标 + 应用名 + 版本号；底部一行 TuringFlow logo + copyright
 * （与 web 端同款 logo 小图）。不再罗列 Electron / Chromium / Node / 平台。
 *
 * 交互：Esc / 左上角关闭按钮 / 点击弹窗外任意位置 = 收起。
 */
export default function AboutWindow() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const skinId = wallpaperSkinId(launcher.wallpaper);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const close = () => dispatch({ type: "SET_ABOUT_WINDOW", open: false });

  useEffect(() => {
    let alive = true;
    void window.launcher.getAppInfo().then((value) => { if (alive) setInfo(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "SET_ABOUT_WINDOW", open: false });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dispatch]);

  useEffect(() => {
    // modalless：点击弹窗外的任意位置直接收起（与选择数域 / 系统设置一致）。
    const onDocPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-window-id="launcher-about"]')) return;
      dispatch({ type: "SET_ABOUT_WINDOW", open: false });
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () => document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [dispatch]);

  // 竖直居中：窗口的 top = 12 + offsetY，所以 offsetY 要扣掉这 12px 的基准。
  const centeredY = Math.max(0, Math.round((window.innerHeight - DIALOG_HEIGHT) / 2) - 12);

  return (
    <>
      <div className="domain-picker-backdrop" aria-hidden="true" onClick={close} />
      <WindowFrame
        id="launcher-about"
        skinId={skinId}
        className="is-dialog"
        style={{ zIndex: 950 }}
        ariaLabel={t("common.about")}
        header={<strong className="window-frame-title">{t("common.about")}</strong>}
        headerAlign="center"
        controls={{ close: true, minimize: false, maximize: false }}
        resizable={false}
        rememberGeometry={false}
        fitContent
        initialSize={{ width: 320 }}
        initialOffset={{ x: 0, y: centeredY }}
        onClose={close}
      >
        <div className="launcher-about-body">
          <div className="launcher-about-head">
            <strong className="launcher-about-appname">{info?.displayName ?? APP_DISPLAY_NAME_FALLBACK}</strong>
            <div className="launcher-about-appicon is-spinning">
              <AppIcon kind="primary" size={56} skin={launcher.appearance === "light" || launcher.appearance === "dark" ? launcher.appearance : skinId} />
            </div>
            <span className="launcher-about-version">{t("common.version", { version: info?.version ?? "—" })}</span>
          </div>
          <div className="launcher-about-footer">
            <img src={turingflowLogo} alt="TuringFlow" className="launcher-about-footer-logo" />
            <span>© {new Date().getFullYear()} TuringFlow. All rights reserved.</span>
          </div>
        </div>
      </WindowFrame>
    </>
  );
}
