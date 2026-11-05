import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { imageUrlStore } from "../data/assets";
import { onIdsRemapped } from "../data/library";
import type { Id, UiSettings } from "../data/types";
import { minimalReplace } from "../editor/externalReplace";
import { editorSettingsField, refreshDecorations, setEditorSettings, type EditorSettings } from "../editor/settings";
import { buildEditorExtensions, readOnlyCompartment, spellcheckCompartment } from "../editor/setup";
import { notify } from "../lib/toast";
import { cn } from "../lib/utils";

export interface CursorInfo {
  line: number;
  column: number;
  selected: number;
}

interface EditorPaneProps {
  /**
   * 打开的标签（`ui.tabs`，有序）。**每个标签一个常驻 CodeMirror 实例**：切换标签 =
   * 切换可见性，文档、undo 历史、光标、滚动位置都住在实例里，不重建 —— 这是「切换
   * 笔记整屏闪」的治本方案：整篇换文档会把所有 widget（含图片）拆了重建，白底大图
   * 一收一放就是用户看到的频闪（2026-10-10 用户报告）。
   */
  tabs: readonly Id[];
  activeId: Id | null;
  /**
   * 取一篇笔记（`library.notes` 与 `library.trash` 都要认 —— 回收站里的笔记也能正常
   * 打开）。返回 null 表示笔记没了（外部删除），不留实例。
   */
  getNote(id: Id): { content: string } | null;
  /** 只读锁命中的笔记（`ui.lockedNotes`，标签栏的锁按钮）。 */
  lockedIds: readonly Id[];
  /** 全局外观设置；每实例的 `notePath` 用自己的笔记 id，附件/图片基准由它派生。 */
  settings: UiSettings;
  onDocChange(id: Id, doc: string): void;
  onCursor(id: Id, info: CursorInfo): void;
  /**
   * 输入法（IME）是否正在合成。
   *
   * 为什么必须有这条：中文输入法合成期间用户可能停顿数秒，而「停笔 5 秒自动改名」正好会在
   * 这段停顿里开火 —— 标题还在合成中就被拿去当文件名，等于用半个词改名。
   *
   * 判定放在这里而不是数据层：合成是**编辑器 DOM 的事件**（`compositionstart` /
   * `compositionend` 冒泡到编辑器宿主元素），数据层看不到；而数据层只认 `setEditorComposing()`
   * 下推的状态，两边各管一段、不重复判定。
   */
  onComposing(id: Id, composing: boolean): void;
  /**
   * 任一实例失焦（focusout 离开编辑区）时触发：`onFocusChange` 自动保存模式的落盘点。
   * 模式判断在 App 侧（读最新设置），这里只负责上报事件。
   */
  onEditorBlur?(): void;
  onSave(): void;
  /**
   * 活跃实例变化（切标签 / 关标签 / 标签清空）。App 的 `viewRef` 语义 =
   * 「当前活跃实例的 view」，大纲跳转、命令面板、新建笔记的聚焦都靠它。
   */
  onActiveViewChange(view: EditorView | null): void;
  getTitles(): string[];
  getTags(): string[];
}

/** 只要「能挂事件监听」就够：浏览器里是宿主 `<div>`，单测里是 `EventTarget`。 */
export type CompositionEventHost = {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
};

/**
 * 把**宿主元素上的 composition 事件**翻译成 `onComposing(true/false)`，返回退订函数。
 *
 * 为什么监听 DOM 事件而不是看 CodeMirror 的事务标注：合成是编辑区 DOM 的事实，
 * `compositionstart` / `compositionend` 会从 contenteditable 的编辑区冒泡到宿主元素。
 * 抽成一个独立函数是为了**能在 DOM 层单测**（数据层只认 `setEditorComposing()` 下推的
 * 状态，两边各管一段）。
 *
 * 两条契约（都有用例）：
 *   1. **只在状态变化时上报** —— 连续 `compositionstart` 不会重复上报 `true`；
 *   2. 退订时若仍在合成，**补报一次 `false`** —— 否则那篇笔记会被一条永远为真的合成状态
 *      卡住自动改名（编辑器卸载/换笔记时最容易踩）。
 */
export function attachCompositionReporter(host: CompositionEventHost, report: (composing: boolean) => void): () => void {
  let composing = false;
  const set = (next: boolean) => {
    if (next === composing) return;
    composing = next;
    report(next);
  };
  const onStart = () => set(true);
  const onEnd = () => set(false);
  host.addEventListener("compositionstart", onStart);
  host.addEventListener("compositionend", onEnd);
  return () => {
    host.removeEventListener("compositionstart", onStart);
    host.removeEventListener("compositionend", onEnd);
    set(false);
  };
}

