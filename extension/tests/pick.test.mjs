/**
 * 元素选择失败原因（task-21）：四因分离的**单测**。
 *
 * 缺陷回顾：读不到 URL / 受限 scheme / 注入失败 / 抽取失败 四种原因共用一句
 * 「这个页面不能选择元素：只有普通网页（http 或 https）支持。」—— 用户实测在知乎普通 https
 * 文章上被这句假话误导，`chrome.scripting` 的真实错误被 popup 丢掉。
 *
 * 这里断言的四条，正好对应 Lead 要求「能独立红」的三条 + 一条抽取失败分离。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PICK_FAIL_COPY, PICK_FAIL_REASONS, pickFailCopy } from "../src/lib/pick.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (relative) => readFileSync(join(HERE, "..", "src", relative), "utf8");

test("task-21：四种失败原因各有文案，且互不相同", () => {
  assert.deepEqual([...PICK_FAIL_REASONS], ["no_url", "restricted_scheme", "injection_failed", "extraction_failed"]);
  const copies = PICK_FAIL_REASONS.map((reason) => PICK_FAIL_COPY[reason]);
  assert.equal(new Set(copies).size, 4, `四种原因必须四句不同的话，实际：${JSON.stringify(copies)}`);
  for (const copy of copies) assert.ok(copy.trim().length > 8, `文案太短：${copy}`);
});

test("task-21：「只有普通网页支持」只属于 restricted_scheme", () => {
  const scheme = PICK_FAIL_COPY.restricted_scheme;
  assert.match(scheme, /只有普通网页（http 或 https）支持/);
  for (const reason of ["no_url", "injection_failed", "extraction_failed"]) {
    assert.ok(
      !/普通网页|http 或 https/.test(PICK_FAIL_COPY[reason]),
      `${reason} 不得伪装成「页面类型不支持」：${PICK_FAIL_COPY[reason]}`,
    );
  }
});

test("task-21：no_url 给可执行的下一步，不报成页面类型不支持", () => {
  const copy = PICK_FAIL_COPY.no_url;
  assert.match(copy, /读不到这个标签页的地址/);
  assert.match(copy, /刷新|点一下扩展图标/);
  assert.ok(!/普通网页/.test(copy));
});

test("task-21：extraction_failed 与 injection_failed 是两句不同的话", () => {
  assert.notEqual(PICK_FAIL_COPY.extraction_failed, PICK_FAIL_COPY.injection_failed);
  assert.match(PICK_FAIL_COPY.extraction_failed, /没能从这个页面读到正文/);
  assert.match(PICK_FAIL_COPY.injection_failed, /注入失败/);
  assert.match(PICK_FAIL_COPY.injection_failed, /不是页面类型的问题/);
});

test("task-21：未知原因不静默（退回中性说明而不是假话）", () => {
  assert.equal(pickFailCopy(undefined), "没能进入元素选择模式。");
  assert.equal(pickFailCopy("whatever"), "没能进入元素选择模式。");
  assert.equal(pickFailCopy("no_url"), PICK_FAIL_COPY.no_url);
});

test("task-21：background 的 catch 必须回传真实原文并 console.warn，popup 必须透出 detail", () => {
  const background = src("background.js");
  assert.match(background, /reason: "injection_failed", detail/);
  assert.ok(background.includes("[opennote] 元素选择注入失败"), "注入失败必须 console.warn 出真实 error");
  assert.match(background, /describeError\(error\)/, "错误要整理成 name: message");
  const popup = src("popup/popup.js");
  assert.match(popup, /pickDetail\.textContent = .*reply\.detail/, "pickDetail 必须真的写入 reply.detail（不是空赋值）");
  assert.ok(
    !/pickNote\.textContent = "这个页面不能选择元素/.test(popup),
    "popup 不得再硬编码「这个页面不能选择元素…」当唯一失败文案",
  );
  assert.match(popup, /PICK_FAIL_COPY\[reason\]/);
  assert.ok(src("popup/popup.html").includes('id="pickDetail"'));
});

test("task-21：URL 读不到时照样尝试注入（no_url 只用于拿不到标签页）", () => {
  const background = src("background.js");
  // 受限 scheme 的判据必须要求「URL 读得到」
  assert.match(background, /if \(url && isRestrictedUrl\(url\)\)/);
  const pickBlock = background.slice(background.indexOf("async function startPick()"), background.indexOf("async function rememberPicked"));
  assert.match(pickBlock, /executeScript/, "startPick 里必须有 executeScript（唯一证据）");
  assert.ok(!/if \(isRestrictedUrl\(url\)\)/.test(pickBlock), "不得只凭 URL 预检就拒绝注入");
});

test("task-21：抽取失败记成 extractionFailed，不再合并进 restricted", () => {
  const background = src("background.js");
  assert.match(background, /snapshot\.extractionFailed = true/);
  assert.match(background, /extractionFailed: false, pickFailReason: null/);
  const popup = src("popup/popup.js");
  assert.match(popup, /extractionFailed && !snapshot\.restricted/);
});
