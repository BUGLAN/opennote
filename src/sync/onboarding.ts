/**
 * 引导流程的状态机（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.5 的三个流程、§5.2）。
 *
 * ## 为什么把「流程」单独抽成模块，而不是写在 `Onboarding.tsx` 里
 *
 * §1.5 流程①第 9 步是一条**硬要求**：
 *
 * > ★ 立刻把 `accountKey` 交给用户保存（复制 / 下载 .key / 二维码）
 * >   —— 并强制「我已保存」确认，**否则不给进下一步**
 *
 * 「强制」这两个字如果只写在 JSX 里（`disabled={!confirmed}`），它就是一个**界面约束**：
 * 换一个入口、加一个「跳过」按钮、或者某个分支忘了判，它就没了 ——
 * 而代价是 §3.9 第 5 条那句「**账号密钥丢失 = 数据不可恢复**」。
 *
 * 所以这条约束放在**状态机**里：`advance()` 会**拒绝**未经确认的推进，
 * 并且用例直接咬它。UI 只是这个状态机的一个渲染器。
 *
 * ## 三处刻意的顺序
 *
 * 1. **生成之后先确认，再注册**（本模块的顺序）——
 *    文档的流程①把注册放在第 5 步、保存确认放在第 9 步，本模块**没有照抄那个顺序**。
 *    理由：注册成功之后账号在服务端就存在了。如果用户在这一步丢掉密钥，
 *    留下的是一个**永远打不开的账号**（占了配额、还可能占着一个笔记本）。
 *    先确认再注册，最坏情况是「用户白填了一次表单」。
 *    ⚠️ 这是一处**对文档的偏离**，写在这里而不是默默改掉。
 * 2. **注册成功之后立刻持久化**（`store.save`）——
 *    缩小「账号已建、密钥只在内存」的窗口。就算用户随后强杀进程，
 *    下次打开还能从本机读回来。
 * 3. **导入的密钥不需要确认**：用户手上已经有一份了（他就是从那儿复制来的）。
 *    但仍然要**校验它能派生出令牌** —— 一个粘贴错的密钥在这里挡住，
 *    比在「注册/登录」时以一个看不懂的 401 出现要好。
 */

import { decodeAccountKey, deriveFromAccountKey, encodeAccountKey, createRegistrationMaterial, type AccountKeyMaterial } from "./accountKey";
import { describeKeyStorage, type AccountKeyStore } from "./keys";

/** 引导的步骤。 */
export type OnboardingStep =
  /** 还没决定：生成新密钥还是导入已有的。 */
  | "choose"
  /** 刚生成，正等着用户抄下来（**强制确认**在这一步）。 */
  | "confirm-saved"
  /** 让用户给这台设备起个名字（设备账本要用，§4.3）。 */
  | "name-device"
  /** 注册/解锁完成。 */
  | "done";

export interface OnboardingState {
  step: OnboardingStep;
  /** 账号 id（生成或导入之后就有）。 */
  accountId: string | null;
  /**
   * 待用户保存的密钥文本（**只在 `confirm-saved` 这一步存在**）。
   *
   * 为什么做成「过了这一步就清掉」：它是明文秘密，而这一步之后
   * 页面已经不需要它了（派生出来的令牌与 `wrapKey` 才是后续要用的）。
   * 少留一份明文在内存里，XSS 能捞到的东西就少一份。
   */
  pendingKeyText: string | null;
  /** 用户是否已确认保存（**只有它为真才允许离开 `confirm-saved`**）。 */
  savedConfirmed: boolean;
  /** 这台设备的名字。 */
  deviceName: string;
  /** 是不是新注册的账号（false = 导入的已有账号）。 */
  isNewAccount: boolean;
  /** 最近一次错误（可读文案）。 */
  error: string | null;
  /** 密钥存在哪 + 什么风险（直接来自 `keys.ts`，UI 照抄，不要自己编）。 */
  storage: { where: string; risk: string | null };
}

/** 注册请求（与 `shared/contract.ts` 的 `accountCreateRequestSchema` 对齐）。 */
export interface RegisterInput {
  accountId: string;
  authToken: string;
  wrappedEncRoot: string;
  inviteCode?: string;
  bootstrapCode?: string;
  label?: string;
}

export interface OnboardingDeps {
  store: AccountKeyStore;
  /** 注册（`POST /v1/account`）。测试注入。 */
  register: (input: RegisterInput) => Promise<{ accountId: string; isAdmin: boolean }>;
  /** 生成随机材料（测试注入固定值用）。 */
  material?: () => AccountKeyMaterial & { authToken: string; wrappedEncRoot: string };
  /** 设备名的默认值（默认取平台提示）。 */
  defaultDeviceName?: () => string;
}

export interface Onboarding {
  state(): OnboardingState;
  /** 生成一把新密钥（进入 `confirm-saved`）。 */
  generate(): void;
  /** 导出待保存的密钥文本（复制 / 下载 `.key` / 二维码都用**同一个**字符串）。 */
  exportPendingKey(): string | null;
  /**
   * 用户点了「我已保存」。
   *
   * **这是离开 `confirm-saved` 的唯一途径**（`register()` 会拒绝未经确认的调用）。
   */
  confirmSaved(): void;
  /** 注册（必须在 `confirmSaved()` 之后）。 */
  register(options: { inviteCode?: string; bootstrapCode?: string; label?: string }): Promise<void>;
  /** 导入一把已有的密钥（跳过确认，因为用户手上已经有一份）。 */
  importKey(text: string): Promise<void>;
  /** 给设备命名（空名字会被拒绝 —— 设备账本里一条无名的记录没有用）。 */
  nameDevice(name: string): void;
  /** 从本机存储恢复（应用启动时调一次）：有密钥就直接进 `name-device`/`done`。 */
  restore(): Promise<boolean>;
  /** 从头开始（换账号 / 出错重来）。 */
  reset(): void;
}

