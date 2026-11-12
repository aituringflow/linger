/** Parse a single HTTP byte range for media seeking; unsupported range syntax falls back to a full response. */
export function byteRange(bytes: Buffer, header: string | null | undefined): { start: number; end: number; body: Buffer } | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return null;
  const size = bytes.length;
  const first = match[1];
  const last = match[2];
  if (!size || (!first && !last)) return "unsatisfiable";
  const start = first ? Number(first) : Math.max(0, size - Number(last));
  const end = first && last ? Math.min(size - 1, Number(last)) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return "unsatisfiable";
  return { start, end, body: bytes.subarray(start, end + 1) };
}
