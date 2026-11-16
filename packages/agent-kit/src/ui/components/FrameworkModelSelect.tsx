"use client";

import { useFrameworkModelDiscovery } from "./FrameworkModelDiscovery.tsx";
import ModelSelect, { type ModelOption } from "./ModelSelect.tsx";

/** Controlled framework and model picker. Each framework retains its own model value. */
export default function FrameworkModelSelect<T extends string>({
  frameworks, framework, onFrameworkChange, models, modelValues, onModelChange,
  hideFramework = false, hideModel = false, disabled = false, modelDisabled = false, iconOnNarrow = false,
  frameworkLabel = "选择框架", modelFirst = false, frameworkClassName, modelClassName,
}: {
  frameworks?: T[];
  framework: T;
  onFrameworkChange: (framework: T) => void;
  models?: Partial<Record<T, ModelOption[]>>;
  modelValues: Partial<Record<T, string>>;
  onModelChange: (framework: T, value: string) => void;
  hideFramework?: boolean;
  hideModel?: boolean;
  disabled?: boolean;
  modelDisabled?: boolean;
  iconOnNarrow?: boolean;
  frameworkLabel?: string;
  modelFirst?: boolean;
  frameworkClassName?: string;
  modelClassName?: string;
}) {
  const discovery = useFrameworkModelDiscovery();
  const availableFrameworks = frameworks ?? (discovery?.frameworks.filter(item => item.models.length > 0).map(item => item.id as T) ?? []);
  const names: Record<string, string> = { codebuddy: "CodeBuddy", codex: "Codex", dsh: "DeepSeek Harness" };
  const frameworkPicker = !hideFramework && availableFrameworks.length > 1 ? <ModelSelect showIcon={false} compact options={availableFrameworks.map(id => ({ id, name: names[id] ?? id, meta: { descriptionZh: id === "codebuddy" ? "使用 CodeBuddy 框架运行智能体。" : id === "codex" ? "使用 Codex 框架运行智能体。" : id === "dsh" ? "使用 DeepSeek Harness 运行智能体。" : (names[id] ?? id) } }))} value={framework} title={frameworkLabel} disabled={disabled} onChange={value => onFrameworkChange(value as T)} /> : null;
  const options = models?.[framework] ?? discovery?.frameworks.find(item => item.id === framework)?.models.map(item => ({ id: item.id, name: item.name, meta: { ...item.meta, supportsImages: item.supportsImages ?? item.meta?.supportsImages } })) ?? [];
  const modelPicker = !hideModel && options.length ? <ModelSelect disabled={disabled || modelDisabled} options={options} value={modelValues[framework] ?? ""} onChange={value => onModelChange(framework, value)} iconOnNarrow={iconOnNarrow} /> : null;
  const frameworkElement = frameworkPicker && frameworkClassName ? <div className={frameworkClassName}>{frameworkPicker}</div> : frameworkPicker;
  const modelElement = modelPicker && modelClassName ? <div className={modelClassName}>{modelPicker}</div> : modelPicker;
  return <>{modelFirst ? modelElement : frameworkElement}{modelFirst ? frameworkElement : modelElement}</>;
}
