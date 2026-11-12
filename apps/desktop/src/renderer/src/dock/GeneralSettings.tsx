import { useEffect, useState } from "react";
import type { NotificationSound } from "../../../shared/types";
import { MULTI_FRAMEWORK_KEY, readMultiFramework, subscribeUiPrefs, voiceHoldKeyAriaLabel, voiceHoldKeyLabel, writeMultiFramework } from "@turingflow/agent-kit/ui";
import { useLauncher } from "../state";
import { useTranslation } from "../i18n";
import type { TranslationKey } from "../locales/zh-CN";
import SettingsGroup from "./SettingsGroup";
import { playLauncherNotificationSound } from "./notificationSound";
import { playDragonFireSound } from "./dragonSound";

/** 与 local app / agent-kit 的「通知提示音」保持一致。 */
const NOTIFICATION_SOUNDS: Array<{ id: NotificationSound; label: TranslationKey }> = [
  { id: "off", label: "general.soundOff" },
  { id: "bright", label: "general.soundBright" },
  { id: "calm", label: "general.soundCalm" },
  { id: "playful", label: "general.soundPlayful" },
  { id: "system", label: "general.soundSystem" },
];

/**
 * 系统设置里各分类用到的开关行。
 *
 * 以前是一个长面板（SystemSettingsPanel）直接摊在窗口里；改成左右分栏后按分类拆开：
 *  · 外观 → AppearanceSettings（壁纸 / 外观模式，在 SettingsWindow 里直接渲染）
 *  · 算力 → MultiFrameworkSettings（输入框显示框架列表 / 输入框显示模型列表）
 *  · 其他 → NotificationSettings / VoiceSettings / PetSettings
 * 全部共用 launcher state，与右键快捷面板里的外观设置同一份数据。
 */

/**
 * 算力分类：选项组 —— 输入框显示框架列表 + 输入框显示模型列表。
 *
 * 「输入框显示框架列表」一直可见，开关默认关闭（未设置过偏好时输入框不显示框架下拉）；
 * 与 kit 用户菜单里的「多框架」共用同一份 localStorage 偏好（agent-kit:multi-framework）：
 * 打开后 kit 通过 subscribeUiPrefs 广播，所有已打开的聊天窗输入框立即出现框架下拉；
 * 这里也订阅同一事件，用户在聊天窗用户菜单里切「多框架」时，本开关保持同步。
 * 仅激活一个框架时下拉不会出现（可用框架 > 1 才渲染），但开关本身保持可见、可设置。
 *
 * 「输入框显示模型列表」控制聊天输入框的模型下拉（launcher.showModel，受控传给 kit）。
 */
export function MultiFrameworkSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const [multiFramework, setMultiFramework] = useState<boolean>(() => readMultiFramework());
  useEffect(() => subscribeUiPrefs((key, value) => {
    if (key === MULTI_FRAMEWORK_KEY) setMultiFramework(value ?? readMultiFramework());
  }), []);
  return (
    <SettingsGroup title={t("general.options")}>
      <div className="appearance-setting-row">
        <span>{t("general.showFrameworks")}</span>
        <button
          type="button"
          role="switch"
          className="appearance-switch"
          aria-label={t("general.showFrameworks")}
          aria-checked={multiFramework}
          onClick={() => {
            const next = !multiFramework;
            setMultiFramework(next);
            writeMultiFramework(next);
          }}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="appearance-setting-row">
        <span>{t("general.showModels")}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.showModels")} aria-checked={launcher.showModel ?? false} onClick={() => dispatch({ type: "SET_SHOW_MODEL", show: !(launcher.showModel ?? false) })}>
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}

/** 其他分类：通知提示音。 */
export function NotificationSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const notificationSound = launcher.notificationSound ?? "system";

  function changeNotificationSound(sound: NotificationSound) {
    dispatch({ type: "SET_NOTIFICATION_SOUND", sound });
    // 与 local app 一致：选「系统」弹一条试听通知，选自定义音效就地试听；关闭则静默。
    if (sound === "system") {
      void window.launcher.showNotification({
        windowId: "primary",
        sessionId: "notification-preview",
        title: t("general.soundPreviewTitle"),
        body: t("general.soundPreviewBody"),
        silent: false,
      }).catch(() => {});
    } else {
      playLauncherNotificationSound(sound, `launcher-sound-preview-${Date.now()}`);
    }
  }

  return (
    <SettingsGroup title={t("general.notifications")}>
      <div className="appearance-setting-row">
        <label htmlFor="launcher-notification-sound">{t("general.notificationSound")}</label>
        <select
          id="launcher-notification-sound"
          className="appearance-select"
          value={notificationSound}
          onChange={(event) => changeNotificationSound(event.target.value as NotificationSound)}
        >
          {NOTIFICATION_SOUNDS.map((sound) => (
            <option key={sound.id} value={sound.id}>{t(sound.label)}</option>
          ))}
        </select>
      </div>
    </SettingsGroup>
  );
}

