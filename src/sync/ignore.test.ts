/**
 * 忽略规则（§3.11、红线 8）——**扫描与 watcher 共用同一个判定函数**。
 *
 * 来源：`docs/执行-三端同步-密钥即身份-2026-10-13.md` §10.1 E（G1–G12）与 §3.11 的「误伤与边界」表。
 *
 * 这里钉住三件事：
 *   1. **内置集不可被 `.gitignore` 取反**（G4/G5）——`!/.git/` 必须无效；
 *   2. `.gitignore` **按 git 语义**处理（G9 行首斜杠、G10 `**`、G11 目录内 re-include）——
 *      靠 `ignore` 包，不自己写解析器；
 *   3. **误伤**不许发生（G6 `a..b.md`、G7 `notes/.opennote.md`）。
 */
import { describe, expect, it } from "vitest";
import { createIgnoreRules } from "./ignore";

/** 断言「这条路径被忽略」。`isDir` 缺省时按文件判（目录要显式说，或写尾斜杠）。 */
function ignored(gitignore: string, path: string, isDir = false): boolean {
  return createIgnoreRules(gitignore).shouldIgnore(path, isDir);
}

describe("内置忽略集（不可被 .gitignore 取反）", () => {
  it("G1 · .git/ 内部一律忽略（扫描与 watcher 都走这一条）", () => {
    expect(ignored("", ".git/config")).toBe(true);
    expect(ignored("", ".git/objects/ab/cdef")).toBe(true);
    expect(ignored("", ".git", true)).toBe(true);
    expect(ignored("", ".git/")).toBe(true);
  });

  it("G2 · node_modules / dist / release 整棵子树忽略", () => {
    expect(ignored("", "node_modules/x/y.js")).toBe(true);
    expect(ignored("", "dist/a.js")).toBe(true);
    expect(ignored("", "release/b.zip")).toBe(true);
    // 子目录里的同名目录也算（不是只认根目录那一个）。
    expect(ignored("", "src/node_modules/dep/index.js")).toBe(true);
  });

  it("G3 · .opennote/ 一律忽略（红线：基线/历史/回收站绝不跨端）", () => {
    expect(ignored("", ".opennote/sync.json")).toBe(true);
    expect(ignored("", ".opennote/history/笔记/2026-01-01-abcd.md")).toBe(true);
    expect(ignored("", ".opennote/trash/旧笔记.md")).toBe(true);
  });

  it("编辑器临时文件与系统垃圾文件", () => {
    expect(ignored("", "notes/草稿.md.swp")).toBe(true);
    expect(ignored("", "notes/草稿.md~")).toBe(true);
    expect(ignored("", "notes/草稿.md.tmp")).toBe(true);
    expect(ignored("", ".DS_Store")).toBe(true);
    expect(ignored("", "notes/Thumbs.db")).toBe(true);
  });

  it("G4 · .gitignore 写 !/.git/ 仍然忽略", () => {
    expect(ignored("!/.git/\n", ".git/config")).toBe(true);
    expect(ignored("!.git/**\n", ".git/objects/ab/cd")).toBe(true);
    expect(ignored("!.git\n", ".git", true)).toBe(true);
  });

  it("G5 · .gitignore 写 !.opennote/ 仍然忽略", () => {
    expect(ignored("!.opennote/\n", ".opennote/sync.json")).toBe(true);
    expect(ignored("!.opennote/**\n", ".opennote/history/x.md")).toBe(true);
  });
});

describe("误伤与边界（不许发生）", () => {
  it("G6 · a..b.md 不忽略（不能用 indexOf('..') 这类粗暴判断）", () => {
    expect(ignored("", "a..b.md")).toBe(false);
    expect(ignored("", "notes/a..b.md")).toBe(false);
    expect(ignored("", "..md")).toBe(false);
  });

  it("G7 · notes/.opennote.md 不忽略（.opennote 是目录名，不是文件名前缀）", () => {
    expect(ignored("", "notes/.opennote.md")).toBe(false);
    expect(ignored("", ".opennote.md")).toBe(false);
    // 反例：真正的 .opennote 目录仍然被忽略。
    expect(ignored("", ".opennote/notes.md")).toBe(true);
  });

  it("普通笔记一律同步", () => {
    expect(ignored("", "notes/读书笔记.md")).toBe(false);
    expect(ignored("", "assets/图片.png")).toBe(false);
    expect(ignored("", "日记/2026-10-13.md")).toBe(false);
  });
});

