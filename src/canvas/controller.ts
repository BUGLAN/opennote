/**
 * 画布视图的命令入口注册表。
 *
 * 模块级单例、无 React、无三方库依赖 —— 应用外壳（命令面板 / 菜单）允许**静态**
 * import 本文件（这与视图模块相反：CanvasView 及其子模块只许经 React.lazy 动态进入，
 * 否则 @xyflow/react 会被打进启动包，D28 的懒加载分包就破了）。
 *
 * 注册方是每个挂载中的 CanvasView 实例（一个打开的画布标签 = 一条注册）；
 * 消费方是「适应视图 / 重置缩放 / 聚焦节点」这类跨层命令。命令层自己知道当前
 * 活跃的是哪个画布 id，这里只提供 id → 命令入口的映射，不做「谁是活跃画布」的判断
 * ——那个判断属于 UI 状态（App.tsx 的 tabs/activeId），放进这里会造出第二份真相。
 */

/** 一个挂载中的画布视图暴露的命令入口（由 CanvasView 在挂载时注册）。 */
export interface CanvasViewApi {
  /** 缩放到刚好装下所有节点。 */
  fitView(): void;
  /** 视口回到原点、缩放回到 1。 */
  resetZoom(): void;
  /** 把指定节点挪到视口中心（不存在则静默忽略）。 */
  focusNode(nodeId: string): void;
}

const registry = new Map<string, CanvasViewApi>();

/** 画布视图挂载时登记自己的命令入口；同一 id 重复注册以后者为准（重挂载场景）。 */
export function registerActiveCanvas(canvasId: string, api: CanvasViewApi): void {
  registry.set(canvasId, api);
}

/** 画布视图卸载时注销。未注册的 id 静默忽略（等价于 no-op）。 */
export function unregisterActiveCanvas(canvasId: string): void {
  registry.delete(canvasId);
}

/** 当前挂载中的画布 id（打开顺序）。命令面板列「已打开的画布」用。 */
export function activeCanvasIds(): string[] {
  return [...registry.keys()];
}

/** 取某个画布的命令入口；没挂载返回 null。 */
export function getActiveCanvasApi(canvasId: string): CanvasViewApi | null {
  return registry.get(canvasId) ?? null;
}
