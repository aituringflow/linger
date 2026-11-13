import fs from "node:fs";
import path from "node:path";
import type { AppearanceMode, LauncherState, NotificationSound } from "../shared/types";

/**
 * 默认 seed 状态：内置数域、Dock 项、应用图标。
 * 本地演示会话与桌面卡片已整体退役，会话全部由 kit（LocalChatStore + 本地 Agent 服务）管理。
 */
/** 当前接入的数域白名单：选择数域的弹窗与 Dock 只认这几个。
 *  新增数域时改这里（再补 icons 映射与默认皮肤色），旧数据会在 load 时被裁剪掉。 */
export const DOMAIN_IDS = ["dingtalk", "feishu", "wechat", "contacts", "knowledge"] as const;

/** 数是"哪个应用"的识别色：输入卡片描边。每次 load 按这里重写，避免旧数据里留着过期的颜色。 */
const DOMAIN_BORDERS: Record<string, string> = {
  dingtalk: "1px solid rgba(22, 119, 255, .75)",
  feishu: "1px solid rgba(123, 92, 255, .75)",
  wechat: "1px solid rgba(88, 88, 88, .75)",
  contacts: "1px solid rgba(42, 157, 116, .75)",
  knowledge: "1px solid rgba(139, 92, 246, .75)",
};

function defaultState(): LauncherState {
  return {
    version: 7,
    domains: [
      { id: "dingtalk", name: "钉钉", color: "#1677ff", skinColor: "#1677ff", composerBorder: "1px solid rgba(22, 119, 255, .75)" },
      // 飞书用品牌紫描边：和钉钉的蓝框一眼区分开（窗口多了靠边框色识别是哪个应用）。
      { id: "feishu", name: "飞书", color: "#7b5cff", skinColor: "#7b5cff", composerBorder: "1px solid rgba(123, 92, 255, .75)" },
      { id: "wechat", name: "微信", color: "#666666", skinColor: "#666666", composerBorder: "1px solid rgba(88, 88, 88, .75)" },
      { id: "contacts", name: "联系人", color: "#2a9d74", skinColor: "#2a9d74", composerBorder: DOMAIN_BORDERS.contacts },
      { id: "knowledge", name: "知识库", color: "#8b5cf6", skinColor: "#8b5cf6", composerBorder: "1px solid rgba(139, 92, 246, .75)" },
    ],
    dockItems: [
      { id: "d-primary", kind: "primary", label: "问" },
      { id: "sep-1", kind: "separator", label: "" },
      { id: "d-app-knowledge", kind: "app", label: "知识库", appId: "knowledge" },
      { id: "d-app-files", kind: "app", label: "文件", appId: "files" },
      { id: "d-app-browser", kind: "app", label: "浏览器", appId: "browser" },
      { id: "d-app-mail", kind: "app", label: "邮件", appId: "mail" },
      { id: "d-app-settings", kind: "app", label: "设置", appId: "settings" },
    ],
    dockPins: { left: [], right: [] },
    apps: [
      { id: "knowledge", name: "知识库" },
      { id: "files", name: "文件" },
      { id: "browser", name: "浏览器" },
      { id: "mail", name: "邮件" },
      { id: "settings", name: "设置" },
    ],
    wallpaper: { kind: "builtin", value: "wallpapers/default" },
    appearance: "light",
    showModel: false,
    showContextUsage: false,
    showVoiceButton: true,
    rightCtrlVoice: true,
    dockDomainEntry: false,
    voicePreviewOnly: false,
    voiceFirst: false,
    voiceFirstWindowMinutes: 5,
    notificationSound: "system",
    dragonFireSound: false,
    dragonVisible: true,
    // 有任务运行时保持唤醒：默认开（跑长任务时电脑别睡过去、别锁屏）。
    keepAwakeOnTask: true,
    customWallpaper: "wallpapers/wp1.jpg",
    fireParams: { intensity: 2, amplitude: 50 },
    activeDomainId: DOMAIN_IDS[0],
  };
}

/** 通知提示音归一化：旧状态没有该字段时用系统音；非法值同样回落系统音。 */
function notificationPrefs(state: LauncherState): Pick<LauncherState, "notificationSound"> {
  const sounds: readonly NotificationSound[] = ["off", "bright", "calm", "playful", "system"];
  const sound = sounds.includes(state.notificationSound as NotificationSound)
    ? state.notificationSound as NotificationSound
    : "system";
  return { notificationSound: sound };
}

