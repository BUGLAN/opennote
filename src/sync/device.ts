/**
 * 设备标识（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.7、§5.4 第 4 条）。
 *
 * ## 它是什么、不是什么
 *
 * **是**：一台设备的稳定名字。同步检查点（远端 `_local/device-<deviceId>`）拿它做键，
 * 控制台的「我的设备」账本也拿它做键。
 *
 * **不是**凭据。本设计**一个账号密钥所有设备共用**，没有每设备凭据，所以也没有
 * 「踢掉某台设备」这个能力（§1.5 代价 3）。设备清单因此是**只读账本**。这一点的直接后果是：
 * **deviceId 撞了不构成安全问题** —— 最坏是两台设备共用一条检查点，多拉一次全量。
 *
 * ## 为什么**绝不能**放进 `.opennote/`
 *
 * `.opennote/` 会跟着笔记本目录被拷贝、被导出、进 `.git`。里面放 `deviceId` 的后果是：
 * **两台设备共用一个 `_local` 检查点** —— 一台把 cursor 推到很前面，另一台以为自己已经
 * 同步到那里了，于是**静默漏掉中间的所有变更**（在 E2EE 下尤其难查）。
 *
 * 所以它只存**站点存储**（桌面与网页 = `localStorage`；Android = Capacitor Preferences，
 * 见 `keys.ts` 的同一条纪律：凭据与设备身份都不进笔记本目录）。
 *
 * ## 退路：`localStorage` 不可用时
 *
 * 浏览器可能拒绝站点数据（D04，见 `ui.ts`）。那时退回**本会话内存值**：本次运行内稳定，
 * 关掉就换一个新的。代价是「重开一次多拉一次全量」，而不是「漏同步」—— 这个方向是对的，
 * 因为检查点是**按 deviceId 建的**，新的 deviceId 天然从头开始。
 */

/** 站点存储的键。**唯一产地**：别处不许再写一份字面量。 */
export const DEVICE_ID_KEY = "opennote.sync.device.v1";

/**
 * deviceId 的形状约束。
 *
 * 用**无连字符的十六进制**（32 字符）而不是标准 UUID 文本：它会进 URL 查询参数与
 * 远端文档 id（`_local/device-<deviceId>`），无连字符就完全不用考虑转义。
 */
const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 造一个新的 deviceId。
 *
 * 用 `crypto.getRandomValues`（CSPRNG），**绝不**用 `Math.random` —— 与
 * §4.9「必须用 CSPRNG」同一条纪律（哪怕这里撞了不构成安全问题，也不给自己开这个口子）。
 */
export function createDeviceId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("当前环境没有 crypto.getRandomValues，无法生成设备标识");
  }
  crypto.getRandomValues(bytes);
  // 与 UUIDv4 同构：只影响可读性，不影响唯一性判据。
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytesToHex(bytes);
}

/** 这个字符串能不能当 deviceId 用（形状判据，读盘/收远端参数时都要过）。 */
export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && DEVICE_ID_PATTERN.test(value);
}

/** 站点存储可能是被禁用的（D04）：读写都要能退化成「本会话有效」。 */
function storage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // 连读属性都抛（企业策略 / 嵌入式 WebView）。
    return undefined;
  }
}

let cached: string | null = null;

/**
 * 取本设备的 deviceId：第一次调用时**读站点存储，读不到就造一个并写回去**。
 *
 * 结果在模块内缓存：同一次运行内恒定，且不会因为存储抖动而中途换名字
 * （中途换名字会让「我同步到哪了」这条路断掉）。
 */
export function getDeviceId(): string {
  if (cached !== null) return cached;
  const store = storage();
  if (store) {
    try {
      const saved = store.getItem(DEVICE_ID_KEY);
      if (isValidDeviceId(saved)) {
        cached = saved;
        return cached;
      }
      if (saved !== null) {
        // 存储里是个坏值（手改过、或旧版本写的）：覆盖掉，并让上层知道我们换了名字。
        console.warn("[opennote] 站点存储里的设备标识形状不对，重新生成");
      }
      const created = createDeviceId();
      store.setItem(DEVICE_ID_KEY, created);
      cached = created;
      return cached;
    } catch (error) {
      console.warn("[opennote] 设备标识没能保存到站点存储，本次运行使用临时值", error);
    }
  }
  cached = createDeviceId();
  return cached;
}

/** 设备标识当前是不是「本会话临时值」（没落到站点存储）——控制台用它决定要不要提示。 */
export function isDeviceIdEphemeral(): boolean {
  const store = storage();
  if (!store) return true;
  try {
    return store.getItem(DEVICE_ID_KEY) !== cached;
  } catch {
    return true;
  }
}

/**
 * 测试用：清掉缓存与站点存储里的值，让下一次 `getDeviceId()` 重新走一遍完整流程。
 * 生产代码不该调它（换 deviceId 的正式手段是「重装/清站点数据」）。
 */
export function resetDeviceIdForTests(options: { clearStorage?: boolean } = {}): void {
  cached = null;
  if (options.clearStorage === false) return;
  try {
    storage()?.removeItem(DEVICE_ID_KEY);
  } catch {
    /* 存储不可用：没有可清的 */
  }
}

/** 测试用：固定一个 deviceId（不写站点存储），用于「两台设备」这类场景。 */
export function setDeviceIdForTests(value: string): void {
  if (!isValidDeviceId(value)) throw new Error(`setDeviceIdForTests 收到非法形状：${value}`);
  cached = value;
}
