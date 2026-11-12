import { useEffect, useState } from "react";
import { useLauncher } from "../state";
import { useTranslation } from "../i18n";
import { wallpaperSkinId } from "../wallpapers";
import WindowFrame from "../dock/WindowFrame";
import AppearanceSettings from "../dock/AppearanceSettings";
import ComputeProviderSettings from "../dock/ComputeProviderSettings";
import { MultiFrameworkSettings, NotificationSettings, PetSettings, PowerSettings, VoiceSettings, DockSettings, ContextUsageSettings } from "../dock/GeneralSettings";
import { CustomModels } from "@turingflow/agent-kit/ui";
import { reloadLauncherModels } from "../state";

/** 左侧分类列表的条目（顺序 = 列表里从上往下的顺序）。 */
const SECTIONS = [
  { id: "appearance", key: "settings.appearance" },
  { id: "language", key: "settings.language" },
  { id: "compute", key: "settings.compute" },
  { id: "voice", key: "settings.voice" },
  { id: "other", key: "settings.other" },
] as const;

type SettingsSection = typeof SECTIONS[number]["id"];

/**
 * 弹窗高度估值：只用来把它摆在屏幕正中（高度实际由内容撑开，fitContent）。
 * 内容 = 顶栏 40 + 右侧内容区最小高度 560（见 styles-launcher.css 的 .launcher-settings-body）。
 * 内嵌自定义模型列表后内容更宽，故整体放大，避免窗口比「添加/编辑模型」弹窗还小。
 */
const DIALOG_HEIGHT = 660;

/** 窗口宽度：左栏 148 + 右栏内容 572。窄屏时让出左右各 24px。 */
const DIALOG_WIDTH = 720;

/**
 * 「系统设置」窗口。
 *
 * 与「联系人」窗口同一套 WindowFrame 渲染出来的真窗口：
 * 三个完整按钮（关闭/最小化/最大化）、可拖动、点击外部不自动关闭。
 *
 * 布局是左右分栏：左侧分类列表（外观 / 算力 / 其他），右侧是选中分类的设置内容。
 * 外观与右键快捷面板复用同一个 AppearanceSettings，其余行按分类拆在 GeneralSettings 里。
 */
export default function SettingsWindow({ layer = 101, minimized = false, focused = false }: { layer?: number; minimized?: boolean; focused?: boolean }) {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const language = launcher.language ?? "system";
  const { t } = useTranslation();
  const skinId = wallpaperSkinId(launcher.wallpaper);
  const [section, setSection] = useState<SettingsSection>(() => {
    const requested = sessionStorage.getItem("launcher:settings-section");
    sessionStorage.removeItem("launcher:settings-section");
    return requested === "compute" ? "compute" : "appearance";
  });
  useEffect(() => {
    const selectCompute = () => {
      sessionStorage.removeItem("launcher:settings-section");
      setSection("compute");
    };
    window.addEventListener("launcher:select-compute-settings", selectCompute);
    return () => window.removeEventListener("launcher:select-compute-settings", selectCompute);
  }, []);
  const close = () => dispatch({ type: "CLOSE_CHAT", windowId: "settings" });

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "CLOSE_CHAT", windowId: "settings" });
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [dispatch]);

  // 在「自定义模型」里增删改后，models.json 变了，重新拉一次交给聊天窗（与本地 app 个人中心同口径）。
  useEffect(() => {
    const onChanged = () => { dispatch({ type: "SET_MODELS_LOADING" }); void reloadLauncherModels().then((models) => dispatch(models === null ? { type: "SET_MODELS_FAILED" } : { type: "SET_MODELS", models })); };
    window.addEventListener("agent-kit:models-changed", onChanged);
    return () => window.removeEventListener("agent-kit:models-changed", onChanged);
  }, [dispatch]);

  // 竖直居中：窗口的 top = 12 + offsetY，所以 offsetY 要扣掉这 12px 的基准。
  const centeredY = Math.max(0, Math.round((window.innerHeight - DIALOG_HEIGHT) / 2) - 12);

  return (
    <WindowFrame
      id="launcher-settings"
      skinId={skinId}
      className="is-dialog"
      style={{ zIndex: layer }}
      ariaLabel={t("settings.title")}
      header={<strong className="window-frame-title">{t("settings.title")}</strong>}
      headerAlign="center"
      controls={{ close: true, minimize: true, maximize: true }}
      resizable={false}
      rememberGeometry={false}
      fitContent
      initialSize={{ width: Math.min(DIALOG_WIDTH, window.innerWidth - 48) }}
      initialOffset={{ x: 0, y: centeredY }}
      onClose={close}
      onFocus={() => dispatch({ type: "FOCUS_CHAT_WINDOW", windowId: "settings" })}
      onMinimize={() => dispatch({ type: "MINIMIZE_CHAT", windowId: "settings" })}
      minimized={minimized}
      focused={focused}
    >
      <div className="launcher-settings">
        <nav className="launcher-settings-nav" aria-label={t("settings.categories")}>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="launcher-settings-nav-item"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
        </nav>
        <div className="launcher-settings-body">
          {section === "appearance" ? (
            <AppearanceSettings />
          ) : null}
          {section === "language" ? (
            <section className="appearance-settings" aria-label={t("settings.language")}>
              <div className="appearance-section-head appearance-section-head--first">{t("settings.language")}</div>
              <div className="appearance-mode-list" role="group" aria-label={t("language.interface")}>
                {([ ["system", t("language.system")], ["zh-CN", t("language.chinese")], ["en", t("language.english")] ] as const).map(([value, label]) => (
                  <button key={value} type="button" className={language === value ? "selected" : ""} aria-pressed={language === value} onClick={() => dispatch({ type: "SET_LANGUAGE", language: value })}>{label}</button>
                ))}
              </div>
            </section>
          ) : null}
          {section === "compute" ? (
            <>
              <ComputeProviderSettings />
              <MultiFrameworkSettings />
              {/* 自定义模型：复用 agent-kit 的 CustomModels（与本地 app 个人中心同一套 UI），
                  内嵌渲染在算力页里，配置落到 ~/.linger/models.json，不再弹窗。 */}
              <div className="launcher-settings-group" aria-label={t("settings.customModels")}>
                <div className="appearance-section-head appearance-section-head--first">{t("settings.customModels")}</div>
                <CustomModels inline />
              </div>
            </>
          ) : null}
          {section === "voice" ? (
            <VoiceSettings />
          ) : null}
          {section === "other" ? (
            <>
              <ContextUsageSettings />
              <PowerSettings />
              <NotificationSettings />
              <PetSettings />
              <DockSettings />
            </>
          ) : null}
        </div>
      </div>
    </WindowFrame>
  );
}
