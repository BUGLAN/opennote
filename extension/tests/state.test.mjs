/**
 * 连接状态机与视图文案单测：证明「6 态可区分」是机械可验证的，而不是靠人工看。
 * 逐字文案基准：03 §UI-01「中文文案（逐字）」表 + docs/import/mockups/01-extension-popup.html。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { STATE, CHIP, chipFor, decideState, planFor, queuedChip, stateForCode } from "../src/lib/state.js";
import { userMessage } from "../src/lib/errors.js";

const hit = (port = 8787, health = { workspace: { open: true, name: "我的笔记" } }) => ({
  hit: { port, kind: "ok", http: 200, health },
  probes: [{ port, kind: "ok" }],
  listeners: [{ port, kind: "ok" }],
  sawListener: true,
  noWindow: false,
  originRejected: false,
  portBusy: false,
  scanned: 1,
});

const nothing = () => ({ hit: null, probes: [], listeners: [], sawListener: false, noWindow: false, originRejected: false, portBusy: false, scanned: 10 });

const noWindow = () => ({
  hit: null,
  probes: [{ port: 8787, kind: "error", code: "IMP-4006" }],
  listeners: [{ port: 8787, kind: "error", code: "IMP-4006" }],
  sawListener: true,
  noWindow: true,
  originRejected: false,
  portBusy: false,
  scanned: 1,
});

const foreign = () => ({
  hit: null,
  probes: [{ port: 8787, kind: "foreign" }],
  listeners: [{ port: 8787, kind: "foreign" }],
  sawListener: true,
  noWindow: false,
  originRejected: false,
  portBusy: false,
  scanned: 1,
});

const rejected = () => ({
  hit: null,
  probes: [{ port: 8787, kind: "error", code: "IMP-3001" }],
  listeners: [{ port: 8787, kind: "error", code: "IMP-3001" }],
  sawListener: true,
  noWindow: false,
  originRejected: true,
  portBusy: false,
  scanned: 1,
});

test("六态逐态判定：给定输入 → 状态 id + 芯片逐字文案", () => {
  const cases = [
    ["已连接", { probe: hit(), online: true, token: "opn_x" }, STATE.CONNECTED, "本地接口已开启", "is-on"],
    ["未开启导入接口", { probe: nothing(), online: true, token: null }, STATE.INTERFACE_OFF, "本地接口未开启", ""],
    ["Opennote 未运行", { probe: noWindow(), online: true, token: "opn_x" }, STATE.NOT_RUNNING, "Opennote 未运行", "is-error"],
    ["端口或 token 不匹配（端口）", { probe: foreign(), online: true, token: "opn_x" }, STATE.PORT_BUSY, "端口被占用", "is-error"],
    ["端口或 token 不匹配（令牌）", { probe: hit(), online: true, token: "opn_x", authCode: "IMP-2002" }, STATE.TOKEN_INVALID, "未连接", "is-error"],
    ["未配置令牌（来源不是扩展/本机程序）", { probe: rejected(), online: true, token: null }, STATE.NEEDS_PAIRING, "未配置令牌", ""],
    ["未配置令牌（桥通了但没令牌）", { probe: hit(), online: true, token: null }, STATE.NEEDS_PAIRING, "未配置令牌", ""],
    ["离线（有暂存）", { probe: nothing(), online: false, token: "opn_x", pendingCount: 3 }, STATE.QUEUED_OFFLINE, "离线，已暂存 3 条", "is-busy"],
    ["离线（无暂存）", { probe: hit(), online: false, token: "opn_x", pendingCount: 0 }, STATE.DEVICE_OFFLINE, "未连接", "is-error"],
  ];
  for (const [label, input, expectedState, expectedChip, expectedClass] of cases) {
    const state = decideState(input);
    assert.equal(state, expectedState, `${label} 判定错了`);
    const chip = chipFor(state, { pendingCount: input.pendingCount || 0 });
    assert.equal(chip.text, expectedChip, `${label} 芯片文案不符`);
    assert.equal(chip.cls, expectedClass, `${label} 芯片修饰类不符`);
  }
});

test("硬项：「Opennote 未运行」与「本地接口未开启」必须可区分（芯片 + 状态 + 文案都不同）", () => {
  const notRunning = decideState({ probe: noWindow(), online: true, token: "opn_x" });
  const interfaceOff = decideState({ probe: nothing(), online: true, token: "opn_x" });
  assert.notEqual(notRunning, interfaceOff);
  assert.notEqual(chipFor(notRunning).text, chipFor(interfaceOff).text);
  assert.equal(chipFor(notRunning).text, "Opennote 未运行");
  assert.equal(chipFor(interfaceOff).text, "本地接口未开启");
  assert.notEqual(planFor(notRunning).block.message, planFor(interfaceOff).block.message);
  assert.equal(planFor(notRunning).block.code, "IMP-4006");
  assert.equal(planFor(interfaceOff).block.code, "IMP-1001");
});

test("设备离线时绝不显示「已连接」", () => {
  for (const pending of [0, 5]) {
    const state = decideState({ probe: hit(), online: false, token: "opn_x", pendingCount: pending });
    assert.notEqual(state, STATE.CONNECTED);
    assert.notEqual(chipFor(state, { pendingCount: pending }).text, "本地接口已开启");
  }
});

test("芯片文案只允许出现契约/规范批准的那几条", () => {
  const approved = new Set([
    "正在连接本地接口…",
    "本地接口已开启",
    "本地接口未开启",
    "端口被占用",
    "未连接",
    "Opennote 未运行",
    "未配置令牌",
    "离线，已暂存 3 条",
  ]);
  for (const state of Object.values(STATE)) {
    const chip = chipFor(state, { pendingCount: 3 });
    if (!chip) continue;
    assert.ok(approved.has(chip.text), `未批准的芯片文案：${chip.text}`);
  }
  assert.equal(queuedChip(0).text, "离线，已暂存 0 条");
});

test("S9/S12/S6/S10/S11 的错误块文案逐字核对", () => {
  const interfaceOff = planFor(STATE.INTERFACE_OFF);
  assert.equal(
    interfaceOff.block.message,
    "本地接口未开启。打开桌面版 Opennote 的「设置 · 文件 · 导入与接口」，开启本地接口后重试。",
  );
  assert.equal(interfaceOff.block.next, "已保留你填的标题与标签。");
  assert.deepEqual(interfaceOff.actions.map((a) => a.label), ["重试", "打开 Opennote 设置"]);
  assert.equal(interfaceOff.primary.disabled, true);

  const notRunning = planFor(STATE.NOT_RUNNING);
  assert.equal(notRunning.block.message, "Opennote 没有在运行。请先打开 Opennote，再试一次。");
  assert.equal(notRunning.block.next, "连接被拒说明本机没有在监听，不是令牌问题。");
  assert.deepEqual(notRunning.actions.map((a) => a.label), ["重试", "先暂存这页"]);

  const tokenMissing = planFor(STATE.NEEDS_PAIRING);
  assert.equal(
    tokenMissing.block.message,
    // 00 §6.15㉞ 冻结（0.3.1：配对删除，改为「粘贴长期令牌」）
    "这个客户端还没有配置访问令牌。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。",
  );
  assert.equal(tokenMissing.tokenInput, true);
  assert.deepEqual(tokenMissing.actions.map((a) => a.label), ["打开 Opennote 设置"]);

  const tokenBad = planFor(STATE.TOKEN_INVALID);
  assert.equal(tokenBad.block.message, "访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。");
  assert.equal(tokenBad.tokenInput, true);

  const queued = planFor(STATE.QUEUED_OFFLINE, { pendingCount: 3 });
  assert.equal(queued.block.message, "Opennote 没有在运行，内容已暂存在插件里，打开 Opennote 后会自动补投。");
  assert.equal(queued.block.next, "打开 Opennote 后会自动补投。");
  assert.equal(queued.primary.label, "暂存在插件里");
  assert.equal(queued.primary.disabled, false);

  const busy = planFor(STATE.CHECKING);
  assert.equal(busy.primary.label, "正在读取页面…");
  assert.equal(busy.skeleton, true);
});

test("落点类错误不改变连接芯片（文件夹未授权 / 未打开笔记本）", () => {
  const folder = planFor(STATE.FOLDER_DENIED, { code: "IMP-4009" });
  assert.equal(folder.chip.text, "本地接口已开启");
  assert.equal(folder.chip.cls, "is-on");
  assert.equal(folder.block.message, "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。");
  const illegal = planFor(STATE.FOLDER_DENIED, { code: "IMP-4008" });
  assert.equal(illegal.block.message, "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。");
  assert.equal(illegal.chip.text, "本地接口已开启");

  const noWorkspace = planFor(STATE.NO_WORKSPACE);
  assert.equal(noWorkspace.chip.text, "本地接口已开启");
  assert.equal(noWorkspace.block.code, "IMP-4007");
  assert.equal(noWorkspace.block.message, "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。");
});

test("S5 受限页面与 S8 成功的文案逐字核对", () => {
  const restricted = planFor(STATE.RESTRICTED_PAGE);
  assert.equal(restricted.empty.title, "这个页面不允许插件读取内容。");
  assert.equal(restricted.empty.text, "换个普通网页再试。");
  assert.equal(restricted.segments, false);
  assert.equal(restricted.primary, null);

  const success = planFor(STATE.SUCCESS, { folderLabel: "读书笔记", noteTitle: "中文排版指北" });
  assert.equal(success.ok.message, "已剪藏到「读书笔记」。");
  assert.equal(success.ok.detail, "中文排版指北.md");
  assert.equal(success.chip.text, "本地接口已开启");
});

/*
 * 0.4.x 用户实测（原话：「这两个图片删除…底部恢复常态 [剪藏到 Opennote] 即可」）：
 * 成功 / 进收件箱两态的底栏曾经被 `plan.primary = null` 换成两颗 30px 图标按钮
 * （`打开这篇笔记` / `打开 Opennote` + `再剪一段`）—— 提示已经说清结果，用户要的是
 * **常态那颗主按钮**。下面两条分别咬住「主按钮回来了」与「图标动作真的没了」，
 * 回退任意一条都会变红。
 */
