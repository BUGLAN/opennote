# 服务端镜像（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §7.3、§8.1）。
#
# ★ 构建上下文是**仓库根**（不是 `server/`）：同仓构建 —— 一次构建同时拿到
#   `shared/`（协议契约）与服务端代码，于是产物与 API **天然同版本**（§5.6）。
#   这也正是单仓相对 v7 双仓的主要收益之一。

# ============================================================ 构建阶段
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 只先拷清单：依赖没变时这一层能命中缓存（改一行源码不该重装依赖）。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# `--ignore-scripts`：**不跑** postinstall（客户端那套 electron-builder / 原生模块
# 在服务端镜像里毫无用处，还可能因为缺系统库而失败）。
RUN corepack enable && pnpm install --frozen-lockfile --ignore-scripts

# 拷源码（`server/` + `shared/` + 构建脚本就够了；客户端那半边不进镜像）。
COPY shared ./shared
COPY server ./server
COPY scripts/build-server.mjs ./scripts/build-server.mjs

RUN node scripts/build-server.mjs

# ============================================================ 运行阶段
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# 不装 curl/wget 之外的任何东西；`curl` 是 HEALTHCHECK 要用的。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# SQLite 控制面库落在挂载卷里（compose 会挂 `/app/data`）。
ENV SQLITE_PATH=/app/data/control.db
# ★ 不要把 `node_modules` 拷进来：产物是**自洽的**（`scripts/build-server.mjs` 把依赖
#   打进了 bundle）。镜像因此小很多，也少一大片供应链面。
COPY --from=build /app/server/dist ./dist

# ★ 非 root 运行（§7.3 Node 第 6 条）。node 镜像自带 uid 1000 的 `node` 用户。
# 数据目录要在切换用户**之前**建好并 chown，否则非 root 用户写不进去。
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8787
# 健康检查打的是**公开**端点（不需要令牌），所以它不需要任何凭据。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8787}/v1/health" || exit 1

# ★ 延迟导入：`index.ts` 里有「是不是主模块」的判断，所以 `node dist/cli.js` 与
#   `node dist/index.js` 各自只做各自的事（不会一 import 就把服务起起来）。
CMD ["node", "dist/index.js"]
