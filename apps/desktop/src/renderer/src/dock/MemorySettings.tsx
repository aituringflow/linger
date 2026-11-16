import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";
import { useLauncher } from "../state";
import SettingsGroup from "./SettingsGroup";
import { FrameworkModelSelect, modelOptionKey, useFrameworkModelDiscovery } from "@turingflow/agent-kit/ui";
import type { KnowledgeModelStatus, KnowledgeImageModel, KnowledgeImageModelChoice } from "../../../shared/types";

/** 纯文本检索要的那几个文件（graph + 权重 + 分词器）合计约 346MB。 */
const TEXT_MODEL_MB = 346;

/** System settings for memory retrieval and WeChat image analysis. */
export default function MemorySettings() {
  const { t } = useTranslation();
  const { state, dispatch } = useLauncher();
  const enabled = state.launcher?.memoryEnabled ?? false;
  const [model, setModel] = useState<KnowledgeModelStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const discovery = useFrameworkModelDiscovery();
  const [imageModel, setImageModel] = useState<KnowledgeImageModel | null>(null);
  const [activeFramework, setActiveFramework] = useState<KnowledgeImageModel["framework"]>("codebuddy");
  const [imageError, setImageError] = useState("");
  const [imageSaving, setImageSaving] = useState(false);
  useEffect(() => {
    let live = true;
    void window.launcher.knowledge.getSettings().then(settings => {
      if (live) { setImageModel(settings.memoryImageModel ?? null); setActiveFramework(settings.memoryImageModel?.framework ?? "codebuddy"); }
    }).catch(error => { if (live) setImageError(String(error)); });
    return () => { live = false; };
  }, []);
  const saveImageModel = async (selected: KnowledgeImageModel | null) => {
    setImageSaving(true); setImageError("");
    try { const saved = await window.launcher.knowledge.saveSettings({ memoryImageModel: selected }); setImageModel(saved.memoryImageModel ?? null); }
    catch (error) { setImageError(String(error)); } finally { setImageSaving(false); }
  };
  const framework = discovery?.frameworks.find(group => group.id === activeFramework);
  const availableModels: KnowledgeImageModelChoice[] = activeFramework === "codebuddy"
    ? [...(framework?.models ?? []), ...state.models.filter(item => !(framework?.models ?? []).some(model => model.id === item.id)).map(item => ({ id: item.id, name: item.name, meta: item.meta, supportsImages: typeof item.meta?.supportsImages === "boolean" ? item.meta.supportsImages : undefined }))]
    : framework?.models ?? [];
  const modelOptions = availableModels.map(item => ({ id: item.id, name: `${item.name || item.id}${item.supportsImages === false ? ` · ${t("memory.imageUnsupported")}` : ""}`, meta: { ...item.meta, supportsImages: item.supportsImages } }));
  if (!imageModel && activeFramework === "codebuddy" && !modelOptions.some(item => item.id === "hy3")) modelOptions.push({ id: "hy3", name: "hy3", meta: { supportsImages: undefined } });
  if (imageModel?.framework === activeFramework && !modelOptions.some(item => item.id === imageModel.model)) modelOptions.push({ id: imageModel.model, name: imageModel.model, meta: { supportsImages: undefined } });

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
          <FrameworkModelSelect framework={activeFramework} onFrameworkChange={setActiveFramework} frameworkLabel={t("memory.imageFramework")} models={{ [activeFramework]: modelOptions }} modelValues={{ [activeFramework]: imageModel?.framework === activeFramework ? imageModel.model : !imageModel && activeFramework === "codebuddy" ? "hy3" : "" }} disabled={imageSaving} modelDisabled={discovery?.loading && availableModels.length === 0} onModelChange={(framework, value) => void saveImageModel({ framework, model: modelOptions.find(option => modelOptionKey(option) === value)?.id ?? value })} />
        </div>
        {discovery?.loading ? <div className="memory-hint">{t("memory.modelsLoading")}</div> : null}
        {framework?.error ? <div role="alert" className="memory-hint">{framework.error === "workbuddy_models_unavailable" ? t("memory.workbuddyModelsUnavailable") : framework.error}</div> : null}
        {(imageModel?.framework ?? "codebuddy") !== activeFramework ? <div className="memory-hint">{t("memory.selectModelToApply")}</div> : null}
        {activeFramework === "dsh" ? <div className="memory-hint">DeepSeek Harness 暂不支持无工具的群消息记忆提取。</div> : null}
        {imageError || discovery?.error ? <div role="alert" className="memory-hint">{imageError || discovery?.error}</div> : null}
      </SettingsGroup>
    </>
  );
}
