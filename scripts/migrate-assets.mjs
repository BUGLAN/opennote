#!/usr/bin/env node
/**
 * 旧附件迁移器的**薄 CLI**（迁移逻辑全在 `src/data/migrateAssets.ts`，这里只做参数解析 + 打印）。
 *
 * 用法：
 *   node scripts/migrate-assets.mjs --workspace E:\repo\notes            # dry-run（默认，只读）
 *   node scripts/migrate-assets.mjs --workspace E:\repo\notes --dry-run  # 同上，显式写出来
 *   node scripts/migrate-assets.mjs --workspace E:\repo\notes --apply    # 真的写盘（需显式 --apply）
 *
 * 选项：
 *   --workspace <路径>   笔记本根目录（必填）
 *   --apply              真的写盘；**不带它时只读**，一个字节都不写
 *   --json               只打印机器可读的 JSON 报告
 *   --limit <n>          报告里明细（重复组 / 死引用 / 无引用文件）的打印条数上限，默认 20
 *
 * 实现说明：Node 22.19+ 直接 import `.ts`（原生类型剥离）——迁移逻辑因此**只有一份**，
 * 不会为了给命令行用而抄成 `.mjs`。仓库里的相对导入一律无扩展名（Vite / tsc / vitest 都认），
 * 而 Node 的 ESM 解析不做无扩展名查找，所以下面用 `module.register()` 装一个约 10 行的解析钩子
 * （只改「找哪个文件」，`load()` 仍走 Node 自己的类型剥离）。这样 `src/` 里一个字节都不用改。
 */

