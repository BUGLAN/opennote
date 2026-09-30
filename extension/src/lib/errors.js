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
    // 00 §6.15㉞ 冻结（0.3.1）：配对删除后要指向**唯一存在的动作**——复制令牌、粘贴到客户端。
    userMessage: "这个客户端还没有配置访问令牌。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。",
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
  // IMP-2004 已于 0.3.1 作废（00 号 §6.15㉞）：码号保留、不再产出，故本表不再收录它的文案。
  // （不收敛的理由：一条产不出来的文案留在表里是死数据，且会永远与 02 附录 A.3 的冻结文案对不上。）

  /* ── IMP-3xxx 请求形态与来源 ─────────────────────────────────────────── */
  "IMP-3001": {
    http: 403,
    retryable: false,
    // 00 §6.15㉞ 冻结（0.3.1）：来源判据从「这个来源配对过吗」改成「是不是扩展或本机程序」，
    // 所以文案必须如实说出**允许哪两类来源**（旧的「用配对流程重新配对」指向的下一步已不存在）。
    userMessage: "来源未被允许。本地接口只接受浏览器扩展与本机程序发来的请求。",
    // 02 §6.2 RV-06：不进 toast、不进插件气泡，只进设置面板的「被拒绝的来源」日志。
    // 插件侧的处理是把状态切到「未配置令牌」，因此不展示这句原文。
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
    // 00 §6.14 ㉗ 逐字冻结：「应用没运行」和「工作区没打开」是两件事
    userMessage: "Opennote 没有在运行。请先打开 Opennote，再试一次。",
  },
  "IMP-4007": {
    http: 409,
    retryable: false,
    // 00 §6.14 ㉗ 逐字冻结：不允许再出现「还没有打开笔记本」「请先打开一个文件夹（或新建浏览器笔记本）」
    userMessage: "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。",
  },
  "IMP-4008": {
    http: 422,
    retryable: false,
    // 00 §6.14 ㉗ / 02:1701 的表格单元格里 `..` 的反引号是 **Markdown 内联代码标记**，不是文案；
    // 照 electron/bridge.cjs 的真值：这一行**不许**带反引号（会原样显示给用户）。
    userMessage: "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。",
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
  /*
   * 网页版剪藏页（A）的 5 个专用码：**0.3.3 补进扩展侧错误表**。
   *
   * 为什么必须补：它们由桥产出，但 `userMessage()` 对**不在表里**的码返回 `null`。
   * 桥的 `sendError` 会带 `userMessage`，所以正常路径下用户仍能看到人话 —— 但只要有一处
   * 不带（未来的路由、代理、或错误体被裁剪），popup 就会**什么都不显示**。
   * 更要紧的是 `isKnownCode()` 会判 false，任何「未知码」护栏都会误伤。
   *
   * 文案**逐字照抄 02 附录 A.3 / 桥的 ERROR_TABLE**（`verify-contract` 的 C-6f 按产地逐字比对，
   * 这里差一个字就红）。**不得**改写成「更友好」的说法 —— 一个码号两种含义正是本轮关掉的口子。
   */
  "IMP-4018": {
    http: 409,
    retryable: false,
    userMessage: "这个暂存条目已经入库过一次，而且当时的正文与现在不同。请回到浏览器重新剪藏一次。",
  },
  "IMP-4019": {
    http: 401,
    retryable: false,
    userMessage: "这个剪藏链接不完整或已被改过，无法确认它的身份。请回到浏览器重新剪藏一次。",
  },
  "IMP-4021": {
    http: 404,
    retryable: false,
    userMessage: "这条剪藏暂存已经失效（暂存只保留 15 分钟），请回到浏览器重新剪藏一次。",
  },
  "IMP-4022": {
    http: 422,
    retryable: false,
    userMessage: "这个目录在笔记本里不存在。请回到剪藏页重新选择落点。",
  },

  /* ── IMP-5xxx 服务端内部 ─────────────────────────────────────────────── */
  "IMP-5001": {
    http: 500,
    retryable: true,
    userMessage: "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
  },
  /*
   * `IMP-5002` 也是 0.3.3 补进来的：它**一直**在 02 §A.3 里（本地接口未开启），
   * 但扩展侧的表里没有它 —— 原来那条「表必须覆盖 A.3」的判据用的是**手抄的 33 条基线**，
   * 漏了这一条也没人发现。改成**从文档现读**之后它当场就红了。
   * 文案逐字照抄桥的 `ERROR_TABLE`（`C-6f` 逐字比对）。
   */
  "IMP-5002": {
    http: 503,
    retryable: true,
    userMessage: "本地接口当前不在运行状态。请先在 Opennote 的「设置 · 文件 · 导入与接口」里开启接口，再重试。",
  },
  "IMP-5003": {
    http: 503,
    retryable: true,
    userMessage: "网页版剪藏页还没有构建（找不到 dist-clip）。请先跑一次 pnpm build:clip，再重试打开。",
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
 *
 * 注意（0.3.3 修的一处结构错误）：原来第一行是 `if (!entry) return null;` ——
 * **码号不在表里时，服务端自己给的那句话会被直接丢掉**，用户看到的是与本因无关的兜底句。
 * 真实现场：桥回 `IMP-5003`（剪藏页还没构建）+ 它自带的那句人话，扩展侧表里当时没有这个码
 * ⇒ popup 显示成「导入时出现了内部错误，已记录日志。请重试一次。」（`IMP-4014` 的兜底），
 * 用户据此完全无法定位。**表补齐了不等于这个结构问题消失**：任何未来新增的码都会重演。
 *
 * 现在的顺序：① 契约明令不可见的码先拦（服务端原句也不放行）；② **服务端原句优先，码号在不在表里都一样**；
 * ③ 表里的 `ui` 覆盖 > `userMessage`；④ 表里也没有才是 null（调用方落回状态自带的逐字文案）。
 */
export function userMessage(code, serverMessage) {
  const entry = IMP_TABLE[code];
  // ① 契约明令「不进用户视野」的码先拦（服务端原句也不放行）。判据复用 `isVisibleInExtension()`：
  //    这批码有两种写法（`silentInExtension: true` 与 `userMessage: null`），只看其中一个会漏。
  if (entry && !isVisibleInExtension(code)) return null;
  // ② 服务端原句是**就近事实**，优先级最高 —— **码号在不在表里都一样**。
  if (typeof serverMessage === "string" && serverMessage.trim()) return serverMessage;
  if (!entry) return null;
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
