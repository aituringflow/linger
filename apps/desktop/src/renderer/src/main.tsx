import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
// agent-kit 样式先行，Launcher 的主题与窗口样式随后覆盖。
import "@turingflow/agent-kit/styles.css";
import "./styles.css";
import "./styles-launcher.css";
import { LauncherProvider } from "./state";
import { I18nProvider } from "./i18n";
import App from "./App";
import { FrameworkModelProvider, useFrameworkModelDiscovery } from "@turingflow/agent-kit/ui";

const discoverFrameworkModels = () => window.launcher.knowledge.listImageModels();
function RefreshFrameworkModels() {
  const discovery = useFrameworkModelDiscovery();
  useEffect(() => {
    const refresh = () => discovery?.refresh();
    window.addEventListener("launcher:dsh-models-changed", refresh);
    return () => window.removeEventListener("launcher:dsh-models-changed", refresh);
  }, [discovery?.refresh]);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LauncherProvider>
      <I18nProvider><FrameworkModelProvider discover={discoverFrameworkModels}><RefreshFrameworkModels /><App /></FrameworkModelProvider></I18nProvider>
    </LauncherProvider>
  </React.StrictMode>,
);
