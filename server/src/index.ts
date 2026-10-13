/**
 * 进程入口（`docs/执行-三端同步…` §2.4、§4.6、§4.8）。
 *
 * `createApp()` 只负责装配、**不监听端口**（那样用例就没法直接打）。
 * 这里做真正的启动：读环境变量 → 开库 → 装配 → 监听 → 装信号处理。
 *
 * ## 启动时**必须**做的两件事
 *
 * 1. **`loadConfig()` 失败就立刻退出**，而且把缺了哪些键**逐条打出来**。
 *    配错的后果不是「启动慢一点」，而是「跑起来之后每条请求都 500」——
 *    那时候要花很久才找到根因。
 * 2. **打印实际监听地址与协议版本**。运维需要一个可以复制到浏览器里的 URL，
 *    而「跑起来了但绑到了哪里」是自托管部署最常见的困惑。
 */

import { serve } from "@hono/node-server";
import { loadConfig, describeConfig, ConfigError } from "./config";
import { openDatabase } from "./db";
import { createApp } from "./app";

export interface StartedServer {
  port: number;
  /** 关掉监听（测试 / 优雅退出用）。 */
  close: () => Promise<void>;
  db: ReturnType<typeof openDatabase>;
}

/**
 * 启动服务并把「已经起来了」交回来。
 *
 * 拆出这个函数（而不是全写在模块顶层）是为了让**测试能起真端口** ——
 * U18/U22 那两条待核实项需要真栈，而真栈的第一步就是「能按配置起一个实例」。
 */
export function startServer(options: { env?: Record<string, string | undefined>; port?: number } = {}): Promise<StartedServer> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const config = loadConfig(env);
  const db = openDatabase({
    path: config.sqlitePath,
    onMigration: (migration, applied) => {
      if (applied) console.log(`[opennote-server] 已应用迁移 ${migration.version}：${migration.description}`);
    },
  });

  const startedAt = Date.now();
  const { app } = createApp({ config, db, startedAt });

  console.log(`[opennote-server] ${describeConfig(config)}`);
  console.log(`[opennote-server] 协议版本 ${config.protocolVersionExpected}`);

  return new Promise<StartedServer>((resolve, reject) => {
    const server = serve(
      { fetch: app.fetch, port: options.port ?? config.port, hostname: "0.0.0.0" },
      (info: { port: number }) => {
        /*
         * 打印**外部** URL 而不是 `0.0.0.0`：运维需要一个能直接粘进浏览器的地址。
         * `0.0.0.0` 在浏览器里是无效的（会被当成"找不到"）。
         */
        console.log(`[opennote-server] 监听 0.0.0.0:${info.port}`);
        console.log(`[opennote-server] 外部地址 ${config.externalBaseUrl}`);
        console.log(`[opennote-server] 健康检查 ${config.externalBaseUrl}/v1/health`);
        resolve({
          port: info.port,
          db,
          close: () =>
            new Promise<void>((done, fail) => {
              server.close((error?: Error | null) => {
                try {
                  db.close();
                } catch {
                  // 已经关了：忽略。
                }
                if (error) fail(error);
                else done();
              });
            }),
        });
      },
    );
    server.on("error", reject);
  });
}

/**
 * 模块被**直接执行**时启动（`node dist/index.js` / `tsx server/src/index.ts`）。
 *
 * ⚠️ 必须判「是不是主模块」：否则 `import { startServer }` 会**顺手把服务起起来**，
 * 那会让测试莫名其妙地占端口（而且报错信息完全指不到原因）。
 */
const isMain = (() => {
  const entry = process.argv[1] ?? "";
  return /index\.(ts|js|mjs|cjs)$/.test(entry) && entry.includes("server");
})();

if (isMain) {
  startServer()
    .then((started) => {
      const shutdown = (signal: string): void => {
        console.log(`[opennote-server] 收到 ${signal}，正在关闭…`);
        void started.close().then(
          () => process.exit(0),
          (error) => {
            console.error("[opennote-server] 关闭时出错", error);
            process.exit(1);
          },
        );
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    })
    .catch((error: unknown) => {
      if (error instanceof ConfigError) {
        // 配置错误**逐条**打出来 —— 这是最值得多打几行的地方。
        console.error("[opennote-server] 配置有问题，未启动：");
        for (const problem of error.problems) console.error(`  · ${problem}`);
        console.error("[opennote-server] 参考 .env.example / docker-compose.yml");
        process.exit(2);
      }
      console.error("[opennote-server] 启动失败", error);
      process.exit(1);
    });
}
