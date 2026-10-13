/**
 * 账号密钥的**本机保管**（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.9「密钥在本地的存放」、§5.2）。
 *
 * ## 三个宿主，三种存法 —— 而它们的**安全等级不同**，UI 必须如实说
 *
 * | 宿主 | 存哪 | 页面脚本能读到吗 |
 * | --- | --- | --- |
 * | 桌面 Electron | **主进程**持有（可选 `safeStorage` 落盘） | **不能**（渲染层拿不到） |
 * | Android | Capacitor Preferences | 能（但 WebView 里没有第三方脚本） |
 * | 网页 | **`localStorage`**（文档已定） | **能** ← ⚠️ **这是网页端 E2EE 的固有弱点** |
 *
 * §3.9 对网页端写得很直白：「⚠️ **可被 XSS 读**——这是网页端 E2EE 的固有弱点，UI 必须写明；
 * 换来的是『刷新不用重新导入密钥』」。
 *
 * 所以这个模块把「密钥放在哪」变成**可查询的事实**（`host` / `readableByPageScript`），
 * 而不是让 UI 去猜。有一条用例断言：**网页端的 `readableByPageScript` 必须是 `true`** ——
 * 如果哪天有人把它改成 `false`（因为「看起来更安全」），那条用例会红，
 * 因为那等于**对用户撒谎**。
 *
 * ## 为什么存的是**导出文本**而不是拆开的字段
 *
 * `accountKey.ts` 的导出格式（`opennote-key-v1.…`）已经包含 `accountId`，
 * 而 `accountId` 是 `authToken` 的派生 salt —— 少了它，读回来的密钥**派不出令牌**。
 * 存成一个不透明的字符串，就不存在「存的时候漏了一个字段」这种错。
 */

import { decodeAccountKey } from "./accountKey";

/** 密钥存在哪里（UI 要据此给出准确的说明，不能含糊）。 */
export type KeyStoreHost = "desktop-main" | "browser-local-storage" | "capacitor-preferences" | "memory";

export interface AccountKeyStore {
  readonly host: KeyStoreHost;
  /**
   * **页面脚本能不能读到这把密钥**。
   *
   * 桌面端 `false`（密钥在主进程，渲染层只能请求它做事）；
   * 网页端与移动端 `true`（`localStorage` / Preferences 都在 JS 可及范围内）。
   *
   * ⚠️ 这个值**必须如实**：它不是「我们打算怎么用它」，而是「攻击者拿到一次 XSS 之后
   * 能不能把它读走」。把它报成 `false` 只是让 UI 少说一句警告，不改变事实。
   */
  readonly readableByPageScript: boolean;
  /** 读回保存的密钥文本；没有（或已损坏）返回 `null`。 */
  load(): Promise<string | null>;
  /** 保存（会**校验形状**：坏的值不该进存储，否则失败会推迟到下一次派生）。 */
  save(text: string): Promise<void>;
  /** 清掉（轮换 / 退出 / 删除账号时用）。 */
  clear(): Promise<void>;
}

/** 存储键名。带版本号：将来换格式时不会把旧值当成新格式读。 */
export const ACCOUNT_KEY_STORAGE_KEY = "opennote.sync.accountKey.v1";

/**
 * 校验一段文本是不是**可用的**账号密钥。
 *
 * 在 `save` 时校验的理由：一个坏值进了存储，失败会推迟到「用户下次打开应用」，
 * 而那时的报错离「保存的时候就已经错了」很远。**在边界上挡住。**
 */
function assertUsable(text: string): void {
  // `decodeAccountKey` 会在版本/长度/base64 不对时抛出**可读**的错误。
  decodeAccountKey(text);
}

/* ============================================================================
   内存实现（测试用；也是「不记住」模式的实现）
   ============================================================================ */

/**
 * 内存里的密钥保管。
 *
 * 两个用途：① 用例；② **「不记住密钥」模式** —— 用户明确不要持久化时用它，
 * 于是「刷新就要重新导入」是一个**被实现出来的**行为，而不是靠某处不写存储。
 */