/** 其他分类：输入框显示选项。 */
export function ContextUsageSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const show = state.launcher?.showContextUsage ?? false;
  return (
    <SettingsGroup title={t("general.composer")}>
      <div className="appearance-setting-row">
        <span>{t("general.showContext")}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.showContext")} aria-checked={show} onClick={() => dispatch({ type: "SET_SHOW_CONTEXT_USAGE", show: !show })}>
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}

/** 语音优先模式下聊天窗自动消失的候选项（分钟，0 = 从不）。 */
const VOICE_FIRST_HIDE_OPTIONS: Array<{ minutes: number; label: string }> = [
  { minutes: 1, label: "1 分钟" },
  { minutes: 5, label: "5 分钟" },
  { minutes: 10, label: "10 分钟" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 0, label: "从不" },
];

/** 其他分类：语音输入。 */
export function VoiceSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const voiceFirst = launcher.voiceFirst ?? false;
  const hideMinutes = launcher.voiceFirstWindowMinutes ?? 5;
  const holdLabel = voiceHoldKeyLabel();
  /**
   * 语音优先开启时，「按住说话」总开关被强制打开且不可关闭——语音优先的整个交互
   * （没窗口时按住 Option 说话、松手自动发）都建立在按住说话生效的前提上。
   * 这里只做展示约束：开关恒为开（aria-checked=true），点击被拦截（aria-disabled）。
   * 真正把 rightCtrlVoice 置 true 的动作在打开语音优先的那次点击里一并 dispatch，
   * 保证即便用户之前关过，打开语音优先也立即恢复。
   */
  const rightCtrlVoiceForced = voiceFirst;
  const rightCtrlVoice = rightCtrlVoiceForced || (launcher.rightCtrlVoice ?? true);
  return (
    <SettingsGroup title="语音">
      {/* 语音优先置顶：它是这套语音交互的总开关，下面三项都围着它转。 */}
      <div className="appearance-setting-row">
        <span>
          {t("general.voiceFirst")}
          <span className="appearance-setting-inline-note">{t("general.voiceHoldNote", { key: holdLabel })}</span>
        </span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.voiceFirst")} aria-checked={voiceFirst} onClick={() => {
          const enabled = !voiceFirst;
          dispatch({ type: "SET_VOICE_FIRST", enabled });
          // 打开时一并把「按住说话」强制打开；关闭时不再强制（保留用户后续可改）。
          if (enabled) dispatch({ type: "SET_RIGHT_CTRL_VOICE", enabled: true });
        }}>
          <span aria-hidden="true" />
        </button>
      </div>
      <div className="appearance-setting-row">
        <span>{t("general.voiceHold", { key: holdLabel })}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.voiceHold", { key: voiceHoldKeyAriaLabel() })} aria-checked={rightCtrlVoice} aria-disabled={rightCtrlVoiceForced} onClick={() => {
          if (rightCtrlVoiceForced) return;
          dispatch({ type: "SET_RIGHT_CTRL_VOICE", enabled: !(launcher.rightCtrlVoice ?? true) });
        }}>
          <span aria-hidden="true" />
        </button>
      </div>
      {voiceFirst ? (
        <div className="appearance-setting-row">
          <label htmlFor="launcher-voice-first-hide">{t("general.autoHideChat")}</label>
          <select
            id="launcher-voice-first-hide"
            className="appearance-select"
            value={hideMinutes}
            onChange={(event) => dispatch({ type: "SET_VOICE_FIRST_WINDOW_MINUTES", minutes: Number(event.target.value) })}
          >
            {VOICE_FIRST_HIDE_OPTIONS.map((option) => (
              <option key={option.minutes} value={option.minutes}>{option.minutes ? `${option.minutes} ${t("general.minutes")}` : t("general.never")}</option>
            ))}
            {/* 手改状态文件填了表外值（比如 7 分钟）时保留它，别被选项表悄悄改成 5 分钟。 */}
            {!VOICE_FIRST_HIDE_OPTIONS.some((option) => option.minutes === hideMinutes) && (
              <option value={hideMinutes}>{hideMinutes} {t("general.minutes")}</option>
            )}
          </select>
        </div>
      ) : null}
      <div className="appearance-setting-row">
        <span>{t("general.showMic")}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.showMic")} aria-checked={launcher.showVoiceButton ?? true} onClick={() => dispatch({ type: "SET_SHOW_VOICE_BUTTON", show: !(launcher.showVoiceButton ?? true) })}>
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}