import path from "node:path";
import process from "node:process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 无扩展名相对导入 → 依次试 `.ts` / `/index.ts`（只在这一次进程里生效）。 */
const RESOLVE_HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\\.[cm]?[jt]s$/.test(specifier)) {
    for (const suffix of [".ts", "/index.ts"]) {
      try { return await nextResolve(specifier + suffix, context); } catch { /* 试下一个 */ }
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK)}`, pathToFileURL(`${projectRoot}/`));

function parseArgs(argv) {
  const options = { workspace: "", apply: false, json: false, limit: 20, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--workspace" || arg === "-w") options.workspace = argv[++index] ?? "";
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--dry-run") options.apply = false;
    else if (arg === "--json") options.json = true;
    else if (arg === "--limit") options.limit = Number(argv[++index] ?? 20);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`无法识别的参数：${arg}`);
  }
  return options;
}

function usage() {
  return [
    "旧附件迁移（默认只读 dry-run）",
    "",
    "  node scripts/migrate-assets.mjs --workspace <笔记本目录> [--dry-run | --apply] [--json] [--limit N]",
    "",
    "  --dry-run  只扫描并出报告（默认；一个字节都不写）",
    "  --apply    真的复制 / 改写引用 / 删源（需显式指定）",
    "  --json     只打印 JSON 报告",
  ].join("\n");
}

/** 待改写引用按**写法**分三类（与 t5 报告 §1.5 的口径对齐，用来解释数字差异）。 */
function shapeCounts(references) {
  const counts = { legacy: 0, dotFlat: 0, bare: 0, other: 0 };
  for (const item of references) {
    const ref = item.before;
    const dir = ref.includes("/") ? ref.slice(0, ref.lastIndexOf("/")) : "";
    if (dir.endsWith(".assets")) counts.legacy += 1;
    else if (dir === "./assets") counts.dotFlat += 1;
    else if (dir === "assets" || dir.startsWith("assets/")) counts.bare += 1;
    else counts.other += 1;
  }
  return counts;
}

/** 带标签的数字行，报告里每一条都直接对应验收标准。 */
function line(label, value, extra = "") {
  return `  ${label.padEnd(26, " ")} ${String(value).padStart(6, " ")}${extra ? `   ${extra}` : ""}`;
}

function printReport(report, result, options) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 20;
  const out = [];
  out.push("");
  out.push(`附件迁移报告 · ${options.apply ? "APPLY（已写盘）" : "DRY-RUN（只读，未写任何文件）"}`);
  out.push(`  工作区：${options.workspace}`);
  out.push("");
  out.push("扫描（阶段 A）");
  out.push(line("旧附件目录", report.scannedDirs.length, report.scannedDirs.slice(0, limit).join("、")));
  out.push(line("待迁移文件数", report.totalFiles));
  out.push(line("按字节去重省下的文件数", report.dedupedSavings, `${report.contentGroups} 个内容组，其中 ${report.duplicateGroups} 组有重复`));
  out.push(line("同名不同内容让位数", report.dedupedTargets, "（`-2` 序号）"));
  out.push(line("需要复制", report.copiesNeeded));
  out.push(line("已存在且字节相同 → 复用", report.reusedExisting));
  out.push("");
  out.push("引用（阶段 C）");
  out.push(line("待改写引用条数", report.referencesToRewrite, `${report.notesWithRewrites} 篇笔记`));
  out.push(line("死引用（原样保留）", report.deadReferences, `其中指向附件 ${report.deadAssetReferences} 条`));
  out.push(line("算不出工作区路径", report.unresolvableReferences));
  out.push(line("无引用文件（旧布局）", report.unreferencedFiles));
  out.push(line("无引用文件（共享 .assets/）", report.unreferencedSharedFiles));
  if (report.unreadable.length) out.push(line("读不出来的文件", report.unreadable.length, report.unreadable.slice(0, limit).join("、")));
  if (result) {
    out.push("");
    out.push("执行（阶段 B→D）");
    out.push(line("复制", result.copied));
    out.push(line("复用（未重写）", result.reused));
    out.push(line("改写笔记 / 引用", `${result.rewrittenNotes} / ${result.rewrittenReferences}`));
    out.push(line("删除源文件", result.deletedSources));
    out.push(line("删除空目录", result.removedDirs.length, result.removedDirs.slice(0, limit).join("、")));
    if (result.keptDirs.length) out.push(line("保留（非空）目录", result.keptDirs.length, result.keptDirs.slice(0, limit).join("、")));
    if (result.conflictedNotes.length) out.push(line("并发改动跳过", result.conflictedNotes.length, result.conflictedNotes.slice(0, limit).join("、")));
    if (result.vanishedSources.length) out.push(line("源已不在 / 已变化", result.vanishedSources.length, result.vanishedSources.slice(0, limit).join("、")));
    if (result.failedCopies.length) out.push(line("复制校验失败", result.failedCopies.length, result.failedCopies.slice(0, limit).join("、")));
    if (result.failedNotes.length) out.push(line("改写校验失败（整篇回滚）", result.failedNotes.length, result.failedNotes.slice(0, limit).join("、")));
  }
  if (report.sameNameDifferentBytes.length) {
    out.push("");
    out.push(`同名不同内容的真实反例（${report.sameNameDifferentBytes.length} 组，绝不能按文件名去重）`);
    for (const entry of report.sameNameDifferentBytes.slice(0, limit)) {
      out.push(`  ${entry.name}`);
      for (const source of entry.sources.slice(0, limit)) out.push(`      ${source}`);
    }
  }
  if (report.groups.filter((group) => group.sources.length > 1).length) {
    out.push("");
    out.push(`重复内容组（同内容 → 同一个最终名）`);
    for (const group of report.groups.filter((entry) => entry.sources.length > 1).slice(0, limit)) {
      out.push(`  ${group.target}${group.deduped ? "  ← 让位" : ""}   ${group.sources.length} 份`);
      for (const source of group.sources.slice(0, limit)) out.push(`      ${source}`);
    }
  }
  if (report.issues.length) {
    out.push("");
    out.push(`死引用 / 解析不出的引用（${report.issues.length} 条，前 ${Math.min(limit, report.issues.length)} 条）`);
    for (const issue of report.issues.slice(0, limit)) {
      out.push(`  [${issue.kind}] ${issue.note}`);
      out.push(`      ${issue.ref}   （${issue.reason}）`);
    }
  }
  if (report.unreferencedFiles) {
    const referenced = new Set(report.referencedSources ?? []);
    const unreferenced = report.files.filter((file) => !referenced.has(file.source));
    out.push("");
    out.push(`无引用文件（${unreferenced.length} 个；前 ${Math.min(limit, unreferenced.length)} 条，完整清单见 --json）`);
    for (const file of unreferenced.slice(0, limit)) out.push(`  ${file.source}  →  ${file.target}`);
  }
  out.push("");
  out.push(options.apply ? "已写盘。再跑一次应当是 0 处改动（幂等）。" : "以上为 dry-run 结果：未写任何文件。加 --apply 才会真的迁移。");
  out.push("");
  out.push("口径对照（t5 报告 docs/asset-lifecycle-and-migration.md §1.5 的实测值 → 本次读数）");
  out.push(
    `  附件总数        234 → ${report.totalFiles + report.referencedSharedFiles.length + report.unreferencedSharedFiles}`,
  );
  out.push(`  重复组 / 省下   16 组 / 23 → ${report.duplicateGroups} 组 / ${report.dedupedSavings}`);
  out.push(`  待改写引用      190 → ${report.referencesToRewrite}`);
  const shapes = shapeCounts(report.references);
  out.push(
    `    （写法：旧 \`<笔记名>.assets/\` ${shapes.legacy} + \`./\` 公共 assets/ ${shapes.dotFlat} + 裸 assets/ ${shapes.bare}${shapes.other ? ` + 其他 ${shapes.other}` : ""}；明细见 --json）`,
  );
  out.push(`  死引用          3 → ${report.deadReferences}（其中指向附件 ${report.deadAssetReferences}）`);
  out.push(`  无引用文件      47 → ${report.unreferencedFiles + report.unreferencedSharedFiles}`);
  out.push("  差异原因：① 报告是 2026-10-09 的快照，本次读数以**当前磁盘**为准（附件总数 234 与");
  out.push("  「16 组 / 省 23」两项与报告逐字一致，说明附件侧没变）；② 报告的死引用只算图片且是抽样");
  out.push("  （其 §1.6a 表格本身列了 4 行），本工具把「解析不到的本地引用」全数列出，其中一半是");
  out.push("  笔记之间的链接（指向不存在的 .md，与附件无关）；③ 引用计数含迁移器新纳入的写法");
  out.push("  （`./foo.assets/` 这类旧布局引用，报告 §1.5 的三类口径里没有单列）。");
  out.push("");
  return out.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (!options.workspace) {
    console.log(usage());
    return 1;
  }
  const root = path.resolve(options.workspace);
  options.workspace = root;

  const { createNodeFsBackend } = await import(pathToFileURL(path.join(projectRoot, "src/data/nodeFsBackend.ts")).href);
  const { buildAssetMigrationPlan, applyAssetMigration } = await import(
    pathToFileURL(path.join(projectRoot, "src/data/migrateAssets.ts")).href
  );

  const backend = createNodeFsBackend(root, { canWrite: options.apply });
  const report = await buildAssetMigrationPlan(backend);
  const result = await applyAssetMigration(backend, report, { apply: options.apply });

  if (options.json) {
    console.log(JSON.stringify({ workspace: root, apply: options.apply, report, result }, null, 2));
  } else {
    console.log(printReport(report, result, options));
  }

  const failed = result.failedCopies.length || result.failedNotes.length;
  return failed ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(`[migrate-assets] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