interface EditorHostProps {
  /**
   * 本实例的笔记 id。重命名 / 移动时**会变**（实例的 key 跟着标签走，不跟路径走），
   * 所以凡是用到它的地方都要读最新值（`propsRef` 或放进 effect 依赖）。
   */
  id: Id;
  active: boolean;
  content: string;
  locked: boolean;
  settings: UiSettings;
  onDocChange(doc: string): void;
  onCursor(info: CursorInfo): void;
  onComposing(composing: boolean): void;
  onEditorBlur?(): void;
  onSave(): void;
  /** 把创建好的视图登记进父级的实例表（父级按它解析「活跃实例」）。 */
  onReady(view: EditorView): void;
  /** 从实例表注销（标签关闭 / 笔记被删）。 */
  onCleanup(): void;
  getTitles(): string[];
  getTags(): string[];
}

/**
 * 一个标签 = 一个 CodeMirror 实例。挂载时用当下内容建文档，之后**只做两类同步**：
 * 外部内容变化（磁盘赢、快照恢复、导入）整篇替换；设置（主题/锁/拼写检查）经
 * Compartment/Effect 下推。切换标签只是 `display` 的开与关。
 */
function EditorHost(props: EditorHostProps): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  /** 本实例自己刚写出的文档 —— 区分「外部内容变了」与「自己 onChange 的回声」。 */
  const expectedRef = useRef<string>(props.content);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.content,
        extensions: buildEditorExtensions({
          settings: { ...propsRef.current.settings },
          getTitles: () => propsRef.current.getTitles(),
          getTags: () => propsRef.current.getTags(),
          readOnly: () => propsRef.current.locked,
          onChange: (doc) => {
            expectedRef.current = doc;
            propsRef.current.onDocChange(doc);
          },
          onCursor: (info) => propsRef.current.onCursor(info),
          onSave: () => propsRef.current.onSave(),
          notify: (message) => notify(message),
          imageMode: () => propsRef.current.settings.imageMode,
        }),
      }),
    });
    expectedRef.current = props.content;
    viewRef.current = view;
    propsRef.current.onReady(view);
    // 输入法合成状态 → 宿主（数据层用它抑制「停笔 5 秒自动改名」）。
    const detachComposing = attachCompositionReporter(host, (composing) => propsRef.current.onComposing(composing));
    // 编辑器失焦（onFocusChange 自动保存模式的落盘点）。焦点仍在编辑器内部
    // （点 CodeMirror 自己的面板/悬浮框）不算离开。
    const onFocusOut = (event: FocusEvent) => {
      if (event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
      propsRef.current.onEditorBlur?.();
    };
    host.addEventListener("focusout", onFocusOut);
    return () => {
      detachComposing();
      host.removeEventListener("focusout", onFocusOut);
      view.destroy();
      viewRef.current = null;
      propsRef.current.onCleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 挂载一次；内容/设置走下面的同步 effect
  }, []);

  /* 内容在外面变了（磁盘赢的采纳、快照恢复、导入、同步）：按**最小改动**替换，原光标夹进新文档。

     为什么不是「整篇替换」：整篇替换会把 CM 的滚动锚点塌到文档开头，`measure()` 的补偿
     随即把视口拽回顶部（实测 4000 → 74，−3926px；Agent 一改文件，用户读的地方就没了）。
     最小改动同时保住「视口位置」与「高度表里已量过的行高」，见 `editor/externalReplace.ts`。

     **隐藏的后台标签不在这里改**，攒到成为活跃标签、CM 重新量过之后再落（见下面的激活
     effect）。`display: none` 时 CM 量不到尺寸，`viewportIsAppropriate()` 一律放行：
     改动落在旧视口里面时，映射后的视口会把新插进来的整段都包进去 —— 实测一篇短笔记在
     后台被整篇改成 25 万字符，10503 行全部进了 DOM，之后它每变一次都要 ~140ms。 */
  /** 输入法合成期间推迟的外部改动：合成结束时补落（只挂一个监听）。 */
  const deferredRef = useRef(false);
  const applyExternalContent = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = propsRef.current.content;
    const current = view.state.doc.toString();
    if (next === expectedRef.current || next === current) return;
    /*
     * 合成中不改文档（排查报告问题 10）：同步 / 「磁盘为准」的改动恰好在中文输入合成期间到达时，
     * 直接 dispatch 会打断输入法 —— 候选词丢失、已输入的拼音被吞或重复。等 `compositionend`、
     * CodeMirror 把合成结果落进文档之后再替换（`minimalReplace` 只换差异段，光标照样夹进新文档）。
     */
    if (view.composing) {
      if (deferredRef.current) return;
      deferredRef.current = true;
      view.contentDOM.addEventListener(
        "compositionend",
        () => {
          setTimeout(() => {
            deferredRef.current = false;
            applyExternalContent();
          }, 0);
        },
        { once: true },
      );
      return;
    }
    expectedRef.current = next;
    const { changes, selection } = minimalReplace(current, next, view.state.selection.main);
    view.dispatch({
      changes,
      selection,
      annotations: Transaction.addToHistory.of(false),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 自引用：合成结束时重跑自己
  }, []);

  const hidden = !props.active || props.locked;
  useEffect(() => {
    if (!hidden) applyExternalContent();
    // 依赖里不放 hidden：变成可见时由激活 effect 在量过之后再落，这里只管「可见期间内容变了」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.content, applyExternalContent]);

  /* push appearance / mode settings into the editor state */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: setEditorSettings.of({
        theme: props.settings.theme,
        appearance: props.settings.appearance,
        focus: props.settings.focus,
        typewriter: props.settings.typewriter,
        imageMode: props.settings.imageMode,
        showMarks: props.settings.showMarks,
        // 空态传空串：粘贴时 `insertFileSnippets()` 如实提示「附件没有落点」，
        // 而不是拿空路径去派生出一个 `未命名.assets/`。改名后 `props.id` 变了，这里重新下推。
        notePath: props.id,
      }),
    });
  }, [
    props.settings.theme,
    props.settings.appearance,
    props.settings.focus,
    props.settings.typewriter,
    props.settings.imageMode,
    props.settings.showMarks,
    props.id,
  ]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: spellcheckCompartment.reconfigure(
        EditorView.contentAttributes.of({
          spellcheck: String(props.settings.spellcheck),
          autocapitalize: "off",
          "data-placeholder": "开始写下这一刻…",
        }),
      ),
    });
  }, [props.settings.spellcheck]);

  /* 只读锁切换：用 Compartment 换掉 readOnly/editable，不重建编辑器（undo 历史保留）。 */
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.reconfigure([
        EditorState.readOnly.of(props.locked),
        EditorView.editable.of(!props.locked),
      ]),
    });
  }, [props.locked]);

  /* images resolve lazily from disk — redraw the document when they arrive */
  useEffect(() => {
    return imageUrlStore.subscribe(() => {
      const view = viewRef.current;
      if (view) view.dispatch({ effects: refreshDecorations.of(null) });
    });
  }, []);

  /* 成为活跃标签：从 display:none 回到布局要重新量；焦点与状态栏光标跟上。
     （旧「换文档后 view.focus()」的行为由这里承接——切换标签本来就是聚焦时刻。）

     后台期间攒下的外部改动在 CM 这次测量的 write 阶段之后再落：这时 `inView` 已经为真，
     视口按真实可见区重算，只渲染屏幕上那几十行。测量期间不许 dispatch，所以排进微任务
     （测量回调一结束就执行）。聚焦放在落改动之后 —— 不给用户在旧内容上敲字的机会，
     否则那一下会把外部改动覆盖掉。 */
  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      const view = viewRef.current;
      if (!view || cancelled) return;
      view.requestMeasure({
        read: () => null,
        write: () => {
          queueMicrotask(() => {
            if (cancelled || viewRef.current !== view) return;
            applyExternalContent();
            view.focus();
            const range = view.state.selection.main;
            const line = view.state.doc.lineAt(range.head);
            propsRef.current.onCursor({
              line: line.number,
              column: range.head - line.from + 1,
              selected: range.to - range.from,
            });
          });
        },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [hidden, applyExternalContent]);

  return (
    <div
      className={cn(
        "editor-host",
        hidden && "editor-host--hidden",
        props.settings.typewriter && "md-typewriter",
        props.settings.focus && "md-focus-mode",
        props.content === "" && "md-empty",
        props.locked && "md-readonly",
      )}
      ref={hostRef}
    />
  );
}

