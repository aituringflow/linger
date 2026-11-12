import React from "react";
import { createRoot } from "react-dom/client";
// agent-kit 样式先行，Launcher 的主题与窗口样式随后覆盖。
import "@turingflow/agent-kit/styles.css";
import "./styles.css";
import "./styles-launcher.css";
import { LauncherProvider } from "./state";
import { I18nProvider } from "./i18n";
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LauncherProvider>
      <I18nProvider><App /></I18nProvider>
    </LauncherProvider>
  </React.StrictMode>,
);
