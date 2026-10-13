/**
 * 「这个笔记本开着远端同步吗」—— 一个**只读开关**，给同步层的判定当输入。
 *
 * ## 为什么需要它（而不是让库层直接看配置）
 *
 * `library.ts` 的「外部改动」处置在**两种处境**下必须是两种语义：
 *
 * | 处境 | 磁盘出现我们不知道的版本 | 正确处置 |
 * | --- | --- | --- |
 * | **没开同步**（只有本地编辑器 / git pull / 网盘） | 磁盘就是权威 | **磁盘赢**：未保存文本进隐藏前像，采纳磁盘（D3） |
 * | **开着同步** | 磁盘上那一版可能来自远端 ⇒ **两边都改了就冲突** | **只报不猜**：记账本、列出、让用户裁决（§6.1 L2） |
 *
 * 这不是「新版覆盖旧版」，而是**两套正确的语义**。所以开关必须在判定处可读，
 * 而不是让库层去反查 `workspaces.ts` 的同步配置（那会把 UI 配置拖进同步核心，
 * 也会让库层与同步层互相 import）。
 *
 * ## 纪律
 *
 * - 默认 **`false`**：没人在 P2 打开它之前，行为与今天**逐字节相同**（现有 D3 测试全绿）。
 * - 由同步引擎在启动时置位（`setSyncActive(true)`），关闭笔记本时复位。
 * - 它是**进程级**的：同一时刻只有一个活动笔记本（与 `library.ts` 的 `generation` 同一条前提）。
 */

let active = false;

/** 这个笔记本当前是否开着远端同步。 */
export function isSyncActive(): boolean {
  return active;
}

/** 同步引擎启用/停用远端同步时调用（也用于测试夹具）。 */
export function setSyncActive(value: boolean): void {
  active = value;
}

/** 测试用：复位到默认（没开同步）。 */
export function resetSyncActiveForTests(): void {
  active = false;
}