/** 小龙喷火音效：旧状态没有该字段时默认关；只有显式 true 才出声。 */
function dragonFirePref(state: LauncherState): Pick<LauncherState, "dragonFireSound"> {
  return { dragonFireSound: state.dragonFireSound ?? false };
}

/** 小龙显隐：旧状态没有该字段时默认显示；只有显式 false 才隐藏。 */
function dragonVisiblePref(state: LauncherState): Pick<LauncherState, "dragonVisible"> {
  return { dragonVisible: state.dragonVisible ?? true };
}

/** 有任务运行时保持唤醒：旧状态没有该字段时默认开；只有显式 false 才关。 */
function keepAwakePref(state: LauncherState): Pick<LauncherState, "keepAwakeOnTask"> {
  return { keepAwakeOnTask: state.keepAwakeOnTask ?? true };
}

/**
 * 语音优先（原「实时转录」）。
 *
 * 老状态里这个开关叫 voiceRealtimeTranscription —— 那时它只表示「按住语音键走实时 ASR」。
 * 现在这一档整体升级成「语音优先」交互（一句一对话 + 窗口自动消失），语义是包含关系，
 * 所以老用户开过就迁移成打开，不用让他们再开一次。
 *
 * 自动消失分钟数：0 = 不消失；缺省 / 非法值一律回落到 5 分钟。
 */
function voiceFirstPrefs(
  state: LauncherState,
  legacyEnabled?: boolean,
): Pick<LauncherState, "voiceFirst" | "voiceFirstWindowMinutes"> {
  const minutes = state.voiceFirstWindowMinutes;
  return {
    voiceFirst: state.voiceFirst ?? legacyEnabled ?? false,
    voiceFirstWindowMinutes: typeof minutes === "number" && Number.isFinite(minutes) && minutes >= 0
      ? Math.round(minutes)
      : 5,
  };
}

/** 老版本持久化中的演示会话/桌面卡片字段整体剥离，不再进入新状态。
 *  通知开关也已下线（是否接收由系统决定），旧字段一并清掉，避免状态文件里留死配置。 */
function stripLegacy(raw: LauncherState & {
  sessions?: unknown;
  chatDrafts?: unknown;
  desktopCards?: unknown;
  notificationsEnabled?: unknown;
  notificationsOnlyWhenAway?: unknown;
  /** 老字段「实时转录」：已升级为 voiceFirst（迁移见 voiceFirstPrefs）。 */
  voiceRealtimeTranscription?: unknown;
}): LauncherState {
  const {
    sessions: _sessions,
    chatDrafts: _chatDrafts,
    desktopCards: _desktopCards,
    notificationsEnabled: _notificationsEnabled,
    notificationsOnlyWhenAway: _notificationsOnlyWhenAway,
    voiceRealtimeTranscription: _legacyVoiceRealtime,
    ...rest
  } = raw;
  return rest as LauncherState;
}

/**
 * 按 DOMAIN_IDS 白名单收敛数域：丢掉不在白名单里的数域（早期有 global / personal），
 * 连带清掉 Dock 上的固定项、遗留的 dockItems.domain 条目，并把指向已删数域的 activeDomainId 回落到第一个。
 * 幂等，每次 load 都跑，用户手改 state 文件也不会把已下线的数域带回来。
 */
