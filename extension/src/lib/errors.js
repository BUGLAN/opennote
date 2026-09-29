/**
 * Opennote 剪藏扩展 · 错误码与用户文案的唯一来源。
 *
 * 依据：docs/import/02-接口契约-导入信封与通道.md §6.1 / §6.2 / §5.7.7，
 *      以及 docs/import/03-UI设计规范-剪藏与导入.md §UI-01（插件侧口吻覆盖）。
 *
 * 纪律（02 §6.4）：**不允许出现「未知错误」这类兜底文案**。任何一个失败提示都要能
 * 追溯到某个 IMP-xxxx；真有未覆盖的情况，说明缺一个错误码，应补号。
 * 因此本文件把 02 §6.2 的**全部**错误码与警告码都列全，未命中的码走 `IMP-5001`
 * 之外的 `UNKNOWN_CODE` 时会被 `assertCodeTableComplete()` 在构建期/测试期拦下。
 */

export const SPEC = "opennote.import/v1";
export const CLIENT_NAME = "chrome-extension";
export const CLIENT_VERSION = "0.1.4";

/**
 * 02 §6.2 错误码总表（code → http / retryable / userMessage）。
 * `ui` 字段是 03 号 §UI-01 针对插件场景逐字覆盖过的文案（更贴合「插件里看到」的语境），
 * 有 `ui` 时界面用 `ui`；`userMessage` 永远是 02 号的原句，服务端返回时就近优先。
 */
export const IMP_TABLE = {
  /* ── IMP-1xxx 桥与传输 ───────────────────────────────────────────────── */
  "IMP-1001": {
    http: null,
    retryable: false,
    userMessage: "本地接口未开启。请在 Opennote 的「设置 · 文件 · 导入与接口」里开启，然后重试。",
    ui: "本地接口未开启。打开桌面版 Opennote 的「设置 · 文件 · 导入与接口」，开启本地接口后重试。",
    uiSource: "03 §UI-01/S9（产品经理冻结文案第 1 条）",
  },
  "IMP-1002": {
    http: null,
    retryable: false,
    userMessage: "本地接口启动失败，端口可能被安全软件占用。可在设置里换一个端口，或查看日志。",
  },
  "IMP-1003": {
    http: null,
    retryable: false,
    userMessage: "8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。",
  },
  "IMP-1004": {
    http: 504,
    retryable: true,
    userMessage: "本地接口没有及时响应。请确认 Opennote 正在运行。",
  },
  "IMP-1005": {
    http: 403,
    retryable: false,
    // 02 §6.2：不显示给用户（攻击特征或误配置）
    userMessage: null,
  },
  "IMP-1006": {
    http: 409,
    retryable: false,
    userMessage: "当前浏览器或平台不支持这种导入方式。可以复制正文手动粘贴，或安装 Opennote 桌面版。",
    ui: "这个页面不允许插件读取内容。换个普通网页再试。",
    uiSource: "03 §UI-01/S5（受限页面的如实告知）",
  },

  /* ── IMP-2xxx 鉴权与来源 ─────────────────────────────────────────────── */
  "IMP-2001": {
    http: 401,
    retryable: false,
    userMessage: "这个客户端还没有配对。请在 Opennote 的「导入与接口」里点「配对新客户端」，输入显示的 6 位配对码。",
  },
  "IMP-2002": {
    http: 401,
    retryable: false,
    // 02 §6.2 与 mockup S10 同句；03 §UI-01/S10 表格里的另一句属文档不一致，见 README「已知不一致」。
    userMessage: "访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。",
  },
  "IMP-2003": {
    http: 429,
    retryable: true,
    userMessage: "尝试次数过多，请稍后再试。",
  },
  "IMP-2004": {
    http: 401,
    retryable: false,
    userMessage: "配对码不正确或已过期，请在 Opennote 里重新生成。",
  },

  /* ── IMP-3xxx 请求形态与来源 ─────────────────────────────────────────── */
  "IMP-3001": {
    http: 403,
    retryable: false,
    userMessage: "来源未被允许。请在设置里添加来源，或用配对流程重新配对。",
    // 02 §6.2 RV-06：不进 toast、不进插件气泡，只进设置面板的「被拒绝的来源」日志。
    // 插件侧的处理是把状态切到「需要配对」（来源还没被信任），因此不展示这句原文。
    silentInExtension: true,
  },
  "IMP-3002": {
    http: 400,
    retryable: false,
    userMessage: "导入内容不是有效的 JSON，请重试。",
  },
  "IMP-3003": {
    http: 400,
    retryable: false,
    userMessage: "导入内容为空。",
  },
  "IMP-3004": {
    http: 415,
    retryable: false,
    userMessage: null,
  },
  "IMP-3005": {
    http: 404,
    retryable: false,
    userMessage: null,
  },

  /* ── IMP-4xxx 信封与落点 ─────────────────────────────────────────────── */
  "IMP-4001": { http: 400, retryable: false, userMessage: "导入内容格式不正确。" },
  "IMP-4002": {
    http: 422,
    retryable: false,
    userMessage: "这个客户端版本太旧（或太新），请更新后再试。",
  },
  "IMP-4003": {
    http: 422,
    retryable: false,
    userMessage: "导入内容缺少必要信息（标题、来源时间或地址），请重试。",
  },
  "IMP-4004": {
    http: 413,
    retryable: false,
    userMessage: "正文太长了（超过 8 MB），请分次导入。",
  },
  "IMP-4005": {
    http: 413,
    retryable: false,
    userMessage: "这次剪藏的内容太大（超过 16 MB），请分次导入或去掉图片。",
  },
  "IMP-4006": {
    http: 409,
    retryable: true,
    userMessage: "Opennote 的窗口已关闭。请重新打开 Opennote，再试一次。",
  },
  "IMP-4007": {
    http: 409,
    retryable: false,
    userMessage: "Opennote 里还没有打开笔记本，请先打开一个文件夹（或新建浏览器笔记本）。",
  },
  "IMP-4008": {
    http: 422,
    retryable: false,
    userMessage: "目标目录不合法：不能使用 `..`、绝对路径或系统保留字符。",
  },
  "IMP-4009": {
    http: 404,
    retryable: false,
    userMessage: "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。",
  },
  "IMP-4010": {
    http: 409,
    retryable: false,
    userMessage: "这个目录里同名文件太多了，请换一个目录或改标题。",
  },
  "IMP-4011": {
    http: 409,
    retryable: false,
    userMessage: "「追加」的目标不存在，已改为新建一篇。",
  },
  "IMP-4012": {
    http: 415,
    retryable: false,
    userMessage: "有一个附件无法导入（格式不支持或太大）。",
  },
  "IMP-4013": {
    http: 413,
    retryable: false,
    userMessage: "附件太多或太大，请减少后用重新剪藏。",
  },
  "IMP-4014": {
    http: 500,
    retryable: true,
    userMessage: "导入时出现了内部错误，已记录日志。请重试一次。",
  },
  "IMP-4015": {
    http: 429,
    retryable: true,
    userMessage: "导入太频繁了，请稍等几秒再试。",
  },
  "IMP-4017": {
    http: 404,
    retryable: false,
    userMessage: "没有找到这条导入记录。",
  },
  "IMP-4020": {
    http: 409,
    retryable: true,
    userMessage: "上一次导入还在进行中，请稍候重试。",
  },

  /* ── IMP-5xxx 服务端内部 ─────────────────────────────────────────────── */
  "IMP-5001": {
    http: 500,
    retryable: true,
    userMessage: "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
  },
};

