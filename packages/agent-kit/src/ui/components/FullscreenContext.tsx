"use client";

import { createContext, useContext } from "react";

export type AppFullscreen = {
  isFullscreen: boolean;
  setFullscreen: (enabled: boolean) => void;
};

export const FullscreenContext = createContext<AppFullscreen>({
  isFullscreen: false,
  setFullscreen: () => {},
});

/** Let an application rendered in AgentChat occupy the entire content area. */
export function useAppFullscreen(): AppFullscreen {
  return useContext(FullscreenContext);
}
