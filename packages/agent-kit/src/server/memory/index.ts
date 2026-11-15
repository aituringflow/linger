/**
 * 记忆库的公共入口。
 *
 * 只导出这两样：三张表的读写器、向量化契约。
 * 不导出 SQL 与行映射——那是实现细节，换成 pgvector 或换存储时不该影响调用方。
 */
export * from "./store.js";
export * from "./embedding.js";
export * from "./ingest.js";
