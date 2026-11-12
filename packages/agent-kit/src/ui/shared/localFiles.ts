export type LocalReference = {
  id: string;
  name: string;
  path?: string;
  kind: "file" | "folder";
  size: number;
  url: string;
  available?: boolean;
  sourceFileId?: string;
};

export interface LocalFilesApi {
  register(files: File[]): Promise<LocalReference[]>;
  list(): Promise<LocalReference[]>;
  reveal(url: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  setWorkspace(sessionId: string, path: string | null): Promise<boolean>;
  workspaces(): Promise<Record<string, string>>;
  scan(id: string): Promise<{ count?: number; bytes?: number; oversized?: number; error?: string } | null>;
  upload(id: string): Promise<{ uploaded: number; failed: string[] }>;
  onUploadProgress(listener: (value: { id: string; current: number; total: number }) => void): () => void;
  cacheCloudFile(fileId: string, name: string): Promise<LocalReference | null>;
}

export function localFilesApi(): LocalFilesApi | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { agentHost?: { localFiles?: LocalFilesApi } }).agentHost?.localFiles ?? null;
}

export function isLocalReference(url: string | undefined): boolean {
  return Boolean(url && /^local-ref:\/\//i.test(url));
}
