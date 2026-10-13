import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 单仓好处（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.6②）：一份配置同时覆盖
    // 客户端（`src/`）、两侧共用的纯 TS（`shared/`）与服务端（`server/`）。
    // `shared/` 与 `server/` 都跑在 node 环境（前者是纯函数、后者本来就是 Node 服务）。
    include: ["src/**/*.test.ts", "src/clip-web/**/*.test.ts", "shared/**/*.test.ts", "server/**/*.test.ts"],
    reporters: ["default"],
  },
});
