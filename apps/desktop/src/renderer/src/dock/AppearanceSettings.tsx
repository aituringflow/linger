import type { AppearanceMode, FireParams, GoldParams, WaterParams } from "../../../shared/types";
import { useLauncher } from "../state";
import { useTranslation } from "../i18n";
import { WALLPAPER_SKINS, DYNAMIC_WALLPAPER_IDS } from "../wallpapers";

const DEFAULT_FIRE_PARAMS: FireParams = { intensity: 2, amplitude: 50 };

/** 快捷菜单和系统设置共享同一套外观控件与状态。 */
export default function AppearanceSettings() {
  const { state, dispatch } = useLauncher();
  const launcher = state.launcher!;
  const { t } = useTranslation();
  const modes: { id: AppearanceMode; label: string }[] = [
    { id: "light", label: t("appearance.light") },
    { id: "dark", label: t("appearance.dark") },
    { id: "static", label: t("appearance.static") },
    { id: "dynamic", label: t("appearance.animated") },
  ];
  // 静态与动态壁纸共用预览选择方式，参数区跟随当前动态皮肤。
  const staticSkins = WALLPAPER_SKINS.filter((w) => !DYNAMIC_WALLPAPER_IDS.has(w.id));
  const dynamicSkins = WALLPAPER_SKINS.filter((w) => DYNAMIC_WALLPAPER_IDS.has(w.id));
  const selectedDynamic = dynamicSkins.find(w => launcher.wallpaper.kind === "builtin" && launcher.wallpaper.value === w.url)?.id ?? "wp4";
  const fire = launcher.fireParams ?? DEFAULT_FIRE_PARAMS;
  const gold = launcher.goldParams ?? { speed: 1, sparkle: 1 };
  const water = launcher.waterParams ?? { intensity: 1, amplitude: .2, tint: "#4a9fca" };
  // 0→0，1→0.2，2→1：默认值保持不变，最大值覆盖原来的范围。
  const waterAmplitude = Math.max(0, Math.min(1, water.amplitude));
  const waterAmount = waterAmplitude <= .2 ? waterAmplitude / .2 : 1 + (waterAmplitude - .2) / .8;
  const setFire = (patch: Partial<FireParams>) => dispatch({ type: "SET_FIRE_PARAMS", fireParams: patch });
  const setGold = (patch: Partial<GoldParams>) => dispatch({ type: "SET_GOLD_PARAMS", goldParams: patch });
  const setWater = (patch: Partial<WaterParams>) => dispatch({ type: "SET_WATER_PARAMS", waterParams: patch });

  return (
    <section className="appearance-settings" aria-label={t("appearance.settings")}>
      <div className="appearance-section-head appearance-section-head--first">{t("settings.appearance")}</div>
      <div className="appearance-mode-list" role="group" aria-label={t("appearance.mode")}>
        {modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={launcher.appearance === mode.id ? "selected" : ""}
            aria-pressed={launcher.appearance === mode.id}
            onClick={() => dispatch({ type: "SET_APPEARANCE", appearance: mode.id })}
          >
            {mode.label}
          </button>
        ))}
      </div>
      {launcher.appearance === "static" ? (
        <div className="appearance-wallpapers" role="group" aria-label={t("appearance.staticWallpapers")}>
          <div className="appearance-wallpaper-grid">
            {staticSkins.map((wallpaper, index) => (
              <button
                key={wallpaper.id}
                type="button"
                className={launcher.wallpaper.kind === "builtin" && launcher.wallpaper.value === wallpaper.url ? "selected" : ""}
                aria-pressed={launcher.wallpaper.kind === "builtin" && launcher.wallpaper.value === wallpaper.url}
                onClick={() => dispatch({ type: "SET_WALLPAPER", wallpaper: { kind: "builtin", value: wallpaper.url } })}
                title={`Ctrl+${index + 3}`}
              >
                <span className="appearance-wallpaper-preview" style={{ backgroundImage: `url("${wallpaper.url}")` }} />
                <span>{t(`wallpaper.${wallpaper.id}`)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {launcher.appearance === "dynamic" ? (
        <div className="appearance-dynamic" role="group" aria-label={t("appearance.animatedWallpapers")}>
          <div className="appearance-wallpaper-grid appearance-dynamic-grid">
            {dynamicSkins.map((wallpaper, index) => <button key={wallpaper.id} type="button"
              className={selectedDynamic === wallpaper.id ? "selected" : ""}
              aria-pressed={selectedDynamic === wallpaper.id}
              onClick={() => dispatch({ type: "SET_WALLPAPER", wallpaper: { kind: "builtin", value: wallpaper.url } })}
              title={`Ctrl+${index + 6}`}>
              <span className="appearance-wallpaper-preview" style={{ backgroundImage: `url("${wallpaper.url}")` }} />
              <span>{t(`wallpaper.${wallpaper.id}`)}</span>
            </button>)}
          </div>
          <div className={`appearance-dynamic-sliders${selectedDynamic === "wp6" ? " appearance-dynamic-sliders--gold" : selectedDynamic === "wp5" ? " appearance-dynamic-sliders--water" : ""}`}>
            {selectedDynamic === "wp4" ? <>
              <label className="appearance-slider">
                <span>{t("appearance.intensity")} <em>{fire.intensity.toFixed(1)}</em></span>
                <input type="range" min="0.2" max="2.5" step="0.1" value={fire.intensity}
                  onChange={(e) => setFire({ intensity: Number(e.target.value) })} />
              </label>
              <label className="appearance-slider">
                <span>{t("appearance.amplitude")} <em>{fire.amplitude}%</em></span>
                <input type="range" min="0" max="100" step="5" value={fire.amplitude}
                  onChange={(e) => setFire({ amplitude: Number(e.target.value) })} />
              </label>
            </> : selectedDynamic === "wp6" ? <>
              <label className="appearance-slider"><span>{t("appearance.lightSpeed")} <em>{gold.speed.toFixed(1)}</em></span>
                <input type="range" min="0.2" max="2.5" step="0.1" value={gold.speed}
                  onChange={e => setGold({ speed: Number(e.target.value) })} /></label>
              <label className="appearance-slider"><span>{t("appearance.sparkle")} <em>{gold.sparkle.toFixed(1)}</em></span>
                <input type="range" min="0" max="2" step="0.1" value={gold.sparkle}
                  onChange={e => setGold({ sparkle: Number(e.target.value) })} /></label>
            </> : <>
              <label className="appearance-slider"><span>{t("appearance.flow")} <em>{water.intensity.toFixed(1)}</em></span>
                <input type="range" min="0.2" max="2.5" step="0.1" value={water.intensity}
                  onChange={e => setWater({ intensity: Number(e.target.value) })} /></label>
              <label className="appearance-slider"><span>{t("appearance.water")} <em>{waterAmount.toFixed(1)}</em></span>
                <input type="range" min="0" max="2" step="0.1" value={waterAmount}
                  onChange={e => { const amount = Number(e.target.value); setWater({ amplitude: amount <= 1 ? amount * .2 : .2 + (amount - 1) * .8 }); }} /></label>
            </>}
          </div>
        </div>
      ) : null}
    </section>
  );
}