test("S8/S23：剪藏成功与进收件箱的底栏都是常态主按钮", () => {
  const success = planFor(STATE.SUCCESS, { folderLabel: "读书笔记", noteTitle: "中文排版指北" });
  const pending = planFor(STATE.INBOX_PENDING, { noteTitle: "中文排版指北" });
  for (const [name, plan] of [["S8", success], ["S23", pending]]) {
    assert.ok(plan.primary, `${name} 底栏必须有主按钮（不许是 null）`);
    assert.equal(plan.primary.label, "剪藏到 Opennote", `${name} 的底栏文案回到 C50`);
    assert.equal(plan.primary.disabled, false, `${name} 的主按钮必须可用（不是灰按钮）`);
    assert.deepEqual(plan.actions, [], `${name} 底栏不再有图标动作`);
  }
  assert.equal(pending.ok.message, "已进入收件箱等待确认：中文排版指北。");
});

test("错误块里出现的 message 一定来自错误码表（没有自造文案）", () => {
  const states = [
    STATE.INTERFACE_OFF,
    STATE.NOT_RUNNING,
    STATE.PORT_BUSY,
    STATE.NEEDS_PAIRING,
    STATE.TOKEN_INVALID,
    STATE.DEVICE_OFFLINE,
    STATE.NO_WORKSPACE,
    STATE.FOLDER_DENIED,
  ];
  for (const state of states) {
    const plan = planFor(state);
    assert.ok(plan.block, `${state} 缺少错误块`);
    const codes = [plan.block.code, plan.block.code === "IMP-4001" ? null : null].filter(Boolean);
    assert.ok(codes.length > 0, `${state} 缺少契约 code`);
    for (const code of codes) {
      const expected = userMessage(code);
      assert.ok(expected, `${code} 没有用户文案`);
      assert.equal(plan.block.message, expected, `${state} 的文案与错误码表不一致`);
    }
  }
});

