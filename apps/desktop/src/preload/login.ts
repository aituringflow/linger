/**
 * 登录窗专用 preload。
 *
 * Web 端登录页里，浏览器（Chrome / Safari）会自己弹「是否保存密码」并在下次自动填充；
 * Electron 不带这套密码管理器，所以由这里把「上次登录账号」一个口子递给登录页：
 *   window.launcherLogin.getCredential() / saveCredential() / clearCredential()
 * 密码在主页用 safeStorage 加密后落盘（macOS = 系统钥匙串），这里只转发，不落明文。
 *
 * 只有 launcher:open-login 创建的窗口挂这个 preload，主进程再按 webContents 校验来源。
 */
import { contextBridge, ipcRenderer } from "electron";

export interface SavedLoginCredential {
  username: string;
  /** 只记住用户名时为 "" */
  password: string;
}

export interface LoginCredentialBridge {
  platform: NodeJS.Platform;
  getCredential: () => Promise<SavedLoginCredential | null>;
  saveCredential: (credential: SavedLoginCredential) => Promise<boolean>;
  clearCredential: () => Promise<boolean>;
}

const api: LoginCredentialBridge = {
  platform: process.platform,
  getCredential: () => ipcRenderer.invoke("launcher:login-credential-get") as Promise<SavedLoginCredential | null>,
  saveCredential: (credential) => ipcRenderer.invoke("launcher:login-credential-save", credential) as Promise<boolean>,
  clearCredential: () => ipcRenderer.invoke("launcher:login-credential-clear") as Promise<boolean>,
};

contextBridge.exposeInMainWorld("launcherLogin", api);
