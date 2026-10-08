/**
 * ③ 图片开关 · 结果组装单测（`lib/assets.js` 的 `collectImageAssetsFromPage`）。
 *
 * 背景：字节改由**页面侧**抓（`content/fetch-images.js`，0.4.0 修「勾了图片一起保存
 * 一张图都没落盘」），这里验的是**唯一组装产地**：形状、上限、逐条降级的警告文案。
 * 页面侧那份上限拷贝只是为了少传必拒的大 payload，**不作数** —— 这里全部重验。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { collectImageAssetsFromPage, rewriteRemoteImageRefs, MAX_ASSETS } from "../src/lib/assets.js";

/** 最小 PNG 头（嗅探只看前 16 字节）。 */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const ok = (url, bytes = PNG) => ({ url, ok: true, base64: b64(bytes), byteLength: bytes.length, mime: "image/png" });
const item = (url) => ({ url });

test("成功组装：ok 结果 → 02 §2.5 形状的资产，计数如实", () => {
  const out = collectImageAssetsFromPage([item("https://a.test/pic.png")], [ok("https://a.test/pic.png")]);
  assert.equal(out.downloaded, 1);
  assert.equal(out.failed, 0);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.assets.length, 1);
  assert.equal(out.assets[0].name, "pic.png");
  assert.equal(out.assets[0].mime, "image/png");
  assert.equal(out.assets[0].dataBase64, b64(PNG));
});

test("失败降级：页面报错的那张不进 assets，原因与 URL 进 warnings", () => {
  const url = "https://cdn.example.org/x.png";
  const out = collectImageAssetsFromPage(
    [item(url)],
    [{ url, ok: false, error: "没有权限、跨站限制或网络不可达" }],
  );
  assert.equal(out.assets.length, 0);
  assert.equal(out.failed, 1);
  assert.equal(out.warnings.length, 1);
  assert.ok(out.warnings[0].includes("没有权限、跨站限制或网络不可达"));
  assert.ok(out.warnings[0].includes(url));
});

test("缺结果：页面没有返回这张图 → 如实说，不当成成功", () => {
  const out = collectImageAssetsFromPage([item("https://a.test/a.png")], []);
  assert.equal(out.downloaded, 0);
  assert.equal(out.failed, 1);
  assert.ok(out.warnings[0].includes("页面没有返回这张图的结果"));
});

test("空字节：base64 解不出来 → 降级，不发必拒的形状", () => {
  const out = collectImageAssetsFromPage([item("https://a.test/a.png")], [
    { url: "https://a.test/a.png", ok: true, base64: "###不是base64###", byteLength: 10, mime: "image/png" },
  ]);
  assert.equal(out.assets.length, 0);
  assert.equal(out.failed, 1);
  assert.ok(out.warnings[0].includes("空文件"));
});

test("单件大小：超过 8 MiB 的在组装侧再次拦下（不信任页面侧预筛选）", () => {
  const big = new Uint8Array(8 * 1024 * 1024 + 1);
  const url = "https://a.test/big.png";
  const out = collectImageAssetsFromPage([item(url)], [ok(url, big)]);
  assert.equal(out.assets.length, 0);
  assert.ok(out.warnings[0].includes("超过 8 MiB"));
});

test("合计上限：第二张起放不下，逐条如实说", () => {
  const items = [item("https://a.test/1.png"), item("https://a.test/2.png")];
  const results = [ok("https://a.test/1.png"), ok("https://a.test/2.png")];
  const out = collectImageAssetsFromPage(items, results, { totalMaxBytes: PNG.length + 1 });
  assert.equal(out.downloaded, 1);
  assert.ok(out.warnings[0].includes("合计太大"));
  assert.ok(out.warnings[0].includes("https://a.test/2.png"));
});

test("件数上限：超过 32 张的部分计入 skipped，汇总一句（02 §2.2）", () => {
  const items = [];
  const results = [];
  for (let index = 0; index < MAX_ASSETS + 3; index += 1) {
    const url = `https://a.test/${index}.png`;
    items.push(item(url));
    results.push(ok(url));
  }
  const out = collectImageAssetsFromPage(items, results);
  assert.equal(out.downloaded, MAX_ASSETS);
  assert.equal(out.skipped, 3);
  assert.ok(out.warnings[0].includes(`只下载了前 ${MAX_ASSETS} 张图片`));
});

test("MIME 以本地重嗅为准：不信任页面自报的 mime", () => {
  const out = collectImageAssetsFromPage([item("https://a.test/pic.png")], [
    { url: "https://a.test/pic.png", ok: true, base64: b64(PNG), byteLength: PNG.length, mime: "text/html" },
  ]);
  assert.equal(out.assets[0].mime, "image/png");
});

test("urlNames：只收成功那批，且同 basename 的第二个改名（引用必须一一对应）", () => {
  const a = "https://cdn.a.test/photo.png";
  const b = "https://cdn.b.test/photo.png";
  const out = collectImageAssetsFromPage(
    [item(a), item(b), item("https://cdn.c.test/gone.png")],
    [ok(a), ok(b), { url: "https://cdn.c.test/gone.png", ok: false, error: "服务器返回 403" }],
  );
  assert.deepEqual(out.urlNames, [
    { url: a, name: "photo.png" },
    { url: b, name: "photo-2.png" },
  ]);
  assert.deepEqual(
    out.assets.map((asset) => asset.name),
    ["photo.png", "photo-2.png"],
  );
});

test("rewriteRemoteImageRefs：拿到字节的引用改写成 assets/<名>，没拿到的原样保留", () => {
  const body = [
    "![图一](https://cdn.a.test/photo.png)",
    "![图二](https://cdn.b.test/photo.png)",
    "![没拿到](https://cdn.c.test/gone.png)",
    "带空格的：![三](<https://cdn.d.test/a b.png>)",
  ].join("\n");
  const next = rewriteRemoteImageRefs(body, [
    { url: "https://cdn.a.test/photo.png", name: "photo.png" },
    { url: "https://cdn.b.test/photo.png", name: "photo-2.png" },
    { url: "https://cdn.d.test/a b.png", name: "a_b.png" },
  ]);
  assert.ok(next.includes("![图一](assets/photo.png)"), next);
  assert.ok(next.includes("![图二](assets/photo-2.png)"), next);
  assert.ok(next.includes("![没拿到](https://cdn.c.test/gone.png)"), "没拿到字节的引用必须原样保留");
  assert.ok(next.includes("![三](assets/a_b.png)"), "尖括号写法也要改写");
  // 空映射：一个字符都不动
  assert.equal(rewriteRemoteImageRefs(body, []), body);
});