export function createMemoryKeyStore(initial: string | null = null): AccountKeyStore {
  let value: string | null = initial;
  return {
    host: "memory",
    // 内存里当然读得到 —— 但「页面脚本」指的是**持久化之后**能不能读，
    // 内存态下没有可读的落盘副本。报 `true` 更保守（不低估风险）。
    readableByPageScript: true,
    async load() {
      return value;
    },
    async save(text) {
      assertUsable(text);
      value = text;
    },
    async clear() {
      value = null;
    },
  };
}

/* ============================================================================
   网页实现（localStorage）
   ============================================================================ */

/** 只用到 `localStorage` 的这四个方法（传别的实现也能用，便于测试）。 */
export interface WebStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 网页端的密钥保管（`localStorage`）。
 *
 * ⚠️ **`readableByPageScript: true`** —— 这是 §3.9 明确承认的弱点，不是 bug。
 * UI 必须写明「网页端保存的密钥可被恶意脚本读取」，让用户自己决定要不要在这台设备上保存。
 *
 * 存储不可用（隐私模式 / 配额满 / 被策略禁用）时**不抛**：退回「只在本页有效」的行为，
 * 并把 `persisted` 报成 false。抛出去会让整个引导流程卡在第一步，而那是不必要的 ——
 * 用户仍然可以当场用，只是刷新后要重新导入。
 */
export function createWebKeyStore(storage?: WebStorageLike): AccountKeyStore & { persisted(): boolean } {
  const backing = storage ?? (typeof localStorage === "undefined" ? null : localStorage);
  let memoryOnly: string | null = null;
  let lastWriteFailed = false;

  return {
    host: "browser-local-storage",
    readableByPageScript: true,
    persisted: () => backing !== null && !lastWriteFailed,
    async load() {
      if (!backing) return memoryOnly;
      try {
        /*
         * ★ **落盘那份优先，没有就退回会话那份。**
         *
         * 第一版这里只 `return backing.getItem(...)` —— 于是在「写失败」之后
         * `load()` 返回 `null`，把内存里那一份也一起丢掉了。
         * 那正好抵消了降级的意义：降级要保证的是「本页仍然能用」，
         * 而第一版只在 `save()` 那一刻看起来成立（`persisted()` 报了 false），
         * 一旦真去读就露馅。用例咬住了它。
         */
        return backing.getItem(ACCOUNT_KEY_STORAGE_KEY) ?? memoryOnly;
      } catch {
        // 读被拒（某些浏览器的隐私模式）：退回内存。
        return memoryOnly;
      }
    },
    async save(text) {
      assertUsable(text);
      memoryOnly = text;
      if (!backing) {
        lastWriteFailed = true;
        return;
      }
      try {
        backing.setItem(ACCOUNT_KEY_STORAGE_KEY, text);
        lastWriteFailed = false;
      } catch {
        // 配额满 / 被禁用：**不抛**，退回「只在本页有效」。
        lastWriteFailed = true;
      }
    },
    async clear() {
      memoryOnly = null;
      if (!backing) return;
      try {
        backing.removeItem(ACCOUNT_KEY_STORAGE_KEY);
      } catch {
        // 删不掉也没什么可做的（值已经不在了或存储不可用）。
      }
    },
  };
}

/* ============================================================================
   桌面实现（转发到主进程）
   ============================================================================ */

/** 主进程通过 preload 暴露的那一小块接口。 */
export interface DesktopKeyBridge {
  load(): Promise<string | null>;
  save(text: string): Promise<void>;
  clear(): Promise<void>;
  /** 主进程是否启用了 `safeStorage` 落盘（false = 只在主进程内存里）。 */
  persisted(): Promise<boolean>;
}

export interface DesktopKeyStoreOptions {
  bridge: DesktopKeyBridge;
  /** 主进程报告是否持久化（用来在 UI 上如实说明「退出后还在不在」）。 */
  onPersistence?: (persisted: boolean) => void;
}