test("stateForCode：提交失败后的状态落点符合 02 §6.2 的「客户端应如何反应」", () => {
  assert.equal(stateForCode("IMP-1001"), STATE.INTERFACE_OFF);
  assert.equal(stateForCode("IMP-1004"), STATE.INTERFACE_OFF);
  assert.equal(stateForCode("IMP-4006"), STATE.NOT_RUNNING);
  assert.equal(stateForCode("IMP-1003"), STATE.PORT_BUSY);
  assert.equal(stateForCode("IMP-2001"), STATE.NEEDS_PAIRING);
  assert.equal(stateForCode("IMP-3001"), STATE.NEEDS_PAIRING);
  assert.equal(stateForCode("IMP-2002"), STATE.TOKEN_INVALID);
  assert.equal(stateForCode("IMP-4007"), STATE.NO_WORKSPACE);
  assert.equal(stateForCode("IMP-4008"), STATE.FOLDER_DENIED);
  assert.equal(stateForCode("IMP-4009"), STATE.FOLDER_DENIED);
  // 其余（限流、内部错误…）保持「已连接」+ 独立错误块，不许降级成「未连接」
  assert.equal(stateForCode("IMP-4015"), STATE.CONNECTED);
  assert.equal(stateForCode("IMP-5001"), STATE.CONNECTED);
});

test("未知探测 → checking：未拿到探测结果时不能猜成已连接", () => {
  assert.equal(decideState({ probe: null, online: true, token: "opn_x" }), STATE.CHECKING);
  assert.equal(chipFor(STATE.CHECKING).text, "正在连接本地接口…");
});
