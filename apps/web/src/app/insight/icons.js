// DataInsight 页面用到的图标：内联 SVG，不引入 lucide-react 依赖。
// 图形按原页面（lucide 图标集）的语义重绘，尺寸/描边用法保持一致。
// 原页面使用 <Icon size={n} strokeWidth={x} /> / <Icon fill="currentColor" />，
// 这里保持同样的调用签名。

function Svg({ size = 24, strokeWidth = 1.5, className, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function ArrowRight(props) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </Svg>
  );
}

export function CircleDot(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function Compass(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="10" />
      <path d="m16.24 7.76-3.54 8.48-8.48 3.54 3.54-8.48z" />
    </Svg>
  );
}

export function ScanSearch(props) {
  return (
    <Svg {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <circle cx="11" cy="11" r="4" />
      <path d="m14 14 3 3" />
    </Svg>
  );
}

export function Waves(props) {
  return (
    <Svg {...props}>
      <path d="M2 6c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" />
      <path d="M2 12c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" />
      <path d="M2 18c1.5-1.2 3-1.2 4.5 0s3 1.2 4.5 0 3-1.2 4.5 0 3 1.2 4.5 0" />
    </Svg>
  );
}

export function BellRing(props) {
  return (
    <Svg {...props}>
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <path d="M2 8h2M20 8h2M4.5 4.5 6 6M19.5 4.5 18 6" />
    </Svg>
  );
}

export function GitBranch(props) {
  return (
    <Svg {...props}>
      <path d="M6 3v12" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Svg>
  );
}

export function Pause(props) {
  return (
    <Svg {...props}>
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </Svg>
  );
}

export function Play(props) {
  return (
    <Svg {...props}>
      <path d="M9 4.5 20 12 9 19.5z" />
    </Svg>
  );
}

export function RotateCcw(props) {
  return (
    <Svg {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </Svg>
  );
}
