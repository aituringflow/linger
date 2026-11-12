/** Extract selectable PDF text once on the server so every chat runtime can read it. */
import { createRequire } from "node:module";

const loadNativeModule = createRequire(import.meta.url);

export async function extractPdfText(
  bytes: Uint8Array,
  limits: { maxPages?: number; maxCharacters?: number } = {},
): Promise<{ text: string; pages: number; characters: number; truncated: boolean; sparsePages: number[] }> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  // Supply the worker module explicitly: Next.js can bundle pdf.mjs without
  // preserving the relative pdf.worker.mjs path used by PDF.js in Node.
  Object.assign(globalThis, { pdfjsWorker: worker });
  const { getDocument } = pdfjs;
  const document = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const maxPages = limits.maxPages ?? 100;
  const maxCharacters = limits.maxCharacters ?? 500_000;
  const sections: string[] = [];
  const sparsePages: number[] = [];
  let length = 0;
  let characters = 0;
  let truncated = false;
  try {
    for (let pageNo = 1; pageNo <= document.numPages; pageNo++) {
      if (pageNo > maxPages || length >= maxCharacters) { truncated = true; break; }
      const page = await document.getPage(pageNo);
      const content = await page.getTextContent();
      const body = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("")
        .replace(/\u0000/g, "").trim();
      characters += body.length;
      if (body.length < 80) sparsePages.push(pageNo);
      const section = `=== 第 ${pageNo} 页 ===\n${body || "（没有可提取文字）"}`;
      const remaining = maxCharacters - length;
      sections.push(section.slice(0, remaining));
      length += Math.min(section.length, remaining);
      if (section.length > remaining) truncated = true;
    }
    return { text: sections.join("\n\n"), pages: document.numPages, characters, truncated, sparsePages };
  } finally {
    await document.destroy();
  }
}

/** Visual fallback for scanned or design-heavy PDFs with no selectable text. */
export async function renderPdfPageImages(
  bytes: Uint8Array,
  maxPages = 24,
): Promise<{ images: Array<{ base64: string; media_type: "image/png" }>; pages: number }> {
  const [pdfjs, worker] = await Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]);
  // Keep the optional native addon outside Next's module graph.
  const canvasModule = loadNativeModule(["@napi-rs", "canvas"].join("/")) as typeof import("@napi-rs/canvas");
  Object.assign(globalThis, { pdfjsWorker: worker });
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true, disableFontFace: true }).promise;
  const images: Array<{ base64: string; media_type: "image/png" }> = [];
  try {
    for (let pageNo = 1; pageNo <= Math.min(document.numPages, maxPages); pageNo++) {
      const page = await document.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 1000 / base.width) });
      const canvas = canvasModule.createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext("2d") as unknown as Parameters<typeof page.render>[0]["canvasContext"], viewport }).promise;
      images.push({ base64: canvas.toBuffer("image/png").toString("base64"), media_type: "image/png" });
      page.cleanup();
    }
    return { images, pages: document.numPages };
  } finally {
    await document.destroy();
  }
}