function pruneDomains(state: LauncherState): LauncherState {
  const allowed = new Set<string>(DOMAIN_IDS);
  const domains = (state.domains ?? [])
    .filter((domain) => allowed.has(domain.id))
    .map((domain) => (DOMAIN_BORDERS[domain.id] ? { ...domain, composerBorder: DOMAIN_BORDERS[domain.id] } : domain));
  if (!domains.some((domain) => domain.id === "wechat")) {
    domains.push({ id: "wechat", name: "微信", color: "#666666", skinColor: "#666666", composerBorder: DOMAIN_BORDERS.wechat });
  }
  if (!domains.some((domain) => domain.id === "contacts")) {
    domains.push({ id: "contacts", name: "联系人", color: "#2a9d74", skinColor: "#2a9d74", composerBorder: DOMAIN_BORDERS.contacts });
  }
  if (!domains.some((domain) => domain.id === "knowledge")) {
    domains.push({ id: "knowledge", name: "知识库", color: "#8b5cf6", skinColor: "#8b5cf6", composerBorder: DOMAIN_BORDERS.knowledge });
  }
  const ids = new Set(domains.map((domain) => domain.id));
  const dockPins = state.dockPins
    ? { left: state.dockPins.left.filter((id) => ids.has(id) || id === "settings"), right: state.dockPins.right.filter((id) => ids.has(id) || id === "settings") }
    : state.dockPins;
  const dockItems = (state.dockItems ?? []).filter((item) => item.kind !== "domain" || !item.domainId || ids.has(item.domainId));
  const activeDomainId = ids.has(state.activeDomainId) ? state.activeDomainId : domains[0]?.id ?? "";
  // domains 用 map 重写过（会带上配置里的 composerBorder），所以按内容比较而不是长度比较，
  // 否则边框色变了还会被当成"没变化"而返回旧对象。
  const unchanged = JSON.stringify(domains) === JSON.stringify(state.domains ?? [])
    && dockItems.length === (state.dockItems ?? []).length
    && activeDomainId === state.activeDomainId
    && (!state.dockPins || (state.dockPins.left.length === dockPins!.left.length && state.dockPins.right.length === dockPins!.right.length));
  return unchanged ? state : { ...state, domains, dockItems, dockPins, activeDomainId };
}

export class LauncherStore {
  private file: string;
  private state: LauncherState;
  private static instance: LauncherStore | null = null;

  private constructor(file: string) {
    this.file = file;
    this.state = this.load();
  }

  static init(file: string): LauncherStore {
    if (!LauncherStore.instance) LauncherStore.instance = new LauncherStore(file);
    return LauncherStore.instance;
  }

  static get(): LauncherStore {
    if (!LauncherStore.instance) throw new Error("LauncherStore 未初始化");
    return LauncherStore.instance;
  }

