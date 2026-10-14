import { describe, expect, it } from "vitest";
import { entryOptions } from "./entryOptions";

/**
 * 三个「笔记本入口」的平台裁剪（2026-10-14 用户反馈）：
 *
 * 「桌面端打开的时候, 就不是浏览器了, 没必要显示这 3 个选项, 直接打开本地文件夹即可」
 * —— 欢迎页、侧栏笔记本菜单、命令面板三处原来各写一份判断，欢迎页那份漏了桌面分支，
 * 于是桌面上照样列出「新建浏览器笔记本 / 导入文件夹到浏览器」。这里守的是**一份**判断：
 * 桌面版只留「打开本机文件夹」，网页版三项齐全，手机壳两项浏览器选项照旧。
 */
describe("entryOptions", () => {
  it("桌面版：只留本机文件夹，浏览器那两条整项不出现", () => {
    expect(
      entryOptions({ desktop: true, localFolder: true, browserWorkspace: true }),
    ).toEqual({ localFolder: true, browserWorkspace: false, uploadFolder: false });
  });

  it("桌面版即使界面自己以为不支持本机文件夹，也绝不回头给浏览器选项", () => {
    expect(
      entryOptions({ desktop: true, localFolder: false, browserWorkspace: true }),
    ).toEqual({ localFolder: false, browserWorkspace: false, uploadFolder: false });
  });

  it("网页版（Chrome/Edge）：三项齐全", () => {
    expect(
      entryOptions({ desktop: false, localFolder: true, browserWorkspace: true }),
    ).toEqual({ localFolder: true, browserWorkspace: true, uploadFolder: true });
  });

  it("网页版没有 OPFS：浏览器笔记本不可用，导入文件夹仍可用", () => {
    expect(
      entryOptions({ desktop: false, localFolder: false, browserWorkspace: false }),
    ).toEqual({ localFolder: false, browserWorkspace: false, uploadFolder: true });
  });

  it("手机壳（desktop:false）保留两条浏览器选项：那是它把文件夹带进来的正经路径", () => {
    expect(
      entryOptions({ desktop: false, localFolder: true, browserWorkspace: true }),
    ).toEqual({ localFolder: true, browserWorkspace: true, uploadFolder: true });
  });
});
