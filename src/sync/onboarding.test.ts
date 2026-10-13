/**
 * 引导流程状态机的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.5、§3.9 第 5 条、§5.2）。
 *
 * ## 这里最要紧的一组
 *
 * §1.5 流程①第 9 步要求「**强制**『我已保存』确认，否则不给进下一步」。
 * 而「强制」如果只写在 JSX 里（`disabled={!confirmed}`），它就是一个**界面约束** ——
 * 换一个入口、加一个「跳过」、或者某个分支忘了判，它就没了。
 * 代价是 §3.9 第 5 条那句「**账号密钥丢失 = 数据不可恢复**」。
 *
 * 所以下面几条断言的方向都是「**调用方绕不过去**」：
 * 未确认时 `register()` 必须**根本不调用注册函数**（不是「调了但返回错误」）。
 */
import { describe, expect, it, vi } from "vitest";
import { createOnboarding, type RegisterInput } from "./onboarding";
import { createMemoryKeyStore, type AccountKeyStore } from "./keys";
import { createRegistrationMaterial, decodeAccountKey, deriveFromAccountKey, encodeAccountKey, type AccountKeyMaterial } from "./accountKey";

/** 一个可观测的注册桩。 */
function fakeRegister(result: { fail?: Error } = {}): { calls: RegisterInput[]; register: (input: RegisterInput) => Promise<{ accountId: string; isAdmin: boolean }> } {
  const calls: RegisterInput[] = [];
  return {
    calls,
    register: async (input) => {
      calls.push(input);
      if (result.fail) throw result.fail;
      return { accountId: input.accountId, isAdmin: false };
    },
  };
}

/** 固定材料（断言才稳定）。 */
function fixedMaterial(): AccountKeyMaterial & { authToken: string; wrappedEncRoot: string } {
  const material = createRegistrationMaterial();
  return { ...material };
}

function make(overrides: { store?: AccountKeyStore; fail?: Error } = {}) {
  const store = overrides.store ?? createMemoryKeyStore();
  const register = fakeRegister(overrides.fail === undefined ? {} : { fail: overrides.fail });
  const material = fixedMaterial();
  const onboarding = createOnboarding({
    store,
    register: register.register,
    material: () => material,
    defaultDeviceName: () => "测试设备",
  });
  return { onboarding, register, store, material };
}

/* ============================================================================
   ★ 强制保存确认
   ============================================================================ */

describe("★ §1.5 流程①第 9 步 · 「我已保存」是**强制**的", () => {
  it("生成之后停在 `confirm-saved`，并给出可导出的密钥文本", () => {
    const { onboarding } = make();
    onboarding.generate();
    const state = onboarding.state();
    expect(state.step).toBe("confirm-saved");
    expect(state.accountId).toMatch(/^[0-9a-f]{32}$/);
    expect(state.pendingKeyText).toMatch(/^opennote-key-v1\./);
    expect(state.savedConfirmed).toBe(false);
    // 导出的文本与状态里的是**同一个字符串**（复制 / 下载 / 二维码都用它）。
    expect(onboarding.exportPendingKey()).toBe(state.pendingKeyText);
  });

  it("★ 未确认时 `register()` **根本不调用注册函数**（不是「调了但返回错误」）", async () => {
    /*
     * 这个区别很要紧：如果实现是「先调注册、再检查确认」，那么账号已经建出来了 ——
     * 而用户可能根本没抄下密钥。那样留下的是一个**永远打不开的账号**。
     * 断言 `calls` 为空，就是在断言「服务端那边什么都没发生」。
     */
    const { onboarding, register } = make();
    onboarding.generate();
    await onboarding.register({ bootstrapCode: "boot_x" });

    expect(register.calls).toHaveLength(0);
    expect(onboarding.state().step).toBe("confirm-saved");
    // 错误文案要说清**后果**，而不是「请先确认」这种无信息量的话。
    expect(onboarding.state().error).toContain("永远打不开");
  });

  it("确认之后才真的注册，并**立刻持久化**（缩小「账号已建、密钥只在内存」的窗口）", async () => {
    const { onboarding, register, store, material } = make();
    onboarding.generate();
    const keyText = onboarding.exportPendingKey()!;
    onboarding.confirmSaved();
    await onboarding.register({ inviteCode: "inv_x" });

    expect(register.calls).toHaveLength(1);
    expect(register.calls[0]!.accountId).toBe(material.accountId);
    expect(register.calls[0]!.authToken).toBe(material.authToken);
    expect(register.calls[0]!.wrappedEncRoot).toBe(material.wrappedEncRoot);
    expect(register.calls[0]!.inviteCode).toBe("inv_x");
    // 立刻落盘：就算随后被强杀，下次还能读回来。
    expect(await store.load()).toBe(keyText);
    expect(onboarding.state().step).toBe("name-device");
  });

  it("注册成功之后**清掉内存里的明文密钥**（这一步之后页面不再需要它）", async () => {
    const { onboarding } = make();
    onboarding.generate();
    expect(onboarding.state().pendingKeyText).not.toBeNull();
    onboarding.confirmSaved();
    await onboarding.register({});
    expect(onboarding.state().pendingKeyText).toBeNull();
    expect(onboarding.exportPendingKey()).toBeNull();
  });

  it("注册**失败**时不踢回上一步，也不落盘（用户手抄的那份仍然有效，重试即可）", async () => {
    /*
     * 这里刻意不「重新生成」：那会让用户刚抄下来的密钥**作废**，
     * 而他抄的时候并不知道会失败。保留它、让他重试，是唯一不浪费用户动作的选择。
     */
    const { onboarding, store } = make({ fail: new Error("邀请码已用尽") });
    onboarding.generate();
    const keyText = onboarding.exportPendingKey();
    onboarding.confirmSaved();
    await onboarding.register({});

    const state = onboarding.state();
    expect(state.step).toBe("confirm-saved");
    expect(state.error).toBe("邀请码已用尽");
    // 密钥没变（用户抄的那份还能用）。
    expect(state.pendingKeyText).toBe(keyText);
    // 也没落盘（账号还没建出来，存一个无效账号的密钥只会让下次启动困惑）。
    expect(await store.load()).toBeNull();
  });

  it("`confirmSaved()` 在别的步骤上不生效（不能靠乱调它跳过流程）", async () => {
    const { onboarding, register } = make();
    onboarding.confirmSaved(); // 还在 choose 步
    await onboarding.register({});
    expect(register.calls).toHaveLength(0);
  });
});

