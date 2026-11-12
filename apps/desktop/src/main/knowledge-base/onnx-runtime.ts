import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

type OrtModule = typeof import("onnxruntime-node");
type RuntimeFile = { name: string; sha256: string };

// These checksums are for the immutable onnxruntime-node 1.30.0 npm release.
// Keep the version and checksums in sync with apps/desktop/package.json.
const VERSION = "1.30.0";
const FILES: Record<string, RuntimeFile[]> = {
  "darwin-arm64": [
    { name: "onnxruntime_binding.node", sha256: "a3f993357759b06ae2411f70af60f5e041d04521ea7f0d12cb7546e411a527dd" },
    { name: "libonnxruntime.1.dylib", sha256: "685d2be5dba1309c89d3a5324b7fd06a5c42f1a61bfea32d14c4cc28d072121d" },
  ],
  "win32-x64": [
    { name: "onnxruntime_binding.node", sha256: "ddd428464069b84414d34ec1796c7c2a69c33a976e4b0390692629e394f92fa1" },
    { name: "onnxruntime.dll", sha256: "508c362f5673483dd3a086379c392795b2e42d10d5e6f3f90ebd7ac21c97af67" },
    { name: "DirectML.dll", sha256: "234e8898778cdec88d3cb0539508273494082812c968699f3de665a018971625" },
    { name: "dxcompiler.dll", sha256: "593d42df78c7f9cbd97c1374af107cfe20985759f98b77afc1448fe41ee3cc76" },
    { name: "dxil.dll", sha256: "cf9a3981263f8ec30c9905d136eeaf4b4573209c602198671b958ec86905dea8" },
  ],
};

async function checksum(file: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  } catch { return null; }
}

async function download(url: string, destination: string, expected: string): Promise<void> {
  const tmp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const get = (address: string, redirects = 0): Promise<void> => new Promise((resolve, reject) => {
    if (redirects > 5 || !address.startsWith("https://")) { reject(new Error("Invalid runtime download redirect")); return; }
    const request = https.get(address, { timeout: 30_000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        void get(new URL(response.headers.location, address).href, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Runtime download failed: HTTP ${response.statusCode}`)); return; }
      const hash = createHash("sha256");
      const counter = new Transform({ transform(chunk: Buffer, _encoding, done) { hash.update(chunk); done(null, chunk); } });
      void pipeline(response, counter, fs.createWriteStream(tmp, { flags: "wx" })).then(async () => {
        if (hash.digest("hex") !== expected) throw new Error("ONNX Runtime SHA-256 verification failed");
        await fsp.rename(tmp, destination);
      }).then(resolve, reject);
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("Runtime download timed out")));
  });
  try { await get(url); } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

/** Load the packaged JS wrapper against a verified, on-demand native runtime. */
export async function loadOnnxRuntime(userDataDir: string): Promise<OrtModule> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("onnxruntime-node");
  const bindingFile = path.join(path.dirname(entry), "binding.js");
  const relativeBinding = `../bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node`;
  const bundledBinding = path.resolve(path.dirname(bindingFile), relativeBinding);
  if (fs.existsSync(bundledBinding)) return require("onnxruntime-node") as OrtModule;

  const platform = `${process.platform}-${process.arch}`;
  const files = FILES[platform];
  if (!files) throw new Error(`ONNX Runtime is not available for ${platform}`);
  const dir = path.join(userDataDir, "runtimes", `onnxruntime-node-${VERSION}`, platform);
  await fsp.mkdir(dir, { recursive: true });
  for (const file of files) {
    const dest = path.join(dir, file.name);
    if (await checksum(dest) === file.sha256) continue;
    const url = `https://unpkg.com/onnxruntime-node@${VERSION}/bin/napi-v6/${process.platform}/${process.arch}/${file.name}`;
    await download(url, dest, file.sha256);
  }

  // The upstream wrapper hardcodes its native binding path. Redirect only that
  // synchronous require, then restore Node's loader before returning. Other
  // imports (including Transformers) reuse the normal cached package instance.
  const Module = require("node:module") as typeof import("node:module") & { _load: (...args: any[]) => any };
  const originalLoad = Module._load;
  Module._load = function(request: string, parent: NodeModule | undefined, isMain: boolean) {
    if (request === relativeBinding && parent?.filename === bindingFile) {
      return originalLoad.call(this, path.join(dir, "onnxruntime_binding.node"), parent, isMain);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require("onnxruntime-node") as OrtModule; }
  finally { Module._load = originalLoad; }
}