/**
 * 标签 → 常驻编辑器实例的注册表。一个 EditorPane 渲染 `tabs` 里每个 id 各一个
 * {@link EditorHost}，并向上汇报「活跃实例」（App 的 `viewRef`）。
 */
export function EditorPane(props: EditorPaneProps): ReactNode {
  /** 实例表：按**实例 key** 存（不是笔记 id —— 改名时 id 变、实例不变）。 */
  const viewsRef = useRef(new Map<string, EditorView>());

  /**
   * 笔记 id → 实例 key。key 在标签第一次渲染时发放，之后**跟着路径走**：重命名、移动、
   * 自动改名都只把映射搬到新 id，React 看到的 key 不变 ⇒ 实例不重建，光标、滚动、
   * undo 都留着（以前 `key={id}`，停笔 5 秒自动改名后继续打字会落到文档开头）。
   */
  const keysRef = useRef(new Map<Id, string>());
  const keySeqRef = useRef(0);
  const keyOf = (id: Id): string => {
    let key = keysRef.current.get(id);
    if (!key) {
      key = `editor-${(keySeqRef.current += 1)}`;
      keysRef.current.set(id, key);
    }
    return key;
  };
  useEffect(
    () =>
      onIdsRemapped((replace) => {
        const next = new Map<Id, string>();
        for (const [id, key] of keysRef.current) next.set(replace(id), key);
        keysRef.current = next;
      }),
    [],
  );
  /* 关掉的标签不留映射：同一路径以后再开是一篇「新」笔记，应当拿新实例。 */
  useEffect(() => {
    const open = new Set(props.tabs);
    for (const id of [...keysRef.current.keys()]) if (!open.has(id)) keysRef.current.delete(id);
  }, [props.tabs]);

  /**
   * 实例表的**版本号**。存在的唯一理由是让下面的上报 effect 能感知「实例表变了」。
   *
   * 为什么非它不可：上报 effect 的依赖是 `[activeId, tabs]`，而**实例注册发生在子组件
   * 的挂载 effect 里**。有一条真实路径会因此漏掉上报 ——
   * 应用启动时 `library.notes` 还是空的（`src/data/library.ts` 初始就是 `notes: {}`），
   * 恢复出来的标签找不到笔记 ⇒ 不渲染 `EditorHost` ⇒ 那一刻上报的是 `null`；
   * 等异步扫描把笔记填进来，`EditorHost` 才挂载并注册实例，而 `activeId` / `tabs`
   * **一个都没变** ⇒ 上报 effect 不会再跑 ⇒ `viewRef` 一直停在 `null`。
   *
   * 症状（用户 2026-10-10 稳定复现）：右键图片「删除图片」没反应，**切一次标签就好了**。
   * 同样受影响的还有大纲跳转、命令面板、新建笔记聚焦 —— 它们都读 `viewRef`。
   */
  const [registryVersion, setRegistryVersion] = useState(0);

  /* 活跃实例上报。依赖 tabs：关闭活跃标签时（tabs 与 activeId 同一次提交里变化）
     子组件的注销/登记 effect 先跑，这里读到的是刷新后的实例表。 */
  useEffect(() => {
    const activeKey = props.activeId != null ? keysRef.current.get(props.activeId) : undefined;
    const view = activeKey ? (viewsRef.current.get(activeKey) ?? null) : null;
    props.onActiveViewChange(view);
    if (import.meta.env.DEV) {
      // handy for debugging the live-preview tree from the console
      (window as unknown as Record<string, unknown>).__opennote = view
        ? {
            view,
            settings: () => view.state.field(editorSettingsField, false),
            apply: (patch: Partial<EditorSettings>) => view.dispatch({ effects: setEditorSettings.of(patch) }),
            dump: () => {
              const lines: string[] = [];
              syntaxTree(view.state).iterate({
                enter: (node) => {
                  lines.push(
                    `${node.name} ${node.from}-${node.to} ${JSON.stringify(view.state.sliceDoc(node.from, Math.min(node.to, node.from + 40)))}`,
                  );
                },
              });
              return lines.join("\n");
            },
          }
        : null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只跟「哪篇活跃/开了哪些标签」有关
  }, [props.activeId, props.tabs, registryVersion]);

  return (
    <>
      {props.tabs.map((id) => {
        const note = props.getNote(id);
        // 笔记没了（外部删除、清空回收站）：不留实例 —— React 卸载旧 host（销毁它的视图）。
        if (!note) return null;
        const key = keyOf(id);
        return (
          <EditorHost
            key={key}
            id={id}
            active={id === props.activeId}
            content={note.content}
            locked={props.lockedIds.includes(id)}
            settings={props.settings}
            onDocChange={(doc) => props.onDocChange(id, doc)}
            onCursor={(info) => props.onCursor(id, info)}
            onComposing={(composing) => props.onComposing(id, composing)}
            onEditorBlur={props.onEditorBlur}
            onSave={props.onSave}
            // 注册/注销都要**抬高版本号**：实例比 activeId 晚就绪是真实存在的路径
            // （见 `registryVersion` 的注释），不抬的话 `viewRef` 会一直停在 null。
            onReady={(view) => {
              viewsRef.current.set(key, view);
              setRegistryVersion((n) => n + 1);
            }}
            onCleanup={() => {
              viewsRef.current.delete(key);
              setRegistryVersion((n) => n + 1);
            }}
            getTitles={props.getTitles}
            getTags={props.getTags}
          />
        );
      })}
    </>
  );
}