/* ============================================================================
   导入
   ============================================================================ */

describe("§1.5 流程② · 导入已有的密钥", () => {
  it("导入合法密钥 ⇒ 跳过确认、直接落盘、进 `name-device`", async () => {
    const { onboarding, store } = make();
    const existing = createRegistrationMaterial();
    const text = encodeAccountKey({ accountId: existing.accountId, accountKey: existing.accountKey });

    await onboarding.importKey(text);

    const state = onboarding.state();
    expect(state.step).toBe("name-device");
    expect(state.accountId).toBe(existing.accountId);
    expect(state.isNewAccount).toBe(false);
    // 用户手上已经有一份，不需要再确认。
    expect(state.savedConfirmed).toBe(true);
    expect(await store.load()).toBe(text);
  });

  it("★ 坏密钥在这里就挡住（而不是在注册/登录时以一个看不懂的 401 出现）", async () => {
    for (const bad of ["", "不是密钥", "opennote-key-v1.垃圾", encodeAccountKey({ accountId: "00112233445566778899aabbccddeeff", accountKey: new Uint8Array(32) }).slice(0, 40)]) {
      const { onboarding, store } = make();
      await onboarding.importKey(bad);
      expect(onboarding.state().step, `${bad.slice(0, 20)} 不该被接受`).toBe("choose");
      expect(onboarding.state().error).toBeTruthy();
      expect(await store.load()).toBeNull();
    }
  });

  it("导入之后**落盘的那一份**能解回同一个 `accountId` 与 `accountKey`（`accountId` 真的在 blob 里）", async () => {
    /*
     * 这条是「新设备只靠一个秘密就能回来」的最小验证：
     * 存进去的是**导出文本**（含 accountId），读出来必须能还原出**完整材料**。
     *
     * ⚠️ 第一版这条用例写成了 `make().store.load()` —— 那会新建一个**空的** store，
     * 于是它断言的是「空字符串解不开」，与它想验证的东西毫无关系。
     * 而且它是绿的（因为 `decodeAccountKey` 抛错被 `void` 掉了）。
     * 一个「恰好绿」的用例比没有用例更坏：它占着位置，让人以为这里被覆盖了。
     */
    const { onboarding, store } = make();
    const existing = createRegistrationMaterial();
    await onboarding.importKey(encodeAccountKey({ accountId: existing.accountId, accountKey: existing.accountKey }));

    const stored = await store.load();
    expect(stored).not.toBeNull();
    const roundTrip = decodeAccountKey(stored!);
    expect(roundTrip.accountId).toBe(existing.accountId);
    expect(Array.from(roundTrip.accountKey)).toEqual(Array.from(existing.accountKey));
    // 而且派出来的令牌与原来一致（这才是「能用」的定义）。
    expect(deriveFromAccountKey(roundTrip).authToken).toBe(existing.authToken);
  });
});

