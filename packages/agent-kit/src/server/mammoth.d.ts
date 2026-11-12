// mammoth 无自带 TS 类型：这里声明转换所需的最小子集（docx → HTML 内嵌预览；前端浏览器版用 arrayBuffer 输入）
declare module "mammoth" {
  export interface MammothResult {
    value: string;
    messages: unknown[];
  }
  export function convertToHtml(
    input: { buffer: Buffer } | { path: string } | { arrayBuffer: ArrayBuffer },
  ): Promise<MammothResult>;
  export function extractRawText(
    input: { buffer: Buffer } | { path: string } | { arrayBuffer: ArrayBuffer },
  ): Promise<MammothResult>;
  const _default: {
    convertToHtml: typeof convertToHtml;
    extractRawText: typeof extractRawText;
  };
  export default _default;
}
