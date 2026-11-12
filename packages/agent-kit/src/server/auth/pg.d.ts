/**
 * 本地最小化 pg 类型声明。
 *
 * 目的：避免依赖 @types/pg（在部分安装环境下 tarball 下载不稳定，频繁 502）。
 * 仅声明 agent-kit 实际使用的 API（连接池 / 查询 / 释放）；运行时由真实的 pg 包提供实现。
 * 若后续环境稳定并安装 @types/pg，可删除本文件。
 */
declare module "pg" {
  export interface PoolConfig {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    // pg 8.8+ 运行时真实支持：客户端侧 query_timeout + 服务端侧 statement_timeout，
    // 用于代理链路卡死时兜底（查询在服务端瞬间完成但返回路径断掉，无超时则吃满连接池）。
    query_timeout?: number;
    statement_timeout?: number;
  }

  export interface QueryResult<R extends Record<string, unknown> = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
    fields: Array<{ name: string; [key: string]: unknown }>;
    command: string;
  }

  export interface PoolClient {
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    release(): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    // 真实 pg.Pool 继承 EventEmitter：空闲连接错误必须监听，否则会作为未处理的 'error' 事件崩溃进程。
    on(event: "error", listener: (err: Error) => void): this;
  }

  export class Client {
    constructor(config?: PoolConfig);
    query<R extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>>;
    connect(): Promise<void>;
    end(): Promise<void>;
  }
}
