import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFile } from "./parser.js";
import { chunkDocument, estimateTokens } from "./chunker.js";
import { assetThumbPath, fileThumbPath } from "./assets.js";

// Parsing can contain long synchronous library calls. Keep it in a separate
// process so the index scheduler can answer IPC and cancel a file promptly.
process.once("message", (message: { path: string; assetDir: string; thumbKey?: string; thumbnailDestination?: string; thumbnailKind?: "image" | "pdf"; streamXlsx?: boolean }) => {
  void (async () => {
    try {
      if (message.thumbnailDestination) {
        let result: string;
        if (message.thumbnailKind === "pdf") {
          const [pdfjs, worker, canvasMod, thumbs] = await Promise.all([
            import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
            import("@napi-rs/canvas"), import("./image-thumb.js"),
          ]);
          Object.assign(globalThis, { pdfjsWorker: worker });
          const document = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(message.path)), useSystemFonts: true, disableFontFace: true }).promise;
          try {
            const page = await document.getPage(1);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(1, 384 / Math.max(base.width, base.height)) });
            const canvas = canvasMod.createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
            const context = canvas.getContext("2d");
            context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: context as any, viewport }).promise;
            const data = thumbs.thumbnailFromCanvas(canvas);
            await fs.mkdir(path.dirname(message.thumbnailDestination), { recursive: true });
            const temp = `${message.thumbnailDestination}.${process.pid}.tmp`;
            try { await fs.writeFile(temp, data); await fs.rename(temp, message.thumbnailDestination); }
            finally { await fs.rm(temp, { force: true }); }
            result = message.thumbnailDestination;
          } finally { await document.destroy(); }
        } else {
          const { ensureThumbnail } = await import("./image-thumb.js");
          result = await ensureThumbnail(message.path, message.thumbnailDestination);
        }
        process.send?.({ thumbnail: result }, () => process.exit(0));
        return;
      }
      if (message.streamXlsx) {
        const { streamXlsx } = await import("./xlsx-stream.js");
        await streamXlsx(message.path, chunks => new Promise<void>((resolve, reject) => {
          const onReply = (reply: { ack?: boolean; error?: string }) => { if (reply.error) reject(new Error(reply.error)); else if (reply.ack) resolve(); else reject(new Error("索引进程回复无效")); };
          process.once("message", onReply);
          process.send?.({ batch: chunks }, error => { if (error) { process.removeListener("message", onReply); reject(error); } });
        }), () => { process.send?.({ progress: true }); });
        process.send?.({ done: true }, () => process.exit(0));
        return;
      }
      const parsed = await parseFile(message.path);
      const chunks = chunkDocument(parsed.text);
      await fs.mkdir(message.assetDir, { recursive: true });
      const libraryDir = path.dirname(message.assetDir);
      for (const image of parsed.images ?? []) {
        // 按内容哈希命名：同一张图在多个文档里只落一份
        const base = createHash("sha256").update(image.data).digest("hex");
        // JPEG/PNG originals are already directly usable by the model and UI.
        // Keep only the small thumbnail; never duplicate the full image on disk.
        const originalImage = parsed.type === "image" && /\.(?:jpe?g|png)$/i.test(message.path);
        const imagePath = originalImage ? message.path : path.join(message.assetDir, `${base}.${image.ext || "png"}`);
        if (!originalImage) await fs.writeFile(imagePath, image.data);
        if (image.thumb?.length) {
          // 独立图片：缩略图按「原文件 sha256」命名（图库不依赖索引产物即可预览）；
          // 文档里的插图没有原文件 sha，按图片副本哈希命名。两条路都只写一份缩略图。
          const thumbPath = parsed.type === "image" && message.thumbKey
            ? fileThumbPath(libraryDir, message.thumbKey)
            : assetThumbPath(imagePath);
          await fs.mkdir(path.dirname(thumbPath), { recursive: true });
          await fs.writeFile(thumbPath, image.thumb);
        }
        const ocr = image.ocr.trim();
        // 图片 chunk 只携带 OCR 原文和磁盘路径；indexer 会把它拆成
        // 「文字片段（先放 OCR，后换成大模型描述）」+「图片本体片段」两个片段。
        // 不要拿 location（文件名）冒充 OCR，否则空 OCR 会被当成图片文字存进索引。
        chunks.push({ text: ocr, headingPath: image.location, tokenCount: estimateTokens(ocr), imagePath });
      }
      process.send?.({ chunks, truncated: parsed.truncated }, () => process.exit(0));
    } catch (error) {
      process.send?.({ error: error instanceof Error ? error.message : String(error) }, () => process.exit(1));
    }
  })();
});
