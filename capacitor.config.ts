import type { CapacitorConfig } from "@capacitor/cli";

/**
 * 路线 B（Capacitor 打包）的壳配置。Web 产物由 `pnpm build:mobile` 生成到
 * `dist/`，`pnpm cap:sync` 拷进 `android/`。
 *
 * - `androidScheme: "https"`：WebView 从 `https://localhost` 服务页面（安全上下文，
 *   localStorage / OPFS / fetch 一切照旧）。
 * - iOS 侧按调研文档配置 Info.plist（UIFileSharingEnabled 等）后再启用 ios。
 */
const config: CapacitorConfig = {
  appId: "com.buglan.opennote",
  appName: "Opennote",
  webDir: "dist",
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: "https",
  },
};

export default config;