  private load(): LauncherState {
    try {
      if (fs.existsSync(this.file)) {
        let raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as LauncherState & { sessions?: unknown; chatDrafts?: unknown; desktopCards?: unknown };
        if (raw && typeof raw === "object") {
          // 老「实时转录」开关要在 stripLegacy 之前取出来：它会把这个字段从对象里摘掉，
          // 紧接着由 voiceFirstPrefs 迁移到新字段上。
          const legacyVoiceRaw = (raw as { voiceRealtimeTranscription?: unknown }).voiceRealtimeTranscription;
          const legacyVoiceFirst = legacyVoiceRaw === true;
          // 先按数域白名单收敛：早期版本的 global / personal 及其 Dock 固定项在这里一次性清掉。
          const base = pruneDomains(stripLegacy(raw));
          // 旧状态迁移到 Launcher 自己管理的浅色 / 深色 / 静态 / 动态外观。
          if (typeof raw.version !== "number" || raw.version < 2) {
            const migrated: LauncherState = { ...base, ...notificationPrefs(base), ...dragonFirePref(base), ...dragonVisiblePref(base), ...keepAwakePref(base), ...voiceFirstPrefs(base, legacyVoiceFirst), version: 8, voicePreviewOnly: false, wallpaper: { kind: "builtin", value: "wallpapers/default" }, appearance: "light", customWallpaper: "wallpapers/wp1.jpg", fireParams: { intensity: 2, amplitude: 50 } };
            this.persist(migrated);
            return migrated;
          }
          const oldDefault = raw.wallpaper?.kind === "builtin" && (raw.wallpaper.value === "wallpapers/hello-grey.jpg" || (raw.version < 3 && raw.wallpaper.value === "wallpapers/wp1.jpg"));
          if (oldDefault || raw.version < 5 || !raw.appearance) {
            const wallpaper = oldDefault ? { kind: "builtin" as const, value: "wallpapers/default" } : raw.wallpaper ?? { kind: "builtin" as const, value: "wallpapers/default" };
            // 旧「自定义」拆分为静态 / 动态：熔火龙境归动态，其余静态壁纸归静态。
            // raw 来自持久化 JSON，旧值可能是 "custom"（不在新版 AppearanceMode 内），先当 string 判断。
            const rawAppearance = (raw as { appearance?: string }).appearance;
            const appearance: AppearanceMode = rawAppearance === "custom"
              ? (wallpaper.kind === "builtin" && ["wallpapers/wp4.jpg", "wallpapers/wp5.jpg", "wallpapers/wp6.jpg"].includes(wallpaper.value) ? "dynamic" : "static")
              : rawAppearance === "light" || rawAppearance === "dark" || rawAppearance === "static" || rawAppearance === "dynamic"
                ? rawAppearance
                : (wallpaper.kind === "builtin" && wallpaper.value === "wallpapers/default" ? "light" : "static");
            const cleaned: LauncherState = { ...base, ...notificationPrefs(base), ...dragonFirePref(base), ...dragonVisiblePref(base), ...keepAwakePref(base), ...voiceFirstPrefs(base, legacyVoiceFirst), version: 8, voicePreviewOnly: false, wallpaper, appearance, fireParams: { intensity: 2, amplitude: 50 }, customWallpaper: raw.customWallpaper ?? (wallpaper.kind === "builtin" ? wallpaper.value : "wallpapers/wp1.jpg") };
            this.persist(cleaned);
            return cleaned;
          }
          // 较新版本（>=5）的旧状态可能仍是「custom」：统一归到静态 / 动态（wp4 → 动态）。
          const rawAppearance = (base as { appearance?: string }).appearance;
          const appearance: AppearanceMode = rawAppearance === "light" || rawAppearance === "dark" || rawAppearance === "static" || rawAppearance === "dynamic"
            ? rawAppearance
            : (base.wallpaper.kind === "builtin" && ["wallpapers/wp4.jpg", "wallpapers/wp5.jpg", "wallpapers/wp6.jpg"].includes(base.wallpaper.value) ? "dynamic" : "static");
          // version < 7：火焰参数重置为新默认（强度 2 / 幅度 50），旧测试残留（如幅度 0）不再沿用。
          const resetFire = raw.version < 7;
          // 版本 < 8 是「默认预览不转写」的旧时代：把遗留的 voicePreviewOnly:true 一次性纠正为 false
          // （用户已明确要求真实转写）。版本已到 8 的用户保留其显式选择（含主动开启预览）。
          const previewOnly = raw.version < 8 ? false : (base.voicePreviewOnly ?? false);
          const normalized: LauncherState = { ...base, ...notificationPrefs(base), ...dragonFirePref(base), ...dragonVisiblePref(base), ...keepAwakePref(base), ...voiceFirstPrefs(base, legacyVoiceFirst), version: 8, appearance, showModel: base.showModel ?? false, showVoiceButton: base.showVoiceButton ?? true, rightCtrlVoice: base.rightCtrlVoice ?? true, voicePreviewOnly: previewOnly, fireParams: resetFire ? { intensity: 2, amplitude: 50 } : base.fireParams ?? { intensity: 2, amplitude: 50 } };
          // 数域被裁剪过（pruneDomains 返回了新对象，domains 引用变了）、外观被归一化、版本升级，
          // 或 voicePreviewOnly / 语音优先字段被迁移时落盘，避免下次启动重复计算。
          if (base.domains !== raw.domains
            || appearance !== rawAppearance
            || resetFire
            || previewOnly !== base.voicePreviewOnly
            || (legacyVoiceRaw !== undefined)
            || normalized.voiceFirst !== base.voiceFirst
            || normalized.voiceFirstWindowMinutes !== base.voiceFirstWindowMinutes
            // 老状态里没有这个字段：补上默认值后落盘，免得每次启动都要现算一遍。
            || normalized.keepAwakeOnTask !== base.keepAwakeOnTask) this.persist(normalized);
          return normalized;
        }
      }
    } catch (err) {
      console.error("[launcher] 读取持久化状态失败，回退到默认状态：", err);
    }
    const seed = defaultState();
    this.persist(seed);
    return seed;
  }

  private persist(state: LauncherState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[launcher] 写入持久化状态失败：", err);
    }
  }

  get(): LauncherState {
    return this.state;
  }

  replace(next: LauncherState): LauncherState {
    this.state = next;
    this.persist(next);
    return next;
  }
}