/** 其他分类：桌面宠物（小龙）。 */
export function PetSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const dragonFireSound = launcher.dragonFireSound ?? false;
  const dragonVisible = launcher.dragonVisible ?? true;

  function changeDragonFireSound(enabled: boolean) {
    dispatch({ type: "SET_DRAGON_FIRE_SOUND", enabled });
    // 打开时试听一下，确认音效确实能响（关掉时静默，不出声）。
    if (enabled) playDragonFireSound(true);
  }

  return (
    <SettingsGroup title={t("general.pet")}>
      {/* 小龙喷火音效：关掉后点击小龙照样喷火，只是不出声。 */}
      <div className="appearance-setting-row">
        <span>{t("general.dragonSound")}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.dragonSound")}
          aria-checked={dragonFireSound}
          onClick={() => changeDragonFireSound(!dragonFireSound)}>
          <span aria-hidden="true" />
        </button>
      </div>
      {/* 小龙显隐：右键小龙 →「隐藏火龙」走的是同一条 SET_DRAGON_VISIBLE，
          这里提供恢复入口；隐藏后小龙组件卸载，点击/右键都不再生效。 */}
      <div className="appearance-setting-row">
        <span>{t("general.showPet")}</span>
        <button type="button" role="switch" className="appearance-switch" aria-label={t("general.showPet")}
          aria-checked={dragonVisible}
          onClick={() => dispatch({ type: "SET_DRAGON_VISIBLE", visible: !dragonVisible })}>
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}

/** 其他分类：电源（有任务运行时保持唤醒）。 */
export function PowerSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  // 默认开：长任务跑到一半屏幕睡过去、锁屏，回来还得重新解锁看进度，体验很差。
  const keepAwakeOnTask = launcher.keepAwakeOnTask ?? true;
  return (
    <SettingsGroup title={t("general.power")}>
      {/* 开关只决定「有没有这个能力」；真正拦休眠的时机由 App 判定：
          只要还有一个会话在跑，主进程就拿着系统电源断言（macOS IOPMAssertion /
          Windows SetThreadExecutionState）；所有任务结束后释放，不改变系统本身的休眠设置。 */}
      <div className="appearance-setting-row">
        <span>
          {t("general.keepAwake")}
          <span className="appearance-setting-inline-note">{t("general.keepAwakeNote")}</span>
        </span>
        <button
          type="button"
          role="switch"
          className="appearance-switch"
          aria-label={t("general.keepAwake")}
          aria-checked={keepAwakeOnTask}
          onClick={() => dispatch({ type: "SET_KEEP_AWAKE_ON_TASK", enabled: !keepAwakeOnTask })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}

/** 其他分类：Dock（自动隐藏）。 */
export function DockSettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const autoHideDock = launcher.autoHideDock ?? false;
  const dockDomainEntry = launcher.dockDomainEntry ?? false;
  return (
    <SettingsGroup title="Dock">
      {/* 数域入口：开启后 Dock 上常驻一个 Launchpad 样式的图标，点它弹出「选择数域」。 */}
      <div className="appearance-setting-row">
        <span>{t("general.dockEntry")}</span>
        <button
          type="button"
          role="switch"
          className="appearance-switch"
          aria-label={t("general.dockEntry")}
          aria-checked={dockDomainEntry}
          onClick={() => dispatch({ type: "SET_DOCK_DOMAIN_ENTRY", enabled: !dockDomainEntry })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      {/* 自动隐藏 Dock：开关打开后 Dock 缩到屏幕外，鼠标移到屏幕底部边缘才滑出（动画/时序对齐 macOS）。
          隐藏时 Dock 不占位，最大化窗口可占据原 Dock 所在空间。 */}
      <div className="appearance-setting-row">
        <span>{t("general.dockAutoHide")}</span>
        <button
          type="button"
          role="switch"
          className="appearance-switch"
          aria-label={t("general.dockAutoHide")}
          aria-checked={autoHideDock}
          onClick={() => dispatch({ type: "SET_AUTO_HIDE_DOCK", enabled: !autoHideDock })}
        >
          <span aria-hidden="true" />
        </button>
      </div>
    </SettingsGroup>
  );
}