const DEFAULT_DEVICE_NAME = "我的设备";

export function createOnboarding(deps: OnboardingDeps): Onboarding {
  const makeMaterial = deps.material ?? createRegistrationMaterial;
  const defaultName = deps.defaultDeviceName ?? (() => DEFAULT_DEVICE_NAME);

  let step: OnboardingStep = "choose";
  let accountId: string | null = null;
  let pendingKeyText: string | null = null;
  let savedConfirmed = false;
  let deviceName = defaultName();
  let isNewAccount = false;
  let error: string | null = null;
  /** 注册要用的材料（只在新生成那条路上有）。 */
  let registration: { authToken: string; wrappedEncRoot: string } | null = null;

  const snapshot = (): OnboardingState => ({
    step,
    accountId,
    pendingKeyText,
    savedConfirmed,
    deviceName,
    isNewAccount,
    error,
    storage: describeKeyStorage(deps.store),
  });

  return {
    state: snapshot,

    generate() {
      const material = makeMaterial();
      accountId = material.accountId;
      pendingKeyText = encodeAccountKey({ accountId: material.accountId, accountKey: material.accountKey });
      registration = { authToken: material.authToken, wrappedEncRoot: material.wrappedEncRoot };
      savedConfirmed = false;
      isNewAccount = true;
      error = null;
      step = "confirm-saved";
    },

    exportPendingKey() {
      return pendingKeyText;
    },

    confirmSaved() {
      if (step !== "confirm-saved") return;
      savedConfirmed = true;
    },

    async register(options) {
      /*
       * ★ **强制确认**（§1.5 流程①第 9 步）。
       *
       * 这是本模块存在的**主要理由**。注意它是「拒绝执行」而不是「返回一个错误状态」——
       * 调用方没有办法绕过它去拿到一个「注册了但没确认」的账号。
       */
      if (step !== "confirm-saved") {
        error = "还没到注册这一步";
        return;
      }
      if (!savedConfirmed) {
        error = "请先确认你已经把账号密钥保存好了 —— 密钥丢了，笔记本就永远打不开了。";
        return;
      }
      if (!registration || !accountId || !pendingKeyText) {
        error = "密钥材料不完整，请重新生成";
        return;
      }

      try {
        await deps.register({
          accountId,
          authToken: registration.authToken,
          wrappedEncRoot: registration.wrappedEncRoot,
          ...(options.inviteCode === undefined ? {} : { inviteCode: options.inviteCode }),
          ...(options.bootstrapCode === undefined ? {} : { bootstrapCode: options.bootstrapCode }),
          ...(options.label === undefined ? {} : { label: options.label }),
        });
      } catch (cause) {
        // 注册失败**不**把用户踢回上一步：他抄下来的密钥仍然有效，重试即可。
        // （重新生成会让刚才那份手抄的密钥作废 —— 那是更糟的结果。）
        error = cause instanceof Error ? cause.message : String(cause);
        return;
      }

      // 注册成功 ⇒ **立刻持久化**（见模块头第 2 条：缩小「账号已建、密钥只在内存」的窗口）。
      await deps.store.save(pendingKeyText);

      // 用户已经确认过了，明文秘密不再需要留在内存里。
      pendingKeyText = null;
      registration = null;
      error = null;
      step = "name-device";
    },

    async importKey(text) {
      let material: AccountKeyMaterial;
      try {
        material = decodeAccountKey(text);
        // ★ 校验它能派生出令牌：一个粘贴错的密钥在这里挡住，
        //   比在注册/登录时以一个看不懂的 401 出现要好。
        deriveFromAccountKey(material);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        return;
      }
      accountId = material.accountId;
      isNewAccount = false;
      savedConfirmed = true; // 用户手上已经有一份，不需要再确认
      error = null;
      pendingKeyText = null;
      await deps.store.save(encodeAccountKey(material));
      step = "name-device";
    },

    nameDevice(name) {
      const trimmed = String(name ?? "").trim();
      if (!trimmed) {
        // 设备账本里一条无名的记录没有用（用户认不出哪台是哪台）。
        error = "设备名不能是空的";
        return;
      }
      deviceName = trimmed.slice(0, 120);
      error = null;
      step = "done";
    },

    async restore() {
      const stored = await deps.store.load();
      if (stored === null) return false;
      try {
        const material = decodeAccountKey(stored);
        accountId = material.accountId;
        isNewAccount = false;
        savedConfirmed = true;
        error = null;
        // 恢复时**不**猜设备名（那要问平台），保留默认值让用户改。
        step = "name-device";
        return true;
      } catch {
        // 本机存的值坏了：当「没有」，让用户重新导入。
        return false;
      }
    },

    reset() {
      step = "choose";
      accountId = null;
      pendingKeyText = null;
      savedConfirmed = false;
      isNewAccount = false;
      registration = null;
      error = null;
      deviceName = defaultName();
    },
  };
}