/**
 * 桌面端的密钥保管：**渲染层不持有密钥**，只把「读/写/清」转发给主进程。
 *
 * 这是 §3.9 对桌面端的要求（「主进程持有（可选 `safeStorage` 落盘）」），
 * 也是 §5.5「渲染层拿不到令牌/密钥」那条纪律的落点：
 * 即使渲染层被 XSS，攻击者也只能**请求**主进程做事，拿不到密钥原文去别的设备上用。
 */
export function createDesktopKeyStore(options: DesktopKeyStoreOptions): AccountKeyStore {
  return {
    host: "desktop-main",
    // 密钥在主进程，页面脚本读不到原文（只能请求它代签/代理）。
    readableByPageScript: false,
    async load() {
      const text = await options.bridge.load();
      // 主进程存的值也校验一遍：磁盘文件可能被手工改过。
      if (text === null) return null;
      try {
        assertUsable(text);
        return text;
      } catch {
        // 坏值当「没有」：让用户重新导入，而不是让派生在一个看不懂的地方失败。
        return null;
      }
    },
    async save(text) {
      assertUsable(text);
      await options.bridge.save(text);
      options.onPersistence?.(await options.bridge.persisted());
    },
    async clear() {
      await options.bridge.clear();
    },
  };
}

/* ============================================================================
   宿主选择
   ============================================================================ */

/** preload 注入的 `window.opennote` 里与本模块有关的那一块（其余字段不关心）。 */
interface OpenNoteGlobal {
  isElectron?: boolean;
  syncKeys?: DesktopKeyBridge;
}

/** 取 `window.opennote`（没有就是浏览器/移动端）。 */
function globalBridge(): OpenNoteGlobal | null {
  const scope = globalThis as { window?: { opennote?: OpenNoteGlobal } };
  return scope.window?.opennote ?? null;
}

/**
 * 按宿主挑一个实现。
 *
 * 判定顺序（**桌面优先**）：`window.opennote.syncKeys` 在 ⇒ 主进程持有；
 * 否则用 `localStorage`。移动端（Capacitor）目前走 `localStorage` 这条路 ——
 * Capacitor 的 WebView 里 `localStorage` 是持久的，而接 Preferences 需要原生插件，
 * 那属于 P2 之后的收尾（**这里如实说明，不假装已经接了**）。
 */
export function resolveAccountKeyStore(options: { storage?: WebStorageLike } = {}): AccountKeyStore {
  const bridge = globalBridge();
  if (bridge?.isElectron && bridge.syncKeys) {
    return createDesktopKeyStore({ bridge: bridge.syncKeys });
  }
  return createWebKeyStore(options.storage);
}

/* ============================================================================
   给 UI 用的一句话说明（避免每个界面各写一遍、各写错一遍）
   ============================================================================ */

/**
 * 告诉用户「这把密钥存在哪、有什么风险」。
 *
 * 放在这里（而不是各组件里）是因为这三句话是**对同一个事实**的三种表述，
 * 分散写迟早会出现「一个界面说了风险、另一个没说」。
 */
export function describeKeyStorage(store: AccountKeyStore): { where: string; risk: string | null } {
  switch (store.host) {
    case "desktop-main":
      return {
        where: "密钥保存在应用主进程里，网页代码读不到它。",
        risk: null,
      };
    case "browser-local-storage":
      return {
        where: "密钥保存在这个浏览器的 localStorage 里，刷新不用重新导入。",
        risk: "注意：网页端保存的密钥可以被页面上的恶意脚本读走。如果你不放心，就选「不记住」，每次打开时重新粘贴密钥。",
      };
    case "capacitor-preferences":
      return {
        where: "密钥保存在这台设备的应用存储里。",
        risk: "注意：应用内的脚本可以读到它。",
      };
    case "memory":
      return {
        where: "密钥只保留在本次会话里，刷新或退出后需要重新导入。",
        risk: null,
      };
  }
}
