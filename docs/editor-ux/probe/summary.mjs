/**
 * Prints the headline numbers from `.tmp-verify/jump-probe/out/*.json`.
 *   node .tmp-verify/jump-probe/summary.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const out = (name) => {
  const p = join(HERE, "out", name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (error) {
    console.error(`[summary] ${name} 不是合法 JSON：${error.message}`);
    return null;
  }
};
const pad = (v, n = 9) => String(v ?? "-").padStart(n);

const A = out("A.json");
if (A) {
  console.log("=== A. 光标进出各块 → 块下方标记段落的纵向位移（px）===");
  console.log("  block          块内位移    scrollHeight 变化   滚动位置变化");
  for (const r of A) {
    console.log(`  ${r.id.padEnd(12)} ${pad(r.deltaMarkerTop)} ${pad(r.deltaContentScrollHeight, 18)} ${pad(r.deltaScrollTop, 14)}`);
  }
  console.log();
}

const B = out("B.json");
if (B) {
  console.log("=== B. 行内标记显隐 → 水平位移（px）===");
  console.log("  mark         元素 left 位移   文字起点 left 位移");
  for (const r of B) console.log(`  ${r.id.padEnd(12)} ${pad(r.deltaElementLeft)} ${pad(r.deltaCoordsLeft, 18)}`);
  console.log();
}

const C = out("C.json");
if (C) {
  console.log("=== C. 异步渲染完成前后的位移（px）===");
  for (const r of C) console.log(`  ${r.kind.padEnd(8)} delta=${pad(r.deltaMarkerTop)} settled=${r.settled} 首帧 loading=${r.t0.loading} 末帧 loading=${r.t1.loading}`);
  console.log();
}

const D = out("D.json");
if (D) {
  console.log("=== D. 视口滚动位置是否被保住 ===");
  for (const r of D) {
    console.log(`  ${r.name}`);
    console.log(`     滚动前 scrollTop=${pad(r.before.scrollTop, 8)} 标记在视口内 y=${pad(r.before.markerViewportTop, 8)} 锚点行=${r.before.internals?.anchorText ?? r.before.anchorLine}`);
    console.log(`     滚动后 scrollTop=${pad(r.after.scrollTop, 8)} 标记在视口内 y=${pad(r.after.markerViewportTop, 8)} 锚点行=${r.after.internals?.anchorText ?? r.after.anchorLine}`);
    console.log(`     ΔscrollTop=${pad(r.deltaScrollTop, 8)}  Δ标记视口位移=${pad(r.deltaMarkerViewportTop, 8)}  内容高度变化=${pad(r.deltaContentScrollHeight, 8)}  钉住了=${r.pinned}`);
  }
  console.log();
}

const E = out("E.json");
if (E) {
  console.log("=== E. display:none 隐藏行 ===");
  console.log(`  隐藏行数量 = ${E.hiddenLines?.length}`);
  for (const h of E.hiddenLines ?? []) {
    console.log(`    doc line ${h.docLine} ${JSON.stringify(h.lineText)} display=${h.display} offsetHeight=${h.offsetHeight} rect=${JSON.stringify(h.rect)} lineBlockAt=${JSON.stringify(h.lineBlockAt)} coordsAtPos=${JSON.stringify(h.coordsAtPos)}`);
  }
  console.log(`  高度账：${JSON.stringify(E.heightAccounting)}`);
  console.log("  方向键：");
  for (const s of E.arrowDown ?? []) console.log(`    ${s.label.padEnd(16)} → doc line ${s.docLine} ${JSON.stringify(s.lineText)} marker3Top=${s.marker3Top} scrollHeight=${s.contentScrollHeight}`);
  for (const s of E.arrowUp ?? []) console.log(`    ${s.label.padEnd(16)} → doc line ${s.docLine} ${JSON.stringify(s.lineText)} marker3Top=${s.marker3Top}`);
  if (E.heightMapEstimateVsMeasure) {
    const h = E.heightMapEstimateVsMeasure;
    console.log(`  高度表估算 vs 实测：开围栏 ${JSON.stringify(h.openFenceHeight_estimate_then_measured)} 闭围栏 ${JSON.stringify(h.closeFenceHeight_estimate_then_measured)} 对照行 ${JSON.stringify(h.controlHeight_estimate_then_measured)}`);
    console.log(`    内容高度变化 ${h.deltaContentHeight_fenceInView_minus_before}px，围栏之后的标记位移 ${h.afterFenceTop_shift}px`);
  }
  if (E.heightMapDrift) console.log(`  高度表 vs DOM 偏差：checked=${E.heightMapDrift.checkedLines} maxAbsDiff=${E.heightMapDrift.maxAbsDiff}`);
  if (E.programmaticScroll) {
    console.log("  程序化设置 scrollTop 后的漂移：");
    for (const s of E.programmaticScroll.steps) console.log(`    target=${pad(s.target)} → 实际=${pad(s.afterSettle)} delta=${pad(s.delta)}`);
  }
  console.log();
}

const T = out("trace-scrolltop.json");
if (T) {
  console.log("=== 滚动漂移溯源 ===");
  console.log(`  一次大跳转 0 → ${T.bigJump.target}：实际停在 ${T.bigJump.after}（差 ${T.bigJump.delta}px）`);
  for (const w of T.bigJump.writes) console.log(`     scrollTop ${w.from} → ${w.to}  由 ${w.stack[1] ?? "?"} 写入`);
  console.log(`  同样的距离分 100px 步进：漂移 ${T.smallSteps100.drift}px，单步最大偏差 ${T.smallSteps100.worstDelta}px`);
  console.log(`  同样的距离分 500px 步进：漂移 ${T.smallSteps500.drift}px，单步最大偏差 ${T.smallSteps500.worstDelta}px`);
  console.log();
}

const AN = out("trace-anchor.json");
if (AN) {
  console.log("=== 漂移的算术 ===");
  for (const l of AN.fullLog ?? []) console.log(`  #${String(l.i).padStart(3)} ${l.call} line=${l.line} top=${l.top} off=${l.off ?? "-"} pos=${l.pos ?? "-"}`);
  console.log(`  最终 scrollTop = ${AN.after}`);
  console.log();
}
