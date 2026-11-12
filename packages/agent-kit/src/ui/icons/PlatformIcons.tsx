// 平台图标（内联 SVG，避免引入外部资源）
import type { SVGProps } from "react";

export function WindowsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden {...props}>
      <path d="M3 5.4 10.6 4.6v7.4H3zM11.4 4.5 21 3.4v8.6h-9.6zM3 12.9h7.6V20.4L3 19.6zM11.4 12.9H21V21l-9.6-1.1z" />
    </svg>
  );
}

export function AppleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden {...props}>
      <path d="M16.36 12.78c-.02-2.2 1.8-3.26 1.88-3.31-1.02-1.5-2.62-1.7-3.18-1.72-1.35-.14-2.64.8-3.32.8-.68 0-1.74-.78-2.86-.76-1.47.02-2.82.85-3.58 2.16-1.52 2.65-.39 6.57 1.1 8.72.73 1.05 1.59 2.23 2.73 2.19 1.1-.04 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.83-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.2 6.1c.6-.73 1.01-1.74.9-2.75-.87.04-1.93.58-2.56 1.31-.56.65-1.05 1.69-.92 2.68.97.08 1.96-.49 2.58-1.24z" />
    </svg>
  );
}

export const PLATFORM_ICONS = {
  win32: WindowsIcon,
  darwin: AppleIcon,
};

