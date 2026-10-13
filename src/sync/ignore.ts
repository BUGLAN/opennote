/**
 * 同步范围：**唯一**的忽略判定（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.11、红线 8）。
 *
 * ## 一条规则，两处使用
 *
 * ```
 *            ┌──────────────────────────────────┐
 *            │ shouldIgnore(relPath, isDir)     │  ← 纯函数，本文件
 *            └───────┬──────────────────┬───────┘
 *                    │                  │
 *        ① 扫描（collectLocalFiles）   ② watcher（electron/main.cjs 的 onChange）
 * ```
 *
 * 以前两张过滤表各写一份：扫描侧靠「点开头的路径一律跳过」（`isHiddenPath`）**碰巧**排除了
 * `.git/`，而 `node:fs` 退路 watcher 只过滤 `.opennote/` 与自写 —— `.git/` 与 `node_modules/`
 * 会一路打上来（`electron/main.cjs` 的 `onChange`）。现在两条路径都调这一个函数。
 *
 * ## 三个层次，优先级从高到低
 *
 * | 层 | 内容 | 能否被 `.gitignore` 取反 |
 * | --- | --- | --- |
 * | ① 内置忽略集（硬编码） | `.git/`、`node_modules/`、`dist/`、`release/`、`.opennote/`、`.DS_Store`、编辑器临时文件 | ❌ **永远不能** |
 * | ② `.gitignore`（**只读工作区根目录那一份**） | git 兼容语义（用 `ignore` 包，不自己写解析器） | —— |
 * | ③ 其余一切都同步 | 默认 | —— |
 *
 * **① 为什么必须不可取反**：如果用户在 `.gitignore` 里写 `!/.git/`（想「把 git 目录也同步」），
 * 必须被拒绝 —— 同步 `.git/` 会跨设备搬 `objects`/`index`，**把仓库搞坏**；
 * `.opennote/` 里有基线、密钥引用、历史，**绝不能跨端**。
 * 实现上就是：**先判内置集，命中直接返回，不再看 `.gitignore`**。
 *
 * ## 最关键的一条：**忽略 = 该路径在同步引擎里双向不存在**
 *
 * ```
 * ignored(path) ?  →  完全跳过：不 push、不 pull、不删除、不参与三方 diff
 *                  →  它既不算「本地删了」，也不算「远端有而本地没有」
 * ```
 *
 * 因为 `.gitignore` **自己不同步**，设备 A 可能忽略 `foo.md` 而设备 B 不忽略。
 * 若只做「不 push」：A 的扫描看不到 `foo.md` 但远端有 → 判「远端新增」拉下来 →
 * A 又忽略它 → 下次扫描还是看不到 → **再次拉取，死循环**。
 * 双向跳过则 A 彻底当它不存在，B 照常同步。
 *
 * ## v1 作用域：只读根目录那一份 `.gitignore`
 *
 * git 原生支持逐目录的嵌套 `.gitignore`；v1 **只支持根目录那一个**。嵌套要求遍历时逐目录
 * 解析，且用户很难预期「哪个规则在起作用」。**这是有意的收窄**，写进 UI/文档。
 * `.gitignore` 自身是隐藏文件，本来就不在同步范围里（见 `isHiddenPath` 的先例）。
 */

import ignore from "ignore";

/** `.gitignore` 在工作区里的固定位置。 */
export const GITIGNORE_FILE = ".gitignore";

/**
 * 内置忽略集：**目录名**（整棵子树都排除）。
 * 命中即排除，**不受 `.gitignore` 的 `!` 影响**。
 */
const BUILT_IN_DIRS: readonly string[] = [".git", "node_modules", "dist", "release", ".opennote"];

/**
 * 内置忽略集：**精确文件名**。
 *
 * ⚠️ `.gitignore` 在列表里是**必须的**，不是可有可无的。§3.11 第 843 行：
 * 「`.gitignore` **本身不会同步**（它是隐藏文件，本来就被排除）」——
 * 而本文件第 38 行的注释也依赖这条（「因为 `.gitignore` 自己不同步，
 * 设备 A 可能忽略 `foo.md` 而设备 B 不忽略」）。
 *
 * ## 这里曾经漏了它（一个「两张过滤表合一」时丢掉的排除）
 *
 * 文件头的注释记着：以前扫描侧靠「点开头的路径一律跳过」（`isHiddenPath`）
 * **碰巧**排除了 `.gitignore`；合并成 `shouldIgnore()` 一个入口之后，
 * 隐藏文件规则没有跟着过来，而内置列表里又没有 `.gitignore` ——
 * 于是它**开始被同步**了。
 *
 * 症状很隐蔽：`.gitignore` 被推到远端、再被拉到另一台设备上，
 * 于是**那台设备的同步范围被静默改掉**（§3.11 第 865 行把「改 `.gitignore`」
 * 称作「改变同步范围的严肃操作」）。没有任何报错。
 *
 * 是 `workspaceFiles.test.ts` 的一条用例（断言 `.gitignore` 不进 `listLocal`）
 * 把它抓出来的 —— 那条用例我一开始还以为是自己写错了。
 */
