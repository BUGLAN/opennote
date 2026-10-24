/**
 * 「工作区里真的有字节落盘了」—— 同步层唯一的**写入通知**原语。
 *
 * ## 为什么不是 `library.ts` 的 `onLocalFlush`
 *
 * `onLocalFlush` 是库层（`library.ts`）的私有事件：它只在 `flushNote()` / `flushAll()`
 * 里发。于是**任何绕过库层直写后端的产地都不会通知同步层**：
 *
 * | 产地 | 怎么写的 | 通知过同步层吗 |
 * | --- | --- | --- |
 * | 编辑器自动保存 | `library.flushNote()` | ✅ |
 * | 收件箱入库 | `clip/receive.ts` → `backend.writeText()` | ❌ |
 * | 拖拽导入 / 旧数据迁移 | `lib/import.ts` → `backend.writeText()` | ❌ |
 * | GitHub 拉取 | `lib/github/sync.ts` → `backend.writeText()` | ❌ |
 *
 * 用户实测的后果：「收件箱入库之后 A 设备不推送，B 设备要等 A 手动同步」。
 * 修法不是给四处各补一行（下一个新增的导入通道还会漏），而是把通知挪到
 * **所有产地共同的下游**：`FileSystemBackend` 本身（见 `writeObserver.ts`）。
 *
 * ## 三条纪律（这个模块存在的全部理由）
 *
 * ### ① 通知**只能**来自「写成功了」
 *
 * 这是它与「订阅 `libraryStore`」的本质区别：`updateNoteContent()` 会在打字那一刻
 * 就改 store，而字节要 450ms 后才落盘。拿 store 当触发点会在**内容还没上盘时**
 * 跑一轮同步（扫描扫不到、推送推空），而落盘那一刻不再有任何事件 ——
 * 于是「入库不推送」会变成「有时推有时不推」，比原来更难查。
 *
 * ### ② 同步**自己**的写入必须静默，而且**只静默那几条路径**
 *
 * 拉取落地走的也是同一个后端。不静默的话：拉一轮 → 触发一轮 → 又拉一轮。
 *
 * 但静默**必须按路径**、不能按时间窗口：
 * 一次全量拉取要写几百篇、持续十几秒，期间用户很可能正在打字。
 * 一个「整轮都静默」的开关会把用户那一次保存一起吞掉 ——
 * 症状与本次要修的 bug 一模一样（改了不推、要等手动同步）。
 *
 * 所以这里只有 `silenced: Map<路径, 计数>`：
 * 静默 `a.md` 就只吞 `a.md`（及其子树）的通知，`b.md` 照常发。
 *
 * 这也是**不需要「事后补发」**的原因：被压下去的写入只可能是同步自己写的那几条，
 * 它们本来就不该触发推送（账本已经记下了）。
 */

/**
 * 一次写入通知。
 *
 * `paths` 是**工作区相对路径**（与 `WorkspaceFileChange.path` 同一方言）。
 * 它给订阅方过滤用：`.opennote/**` 这类写入（账本、元数据、收件箱暂存）
 * 很频繁，但它们不在同步范围里，不该触发一轮推送。
 */
export interface WorkspaceWrite {
  /** 这次写入涉及的路径（`move` 有两个：源与目标）。 */
  paths: string[];
  /**
   * 有没有**文件内容**可能变化。
   *
   * `mkdir` 与「只动目录」是 `false`：目录本身不同步
   * （`selectSyncableEntries` 会丢弃 `isDir` 条目），所以它们不该单独触发一轮推送。
   * 仍然报告出来是为了诊断 —— 「目录建了但一条都没写」是一个有意义的信号。
   */
  content: boolean;
}

export type WorkspaceWriteListener = (write: WorkspaceWrite) => void;

const listeners = new Set<WorkspaceWriteListener>();

/**
 * 订阅「有字节落盘」。
 *
 * 返回退订函数。**同步层在 attach 成功后订阅、`closeWorkspaceSync()` 时退订** ——
 * 没开同步的笔记本一个监听都不该有（旁路纪律：不开就不碰同步）。
 */
export function onWorkspaceWrite(listener: WorkspaceWriteListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前有几个订阅者（诊断 / 用例断言用）。 */
export function workspaceWriteListenerCount(): number {
  return listeners.size;
}

/** 把一次写入广播给所有订阅者。**只由 `writeObserver` 与库层的落盘点调用。** */
export function emitWorkspaceWrite(write: WorkspaceWrite): void {
  if (write.paths.length === 0) return;
  for (const listener of [...listeners]) {
    try {
      listener(write);
    } catch (error) {
      // 一个订阅者炸了不能连累其它订阅者，更不能把写盘搞失败（通知是**事后**的）。
      console.warn("[opennote] 写入通知的订阅者抛错", error);
    }
  }
}

/* ================================ 按路径静默 ================================ */

/** 正在被**同步自己**写入的路径 → 还有几个窗口在静默它。 */
const silenced = new Map<string, number>();

/** 工作区相对路径的规范形（与 `normalizePath` 同一方言：`/` 分隔、无前缀 `./`、无尾斜杠）。 */
function normalize(path: string): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

/**
 * 这个路径现在该不该静默。
 *
 * **按前缀匹配**：静默 `docs/` 时整棵子树命中；静默 `docs/a.md` 时 `docs/b.md` **不**命中。
 */
function isSilenced(path: string): boolean {
  if (silenced.size === 0) return false;
  if (silenced.has(path)) return true;
  for (const key of silenced.keys()) {
    if (path.startsWith(`${key}/`)) return true;
  }
  return false;
}

/**
 * 在「同步自己写盘」的整段代码外面套一层，期间的写入不发给订阅者。
 *
 * ```ts
 * await silenceWrites([item.path], () => writeLocal(item.path, bytes));
 * ```
 *
 * ⚠️ **必须 await**：不 await 的话静默窗口在写入真正发生前就关了 ——
 * 于是「照常触发」，静默等于没做。
 *
 * 传入的路径**允许是目录**（`docs`）：那样整棵子树的写入都被静默。
 */
export async function silenceWrites<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
  const keys = paths.map(normalize).filter((path) => path !== "");
  for (const key of keys) silenced.set(key, (silenced.get(key) ?? 0) + 1);
  try {
    return await run();
  } finally {
    for (const key of keys) {
      const next = (silenced.get(key) ?? 1) - 1;
      if (next <= 0) silenced.delete(key);
      else silenced.set(key, next);
    }
  }
}

/**
 * 把一次写入交给订阅者 —— **但不越过静默窗口**。
 *
 * `writeObserver` 的每个写方法都调它，所以「哪些写入该静默」只有这一处判定。
 */
export function reportWorkspaceWrite(write: WorkspaceWrite): void {
  const paths = write.paths.map(normalize).filter((path) => path !== "");
  if (paths.length === 0) return;
  const allowed = paths.filter((path) => !isSilenced(path));
  if (allowed.length > 0) emitWorkspaceWrite({ paths: allowed, content: write.content });
}

/** 测试用：清空静默表（订阅者列表不清 —— 那是订阅方自己的责任）。 */
export function resetWriteLogForTests(): void {
  silenced.clear();
}

/** 诊断：当前正在被静默的路径。 */
export function silencedPaths(): string[] {
  return [...silenced.keys()];
}