/* ============================================================================
   设备命名
   ============================================================================ */

describe("§4.3 · 设备命名", () => {
  it("空名字被拒绝（设备账本里一条无名的记录没有用）", async () => {
    const { onboarding } = make();
    await onboarding.importKey(encodeAccountKey({ accountId: "00112233445566778899aabbccddeeff", accountKey: new Uint8Array(32) }));
    onboarding.nameDevice("   ");
    expect(onboarding.state().step).toBe("name-device");
    expect(onboarding.state().error).toContain("不能是空的");
  });

  it("正常名字 ⇒ `done`，且首尾空白被去掉", async () => {
    const { onboarding } = make();
    await onboarding.importKey(encodeAccountKey({ accountId: "00112233445566778899aabbccddeeff", accountKey: new Uint8Array(32) }));
    onboarding.nameDevice("  我的笔记本  ");
    expect(onboarding.state().deviceName).toBe("我的笔记本");
    expect(onboarding.state().step).toBe("done");
  });

  it("超长名字被截断（它要进文档 id 与设备账本）", async () => {
    const { onboarding } = make();
    await onboarding.importKey(encodeAccountKey({ accountId: "00112233445566778899aabbccddeeff", accountKey: new Uint8Array(32) }));
    onboarding.nameDevice("名".repeat(500));
    expect(onboarding.state().deviceName.length).toBe(120);
  });
});

/* ============================================================================
   恢复 / 重置
   ============================================================================ */

describe("从本机恢复", () => {
  it("本机有密钥 ⇒ 恢复成功并进 `name-device`（**不**猜设备名）", async () => {
    const store = createMemoryKeyStore();
    const existing = createRegistrationMaterial();
    await store.save(encodeAccountKey({ accountId: existing.accountId, accountKey: existing.accountKey }));

    const { onboarding } = make({ store });
    expect(await onboarding.restore()).toBe(true);
    expect(onboarding.state().accountId).toBe(existing.accountId);
    expect(onboarding.state().step).toBe("name-device");
  });

  it("本机没有 ⇒ false，留在 `choose`", async () => {
    const { onboarding } = make();
    expect(await onboarding.restore()).toBe(false);
    expect(onboarding.state().step).toBe("choose");
  });

  it("本机存的值坏了 ⇒ 当「没有」处理（让用户重新导入，而不是在派生时炸）", async () => {
    const store = createMemoryKeyStore();
    // 绕过 `save` 的校验直接塞一个坏值（模拟磁盘被手工改过）。
    const broken = { ...store, load: async () => "被手工改坏的内容" } as AccountKeyStore;
    const { onboarding } = make({ store: broken });
    expect(await onboarding.restore()).toBe(false);
    expect(onboarding.state().step).toBe("choose");
  });
});

describe("重置", () => {
  it("`reset()` 回到起点，并**清掉内存里的明文密钥**", async () => {
    const { onboarding } = make();
    onboarding.generate();
    expect(onboarding.state().pendingKeyText).not.toBeNull();
    onboarding.reset();
    const state = onboarding.state();
    expect(state.step).toBe("choose");
    expect(state.accountId).toBeNull();
    expect(state.pendingKeyText).toBeNull();
    expect(state.savedConfirmed).toBe(false);
    expect(state.error).toBeNull();
  });
});

/* ============================================================================
   存储说明直接来自 keys.ts
   ============================================================================ */

describe("存储说明不许在 UI 层自己编", () => {
  it("`state().storage` 就是 `keys.ts` 的说法（网页端必须带 XSS 警告）", () => {
    const webStore: AccountKeyStore = {
      host: "browser-local-storage",
      readableByPageScript: true,
      load: async () => null,
      save: async () => undefined,
      clear: async () => undefined,
    };
    const { onboarding } = make({ store: webStore });
    const storage = onboarding.state().storage;
    expect(storage.risk).toContain("恶意脚本");
    // 桌面端则不该报一个它没有的风险。
    const desktop: AccountKeyStore = { ...webStore, host: "desktop-main", readableByPageScript: false };
    expect(make({ store: desktop }).onboarding.state().storage.risk).toBeNull();
    void vi;
  });
});