const BUILT_IN_FILES: readonly string[] = [".gitignore", ".DS_Store", "Thumbs.db"];

/**
 * 内置忽略集：**文件名后缀**（编辑器临时文件）。
 * 与 §3.11 列出的 `*.swp`、`*~`、`.#*`、`*.tmp` 一一对应。
 */
const BUILT_IN_SUFFIXES: readonly string[] = [".swp", "~", ".tmp"];

/** `.gitignore` 里的行按「最长匹配优先」的直觉处理交给 `ignore` 包 —— 这里只负责喂给它。 */
export interface IgnoreRules {
  /** 内置集 + `.gitignore` 合并后的判定（**同步层唯一入口**）。 */
  shouldIgnore(relPath: string, isDir?: boolean): boolean;
  /** 只看内置集（诊断用：分清「内置排除了」还是「.gitignore 排除了」）。 */
  isBuiltInIgnored(relPath: string, isDir?: boolean): boolean;
  /** 根 `.gitignore` 的原始文本（没有就是 `""`）。 */
  gitignoreSource(): string;
}

/** 路径按 `/` 切开后的段（丢弃空段与 `.`；不做任何解码）。 */
function segments(relPath: string): string[] {
  return String(relPath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * 内置集的判定。
 *
 * **按「路径段」匹配目录名**，所以：
 *   - `.opennote/sync.json` → 命中（`.opennote` 是其中一段）；
 *   - `notes/.opennote.md`  → **不命中**（那一段是 `.opennote.md`，不是 `.opennote`）；
 *   - `a..b.md`             → **不命中**（不能用 `indexOf('..')` 这类粗暴判断）。
 */
function builtInIgnored(relPath: string, isDir: boolean): boolean {
  const raw = String(relPath ?? "").replace(/\\/g, "/");
  // 尾斜杠是「这是目录」的显式写法（gitignore 用它，调用方也常用）：`built/`、`.git/`。
  const trailingSlash = raw.endsWith("/");
  const parts = segments(raw);
  if (parts.length === 0) return false;
  const dirish = isDir || trailingSlash;
  for (let index = 0; index < parts.length; index += 1) {
    const segment = parts[index]!;
    // 最后一段若是**目录**，同样按目录名判；若是文件，只看文件名规则。
    const isLast = index === parts.length - 1;
    const treatAsDir = !isLast || dirish;
    if (treatAsDir && BUILT_IN_DIRS.includes(segment)) return true;
    if (isLast && !treatAsDir && BUILT_IN_FILES.includes(segment)) return true;
    if (isLast && !treatAsDir && BUILT_IN_SUFFIXES.some((suffix) => segment.endsWith(suffix))) return true;
  }
  // 目录路径本身以 `/` 结尾、或被显式标为目录时，最后一段也要按目录规则再看一次。
  if (dirish && BUILT_IN_FILES.includes(parts[parts.length - 1]!)) return true;
  return false;
}

/**
 * 造一份判定器。`gitignoreText` 是**工作区根目录** `.gitignore` 的内容（没有就传 `""`）。
 *
 * 解析失败（罕见：`.gitignore` 里有 `ignore` 包不接受的行）时**降级为「没有 .gitignore」**
 * 并让调用方知道 —— 绝不因为一份坏文件把同步范围静默改大或改小。
 */
export function createIgnoreRules(gitignoreText = ""): IgnoreRules {
  let matcher: ignore.Ignore | null = null;
  const source = String(gitignoreText ?? "");
  if (source.trim().length > 0) {
    try {
      // `ignore()` 默认就是 gitignore 语义；显式传空 base 表示「相对工作区根」。
      matcher = ignore().add(source);
    } catch {
      matcher = null;
    }
  }

  const shouldIgnore = (relPath: string, isDir = false): boolean => {
    const raw = String(relPath ?? "");
    const dirish = isDir || raw.replace(/\\/g, "/").endsWith("/");
    if (builtInIgnored(raw, dirish)) return true;
    if (!matcher) return false;
    const parts = segments(raw);
    if (parts.length === 0) return false;
    const relative = parts.join("/");
    // `ignore` 的目录判定要求路径带尾斜杠，否则 `build/` 这类规则匹配不到 `build`。
    const candidate = dirish ? `${relative}/` : relative;
    return matcher.ignores(candidate);
  };

  return {
    shouldIgnore,
    isBuiltInIgnored: builtInIgnored,
    gitignoreSource: () => source,
  };
}

/**
 * 一份「什么都不同步」之外的默认判定器：没有 `.gitignore` 时只有内置集生效。
 *
 * 给不需要读盘的调用方（主进程 watcher 在启动早期、测试）用。
 */
export function createDefaultIgnoreRules(): IgnoreRules {
  return createIgnoreRules("");
}

/**
 * 扫描 `list()` 结果的**统一过滤入口**（扫描侧与 watcher 侧都该走它）。
 *
 * 返回 `true` = 这个条目在同步引擎里**双向不存在**（不 push / 不 pull / 不删 / 不进 diff）。
 */
export function shouldSkipEntry(rules: IgnoreRules, relPath: string, isDir: boolean): boolean {
  return rules.shouldIgnore(relPath, isDir);
}