/** 02 §6.2 IMP-Wxxx 警告（非致命，出现在 warnings[] 里）。 */
export const IMP_WARNINGS = {
  "IMP-W001": "正文为空，只写入了标题。",
  "IMP-W002": "正文里有未声明的本地附件引用，已原样保留。",
  "IMP-W003": "没找到要追加的笔记，已新建一篇。",
  "IMP-W004": "目标笔记有外部改动，已另存为新文件以免覆盖。",
  "IMP-W005": "幂等索引写入失败，重复导入可能产生副本。",
  "IMP-W006": "网页发布时间无法识别，已忽略。",
  "IMP-W007": "部分标签不符合规则，已忽略。",
  "IMP-W008": "本次追加没有留下可回退的前像，撤销将只把笔记移入回收站。",
};

/** 02 §5.7.7 扩展侧本地原因码 → 契约 code 的映射（不允许出现「映射不到 02 号」的提示）。 */
export const LOCAL_REASON_TO_CODE = {
  unsupported_platform: "IMP-1006",
  no_window: "IMP-4006",
  queued_offline: null, // 通道级本地状态，不是错误码，对应收件箱 pending
  write_failed: "IMP-5001",
};

export const KNOWN_CODES = Object.freeze(Object.keys(IMP_TABLE));

/**
 * 取某个错误码展示给用户的中文文案。
 * 优先级：服务端 userMessage（`serverMessage`，就近事实）> 插件侧覆盖 `ui` > 02 号原句。
 * 返回 null 表示该码按契约**不可见**（IMP-1005 / IMP-3004 / IMP-3005）。
 */
export function userMessage(code, serverMessage) {
  const entry = IMP_TABLE[code];
  if (!entry) return null;
  if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage;
  if (entry.silentInExtension) return null;
  return entry.ui || entry.userMessage;
}

/** 该码是否允许「原样重试」。未知码一律 false（不许空转重试）。 */
export function isRetryable(code) {
  const entry = IMP_TABLE[code];
  return Boolean(entry && entry.retryable);
}

/** 该码在插件里是否可见（02 §6.2 有三条明令不显示给用户）。 */
export function isVisibleInExtension(code) {
  const entry = IMP_TABLE[code];
  if (!entry) return true;
  if (entry.silentInExtension) return false;
  return entry.userMessage !== null || typeof entry.ui === "string";
}

/** 契约码是否存在。用于测试与「没有未知错误」这条纪律的机械化校验。 */
export function isKnownCode(code) {
  return Object.prototype.hasOwnProperty.call(IMP_TABLE, code);
}

/** 从服务端错误体里取 code；形状见 02 §6.1。 */
export function errorCodeOf(payload) {
  if (payload && typeof payload === "object" && payload.error && typeof payload.error.code === "string") {
    return payload.error.code;
  }
  return null;
}
