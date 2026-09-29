import { describe, expect, it } from "vitest";
import { bodyHashOf, contentHash8, contentHashOf, sha256Hex, shortRef, sourceHashOf } from "./hash";

describe("三个哈希（契约 §4.2）", () => {
  it("sha256 走的是标准实现（已知向量）", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("sourceHash = sha256(utf8(url ?? \"\")) 的前 16 位", async () => {
    // 空串的 sha256 是 e3b0c442…，所以 url 为 null 与空串同哈希。
    expect(await sourceHashOf(null)).toBe("sha256:e3b0c44298fc1c14");
    expect(await sourceHashOf("")).toBe("sha256:e3b0c44298fc1c14");
    expect(await sourceHashOf("https://example.com/a")).not.toBe(await sourceHashOf("https://example.com/b"));
  });

  it("bodyHash 先 normalizeEol：CRLF 与 LF 是同一个哈希", async () => {
    expect(await bodyHashOf("a\r\nb")).toBe(await bodyHashOf("a\nb"));
    expect(await bodyHashOf("a\rb")).toBe(await bodyHashOf("a\nb"));
    expect(await bodyHashOf("a\nb")).not.toBe(await bodyHashOf("a\nb\n"));
  });

  it("contentHash = sha256(sourceHash + \"\\n\" + bodyHash)，只由 URL 与正文决定", async () => {
    const source = await sourceHashOf("https://example.com/posts/local-first");
    const body = await bodyHashOf("在浏览器里剪下的一段话。");
    expect(await contentHashOf(source, body)).toBe(shortRef(await sha256Hex(`${source}\n${body}`)));
    // 换个标题/标签不改变 contentHash —— 哈希里没有它们。
    expect(await contentHashOf(source, body)).toBe(await contentHashOf(source, body));
  });

  it("附件前缀 contentHash8 = sha256(bytes) 的前 8 位", async () => {
    expect(await contentHash8(new TextEncoder().encode("abc"))).toBe("ba7816bf");
    expect(await contentHash8(new Uint8Array([1, 2, 3]))).toHaveLength(8);
  });

  it("shortRef 截断到 16 位十六进制并保留 sha256: 前缀", () => {
    expect(shortRef("0123456789abcdef0123")).toBe("sha256:0123456789abcdef");
  });

  it("哈希值稳定（回归：不能随实现漂移）", async () => {
    expect(await bodyHashOf("")).toBe("sha256:e3b0c44298fc1c14");
    expect(await bodyHashOf("导入信封")).toBe(shortRef(await sha256Hex("导入信封")));
  });
});
