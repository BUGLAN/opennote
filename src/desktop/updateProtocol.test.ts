import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 覆盖脚本（`electron/update-helper.cjs`）与主进程协议（`electron/update.cjs` 的 PROTOCOL）
 * 的**逐字咬合**，加上覆盖动作本身的真跑（注入 `launch`，不真的拉起应用）。
 *
 * 为什么需要咬合：helper 是**独立运行**的（`ELECTRON_RUN_AS_NODE` 下 asar 支持关闭），
 * 它 require 不到 `update.cjs`，所以握手/回执的字段名必然是**第二产地**。
 * 这类「看着一样」的漂移只有逐字比对能抓住 —— 与 `errorTable.test.ts` 同一范式。
 */
const requireCjs = createRequire(import.meta.url);
const protocol = (requireCjs("../../electron/update.cjs") as { PROTOCOL: Record<string, unknown> }).PROTOCOL;
const helper = requireCjs("../../electron/update-helper.cjs") as {
  HANDOFF_ENV: string;
  HANDOFF_KEYS: string[];
  RESULT_KEYS: string[];
  HELPER_NAME: string;
  READY_MARKER: string;
  APPLYING_MARKER: string;
  RESULT_FILE: string;
  EXE_NAME: string;
  BACKUP_SUFFIX: string;
  collectFiles: (root: string, relative?: string) => string[];
  rankOf: (relative: string, exeName?: string) => number;
  sortForApply: (files: string[], exeName?: string) => string[];
  runUpdate: (
    handoff: Record<string, unknown>,
    deps?: Record<string, unknown>,
  ) => Promise<{ ok: boolean; error: string | null }>;
};

