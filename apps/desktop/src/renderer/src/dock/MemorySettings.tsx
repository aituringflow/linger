import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { useLauncher } from "../state";
import SettingsGroup from "./SettingsGroup";
import SettingsSelect from "./SettingsSelect";
import type { KnowledgeModelStatus, KnowledgeFrameworkModels, KnowledgeImageModel, KnowledgeImageModelChoice } from "../../../shared/types";

/** 纯文本检索要的那几个文件（graph + 权重 + 分词器）合计约 346MB。 */
const TEXT_MODEL_MB = 346;

/** System settings for memory retrieval and WeChat image analysis. */
export default function MemorySettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const enabled = state.launcher?.memoryEnabled ?? false;
  const [model, setModel] = useState<KnowledgeModelStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [imageModels, setImageModels] = useState<KnowledgeFrameworkModels[]>([]);
  const [customModels, setCustomModels] = useState<KnowledgeImageModelChoice[]>([]);
  const [loadingFrameworks, setLoadingFrameworks] = useState<Record<string, boolean>>({ codebuddy: true, codex: true });
  const [imageModel, setImageModel] = useState<KnowledgeImageModel | null>(null);
  const [activeFramework, setActiveFramework] = useState<KnowledgeImageModel["framework"]>("codebuddy");
  const [imageError, setImageError] = useState("");
  const [imageSaving, setImageSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void window.launcher.knowledge.getSettings().then(settings => {
      if (live) { setImageModel(settings.memoryImageModel ?? null); setActiveFramework(settings.memoryImageModel?.framework ?? "codebuddy"); }
    }).catch(error => { if (live) setImageError(String(error)); });
    void window.launcher.knowledge.listCustomMemoryModels().then(models => { if (live) setCustomModels(models); }).catch(error => { if (live) setImageError(String(error)); });
    for (const id of ["codebuddy", "codex"] as const) {
      void window.launcher.knowledge.listFrameworkModels(id).then(group => {
        if (live) setImageModels(current => [...current.filter(item => item.id !== id), group]);
      }).catch(error => {
        if (live) setImageModels(current => [...current.filter(item => item.id !== id), { id, name: id === "codebuddy" ? "WorkBuddy" : "Codex", models: [], error: String(error) }]);
      }).finally(() => { if (live) setLoadingFrameworks(current => ({ ...current, [id]: false })); });
    }
    return () => { live = false; };
  }, []);
  const saveImageModel = async (selected: KnowledgeImageModel | null) => {
    setImageSaving(true); setImageError("");
    try { const saved = await window.launcher.knowledge.saveSettings({ memoryImageModel: selected }); setImageModel(saved.memoryImageModel ?? null); }
    catch (error) { setImageError(String(error)); } finally { setImageSaving(false); }
  };
  const framework = imageModels.find(group => group.id === activeFramework);
  const frameworkOptions = [{ value: "codebuddy", label: "WorkBuddy" }, { value: "codex", label: "Codex" }];
  const availableModels = activeFramework === "codebuddy"
    ? [...customModels, ...(framework?.models ?? []).filter(item => !customModels.some(custom => custom.id === item.id)), ...state.models.filter(item => !customModels.some(custom => custom.id === item.id) && !(framework?.models ?? []).some(model => model.id === item.id)).map(item => ({ id: item.id, name: item.name, supportsImages: typeof item.meta?.supportsImages === "boolean" ? item.meta.supportsImages : undefined }))]
    : framework?.models ?? [];
  const modelOptions = availableModels.map(item => ({ value: item.id, label: `${item.name || item.id}${item.supportsImages === false ? ` · ${t("memory.imageUnsupported")}` : ""}`, disabled: false }));
  if (!imageModel && activeFramework === "codebuddy" && !modelOptions.some(item => item.value === "hy3")) modelOptions.push({ value: "hy3", label: "hy3", disabled: false });
  if (imageModel?.framework === activeFramework && !modelOptions.some(item => item.value === imageModel.model)) modelOptions.push({ value: imageModel.model, label: imageModel.model, disabled: false });

  useEffect(() => {
    let alive = true;
    void window.launcher.knowledge.getModelStatus()
      .then((status) => { if (alive) setModel(status); })
      .catch(() => { /* 知识库进程未就绪时按未知处理，不拦用户 */ })
      .finally(() => { if (alive) setChecking(false); });
    return () => { alive = false; };
  }, []);

  // 下载进度由知识库 worker 主动推（同一个事件，知识库窗口也在用）。
  useEffect(() => window.launcher.knowledge.onModelStatus((status) => setModel(status)), []);

  const startDownload = useCallback(async () => {
    try { setModel(await window.launcher.knowledge.downloadModel()); }
    catch { /* 进度与失败原因由 onModelStatus 事件补上 */ }
  }, []);

  const toggle = () => {
    const next = !enabled;
    dispatch({ type: "SET_MEMORY_ENABLED", enabled: next });
    // 打开时确保模型：已就绪是空操作，没下载则在后台开始下。
    if (next) void startDownload();
  };

  const ready = model?.phase === "done";
  const downloading = model?.phase === "downloading";
  const failed = model?.phase === "error";

  const modelStatusText = () => {
    if (checking && !model) return t("memory.modelChecking");
    if (ready) return t("memory.modelReady");
    if (downloading) {
      const percent = Math.round(model?.percent ?? 0);
      return t("memory.modelDownloading").replace("{percent}", String(percent));
    }
    if (failed) return `${t("memory.modelFailed")}${model?.error ? `：${model.error}` : ""}`;
    return t("memory.modelMissing").replace("{size}", String(TEXT_MODEL_MB));
  };

  // 只有「没下、没在下、也没坏」时，才是个可以点下载的状态。
  const canDownload = !checking && !ready && !downloading;

  return (
    <>
      <SettingsGroup title={t("memory.group")}>
        <div className="appearance-setting-row">
          <span>{t("memory.enable")}</span>
          <button
            type="button"
            role="switch"
            className="appearance-switch"
            aria-label={t("memory.enable")}
            aria-checked={enabled}
            onClick={toggle}
          >
            <span aria-hidden="true" />
          </button>
        </div>
        <div className="memory-hint">{t("memory.enableHint")}</div>
        <div className="memory-model-row">
          <span className="memory-model-label">{t("memory.model")} · EmbeddingGemma 2</span>
          <span className={ready ? "memory-model-state is-ready" : "memory-model-state"}>{modelStatusText()}</span>
          {canDownload ? (
            <button type="button" className="appearance-action-button" onClick={() => void startDownload()}>
              {failed ? t("memory.retryDownload") : t("memory.download")}
            </button>
          ) : null}
        </div>
        {enabled && !ready ? <div className="memory-hint">{t("memory.notReadyHint")}</div> : null}
      </SettingsGroup>
      <SettingsGroup title={t("memory.imageModelTitle")}>
        <div className="memory-hint">{t("memory.imageModelHint")}</div>
        <div className="memory-select-grid">
          <SettingsSelect label={t("memory.imageFramework")} value={activeFramework} options={frameworkOptions} disabled={imageSaving} onChange={value => {
            if (value === "codebuddy" || value === "codex") setActiveFramework(value);
          }} />
          <SettingsSelect label={t("memory.imageModelLabel")} value={imageModel?.framework === activeFramework ? imageModel.model : !imageModel && activeFramework === "codebuddy" ? "hy3" : ""} placeholder={t("memory.selectModel")} options={modelOptions} disabled={imageSaving || (loadingFrameworks[activeFramework] && availableModels.length === 0) || modelOptions.length === 0} onChange={value => void saveImageModel({ framework: activeFramework, model: value })} />
        </div>
        {loadingFrameworks[activeFramework] ? <div className="memory-hint">{t("memory.modelsLoading")}</div> : null}
        {framework?.error ? <div role="alert" className="memory-hint">{framework.error === "workbuddy_models_unavailable" ? t("memory.workbuddyModelsUnavailable") : framework.error}</div> : null}
        {(imageModel?.framework ?? "codebuddy") !== activeFramework ? <div className="memory-hint">{t("memory.selectModelToApply")}</div> : null}
        {imageError ? <div role="alert" className="memory-hint">{imageError}</div> : null}
      </SettingsGroup>
    </>
  );
}
