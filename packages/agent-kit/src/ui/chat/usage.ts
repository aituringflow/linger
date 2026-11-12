/** 紧凑 token 格式化：12345 → 12.3k；≥1000 用 k/m 缩写 */
export function compactTokens(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** 由本轮 usage 估算「当前上下文已用 token」。
 *  关键纠偏：网关（CodeBuddy API）口径下 input_tokens 已含 cache_read/cache_creation（三者相等，
 *  CLI 默认把 cache_* 置 0 之外，网关回传时会填真实值且等于 input_tokens）。
 *  因此绝不能再把 cache_* 与 input 相加——否则同一段缓存被重复计数（input 已含缓存却又加一遍 → 2~3 倍），
 *  正是“1-2 轮对话就显示 100%”的元凶。
 *  口径：以 input_tokens 为唯一基准；仅当 input 为 0 但仍上报了缓存命中时，才回退用 cache 之和。 */
export function contextUsedTokens(usage?: Record<string, number> | null): number {
  if (!usage || typeof usage !== "object") return 0;
  const input = Number(usage.input_tokens ?? 0);
  if (input > 0) return input; // input 已含缓存，直接用它，杜绝重复计数
  const cache =
    Number(usage.cache_read_input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0);
  return cache;
}