const tempDirs: string[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opennote-helper-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("helper ↔ 主进程协议逐字一致", () => {
  it("握手字段名集合两边完全相同", () => {
    expect([...helper.HANDOFF_KEYS].sort()).toEqual([...(protocol.handoffKeys as string[])].sort());
  });

  it("回执字段名集合两边完全相同", () => {
    expect([...helper.RESULT_KEYS].sort()).toEqual([...(protocol.resultKeys as string[])].sort());
  });

  it("环境变量名、helper 文件名、标记名、exe 名逐字一致", () => {
    expect(helper.HANDOFF_ENV).toBe(protocol.handoffEnv);
    expect(helper.HELPER_NAME).toBe(protocol.helperName);
    expect(helper.READY_MARKER).toBe(protocol.readyMarker);
    expect(helper.APPLYING_MARKER).toBe(protocol.applyingMarker);
    expect(helper.RESULT_FILE).toBe(protocol.resultFile);
    expect(helper.EXE_NAME).toBe(protocol.exeName);
  });
});

describe("覆盖顺序", () => {
  it("exe 最后、app.asar 倒数第二（中途断电也不会留下半截应用）", () => {
    expect(helper.rankOf("Opennote.exe")).toBe(2);
    expect(helper.rankOf("resources/app.asar")).toBe(1);
    expect(helper.rankOf("locales/zh-CN.pak")).toBe(0);
    const sorted = helper.sortForApply([
      "Opennote.exe",
      "locales/zh-CN.pak",
      "resources/app.asar",
      "icudtl.dat",
    ]);
    expect(sorted.at(-1)).toBe("Opennote.exe");
    expect(sorted.at(-2)).toBe("resources/app.asar");
  });

  it("collectFiles 递归收集文件并跳过 helper 自己", () => {
    const root = tempDir("collect");
    fs.mkdirSync(path.join(root, "resources"), { recursive: true });
    fs.writeFileSync(path.join(root, "Opennote.exe"), "exe", "utf8");
    fs.writeFileSync(path.join(root, "resources", "app.asar"), "asar", "utf8");
    fs.writeFileSync(path.join(root, helper.HELPER_NAME), "helper", "utf8");
    const files = helper.collectFiles(root).sort();
    expect(files).toEqual(["Opennote.exe", "resources/app.asar"]);
  });
});

describe("runUpdate 真跑一遍覆盖", () => {
  function setup(): { handoff: Record<string, unknown>; installDir: string; stagingDir: string; updatesDir: string } {
    const installDir = tempDir("install");
    const stagingDir = tempDir("staging");
    const updatesDir = tempDir("updates");
    fs.mkdirSync(path.join(stagingDir, "resources"), { recursive: true });
    fs.mkdirSync(path.join(stagingDir, "locales"), { recursive: true });
    fs.writeFileSync(path.join(stagingDir, "Opennote.exe"), "NEW-EXE", "utf8");
    fs.writeFileSync(path.join(stagingDir, "resources", "app.asar"), "NEW-ASAR", "utf8");
    fs.writeFileSync(path.join(stagingDir, "locales", "zh-CN.pak"), "NEW-PAK", "utf8");
    fs.writeFileSync(path.join(stagingDir, helper.HELPER_NAME), "HELPER", "utf8");
    fs.writeFileSync(path.join(stagingDir, helper.APPLYING_MARKER), "{}", "utf8");
    fs.writeFileSync(path.join(stagingDir, helper.READY_MARKER), "{}", "utf8");

    fs.mkdirSync(path.join(installDir, "resources"), { recursive: true });
    fs.writeFileSync(path.join(installDir, "Opennote.exe"), "OLD-EXE", "utf8");
    fs.writeFileSync(path.join(installDir, "resources", "app.asar"), "OLD-ASAR", "utf8");
    fs.writeFileSync(path.join(installDir, `${helper.EXE_NAME}${helper.BACKUP_SUFFIX}zzz`), "STALE-BACKUP", "utf8");

    return {
      installDir,
      stagingDir,
      updatesDir,
      handoff: {
        pid: 999999999, // 一定不存在 → 等待立刻返回
        installDir,
        stagingDir,
        exeName: helper.EXE_NAME,
        argv: ["--user-data-dir=C:\\tmp\\ud"],
        logPath: path.join(updatesDir, "apply.log"),
        version: "0.6.0",
        resultPath: path.join(updatesDir, helper.RESULT_FILE),
        from: "0.5.0",
      },
    };
  }

  it("等待旧进程 → 复制全部文件 → 启动新版本，并清掉旧备份与 applying 标记", async () => {
    const { handoff, installDir, stagingDir } = setup();
    const launched: { exe: string; argv: unknown }[] = [];
    const outcome = await helper.runUpdate(handoff, {
      launch: (exe: string, argv: unknown) => {
        launched.push({ exe, argv });
        return { unref() {} };
      },
      waitForExit: async () => true,
      log: () => {},
    });
    expect(outcome.ok).toBe(true);
    expect(fs.readFileSync(path.join(installDir, "Opennote.exe"), "utf8")).toBe("NEW-EXE");
    expect(fs.readFileSync(path.join(installDir, "resources", "app.asar"), "utf8")).toBe("NEW-ASAR");
    expect(fs.readFileSync(path.join(installDir, "locales", "zh-CN.pak"), "utf8")).toBe("NEW-PAK");
    // 被替换的旧文件改名成 .old-<ts> 备份；上一次留下的旧备份（.old-zzz）被清掉
    const topLevelBackups = fs.readdirSync(installDir).filter((name) => name.includes(helper.BACKUP_SUFFIX));
    expect(topLevelBackups).toHaveLength(1);
    expect(topLevelBackups[0]?.startsWith(`${helper.EXE_NAME}${helper.BACKUP_SUFFIX}`)).toBe(true);
    const nestedBackups = fs
      .readdirSync(path.join(installDir, "resources"))
      .filter((name) => name.includes(helper.BACKUP_SUFFIX));
    expect(nestedBackups).toHaveLength(1);
    expect(nestedBackups[0]?.startsWith(`app.asar${helper.BACKUP_SUFFIX}`)).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, helper.APPLYING_MARKER))).toBe(false);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.exe).toBe(path.join(installDir, helper.EXE_NAME));
    expect(launched[0]?.argv).toEqual(["--user-data-dir=C:\\tmp\\ud"]);
  });

  it("旧进程迟迟不退 → 放弃覆盖且一个文件都不动", async () => {
    const { handoff, installDir } = setup();
    const outcome = await helper.runUpdate(handoff, {
      launch: () => ({ unref() {} }),
      waitForExit: async () => false,
      log: () => {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("没有在 2 分钟内退出");
    expect(fs.readFileSync(path.join(installDir, "Opennote.exe"), "utf8")).toBe("OLD-EXE");
  });

  it("复制失败 → 如实报错（不假装成功），并保留 staging 供重试", async () => {    const { handoff, installDir, stagingDir } = setup();
    // 让目标目录建不出来：install 里 `locales` 是一个**文件**（不是目录）。
    fs.writeFileSync(path.join(installDir, "locales"), "not-a-directory", "utf8");
    const outcome = await helper.runUpdate(handoff, {
      launch: () => ({ unref() {} }),
      waitForExit: async () => true,
      attempts: 2,
      retryDelayMs: 1,
      log: () => {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("复制失败");
    expect(fs.existsSync(path.join(stagingDir, helper.APPLYING_MARKER))).toBe(true);
    expect(fs.existsSync(path.join(stagingDir, "resources", "app.asar"))).toBe(true);
    // 没被复制到的文件保持原样，exe 绝不能在失败路径上被换掉
    expect(fs.readFileSync(path.join(installDir, "Opennote.exe"), "utf8")).toBe("OLD-EXE");
  });

  it("启动新版本失败 → 如实报错（覆盖已完成但「没起来」不能被说成成功）", async () => {
    const { handoff, installDir } = setup();
    const outcome = await helper.runUpdate(handoff, {
      launch: async () => ({ ok: false, error: "启动新版本失败：ENOENT" }),
      waitForExit: async () => true,
      log: () => {},
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("ENOENT");
    // 文件已经覆盖（这一步无法回退），但结果必须如实说「没起来」
    expect(fs.readFileSync(path.join(installDir, "Opennote.exe"), "utf8")).toBe("NEW-EXE");
  });
});