describe(".gitignore 语义（git 兼容）", () => {
  it("G8 · *.log 让已有文件从同步范围消失（不 push / 不 pull / 不删）", () => {
    const rules = createIgnoreRules("*.log\n");
    expect(rules.shouldIgnore("debug.log")).toBe(true);
    expect(rules.shouldIgnore("logs/deep/debug.log")).toBe(true);
    // 只影响被忽略的那一类，别的照旧。
    expect(rules.shouldIgnore("debug.md")).toBe(false);
  });

  it("G9 · 行首斜杠锚定根目录：/build/ 只匹配根 build/", () => {
    const rules = createIgnoreRules("/build/\n");
    expect(rules.shouldIgnore("build/a.js")).toBe(true);
    expect(rules.shouldIgnore("build", true)).toBe(true);
    // src/build/ 不匹配 —— 这是「行首斜杠」的全部意义。
    expect(rules.shouldIgnore("src/build/a.js")).toBe(false);
  });

  it("G10 · ** 跨目录匹配：docs/**/tmp", () => {
    const rules = createIgnoreRules("docs/**/tmp\n");
    expect(rules.shouldIgnore("docs/tmp")).toBe(true);
    expect(rules.shouldIgnore("docs/a/b/tmp")).toBe(true);
    // 不在 docs/ 下面的同名目录不受影响。
    expect(rules.shouldIgnore("src/tmp")).toBe(false);
  });

  it("G11 · 目录被忽略、内部用 ! 重新包含：按 git 语义（与 git check-ignore 对齐）", () => {
    // git 的前提：父目录本身没被排除时，! 才能把里面的文件捞回来。
    const rules = createIgnoreRules("logs/\n!logs/keep.md\n");
    expect(rules.shouldIgnore("logs/drop.md")).toBe(true);
    // ⚠️ git 的真实行为：父目录 logs/ 被排除 ⇒ 里面的 !logs/keep.md **不生效**。
    // 这条断言就是「用官方语义实现、不自己猜」的证据。
    expect(rules.shouldIgnore("logs/keep.md")).toBe(true);
  });

  it("re-include 在父目录未被排除时生效", () => {
    const rules = createIgnoreRules("*.log\n!important.log\n");
    expect(rules.shouldIgnore("debug.log")).toBe(true);
    expect(rules.shouldIgnore("important.log")).toBe(false);
  });

  it("注释与空行不参与匹配", () => {
    const rules = createIgnoreRules("# 这是注释\n\n*.bak\n");
    expect(rules.shouldIgnore("note.bak")).toBe(true);
    expect(rules.shouldIgnore("这是注释")).toBe(false);
  });

  it("没有 .gitignore（空串 / 空白）时只有内置集生效", () => {
    expect(ignored("", "debug.log")).toBe(false);
    expect(ignored("   \n\n", "debug.log")).toBe(false);
    expect(ignored("   \n\n", ".git/config")).toBe(true);
  });
});

describe("U28 · 与 git check-ignore 实测输出逐条对齐", () => {
  /*
   * 权威来源：真跑 `git check-ignore`（同一个 `.gitignore`，同一个路径清单）得到的输出。
   * 夹具与判据一一对应 —— 这就是「用官方语义的现成实现、不自己猜」的证据。
   */
  const GITIGNORE = "logs/\n!logs/keep.md\n*.log\n!important.log\n/build/\ndocs/**/tmp\n";
  const GIT_SAYS: [path: string, ignoredByGit: boolean][] = [
    ["logs/drop.md", true],
    // ⚠️ git 的真实行为：父目录 logs/ 被排除 ⇒ 里面的 !logs/keep.md 不生效。
    ["logs/keep.md", true],
    ["src/build/a.js", false],
    ["build/a.js", true],
    ["docs/a/b/tmp", true],
    ["src/tmp", false],
    ["debug.log", true],
    ["important.log", false],
    ["a..b.md", false],
    ["notes/x.md", false],
  ];

  it("同一份 .gitignore 下，每条路径的判定与 git 一致", () => {
    const rules = createIgnoreRules(GITIGNORE);
    const ours = GIT_SAYS.map(([path]) => [path, rules.shouldIgnore(path)] as const);
    expect(ours).toEqual(GIT_SAYS);
  });

  it("内置集比 git 更严格：git 不忽略 .git/，我们必须忽略", () => {
    // git 本来就不会把 .git/ 列进工作树，所以 check-ignore 对它没意义；
    // 我们的同步范围必须**显式**排除它（否则跨设备搬 objects/index 会搞坏仓库）。
    const rules = createIgnoreRules(GITIGNORE);
    expect(rules.isBuiltInIgnored(".git/config")).toBe(true);
    expect(rules.isBuiltInIgnored("node_modules/x.js")).toBe(true);
    expect(rules.isBuiltInIgnored(".opennote/sync.json")).toBe(true);
    // 而这些**不是**内置的 —— 它们只由 .gitignore 决定。
    expect(rules.isBuiltInIgnored("build/a.js")).toBe(false);
    expect(rules.isBuiltInIgnored("debug.log")).toBe(false);
  });
});

describe("G12 · 扫描与 watcher 判定一致性", () => {
  it("对同一批路径，两次独立调用 shouldIgnore() 的结果逐条相同", () => {
    const gitignore = "*.log\n/build/\ndocs/**/tmp\n!important.log\n";
    // 两个入口各自造一份判定器（真实世界里一个是渲染层、一个是主进程），结果必须一模一样。
    const scanSide = createIgnoreRules(gitignore);
    const watcherSide = createIgnoreRules(gitignore);
    const cases: [string, boolean][] = [
      ["debug.log", false],
      ["important.log", false],
      ["build/a.js", false],
      ["src/build/a.js", false],
      ["docs/a/tmp", false],
      [".git/config", false],
      [".opennote/sync.json", false],
      ["node_modules/x.js", false],
      ["笔记/a.md", false],
      ["a..b.md", false],
    ];
    for (const [path, isDir] of cases) {
      expect(scanSide.shouldIgnore(path, isDir)).toBe(watcherSide.shouldIgnore(path, isDir));
    }
    // 并且这批里确实既有「忽略」也有「放行」，否则一致性断言是空的。
    const verdicts = cases.map(([path, isDir]) => scanSide.shouldIgnore(path, isDir));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });
});
