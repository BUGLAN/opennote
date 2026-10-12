import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@codemirror/view";

/**
 * 「查找 / 替换」面板 —— 用 `search({ createPanel })` 换掉 CodeMirror 自带的那一个。
 *
 * 为什么换：自带面板是英文的（`Find` / `Replace` / `match case` / `regexp` / `by word`），
 * 一行里塞下 8 个控件、替换永远占着第二行，和 App 的中文界面与设计令牌都对不上
 * （2026-10-12 用户反馈：「Ctrl F 的时候，编辑器自带的搜索替换弹出来了」）。
 *
 * 这里保留 CodeMirror 的**全部搜索能力**（`@codemirror/search` 的 state / 高亮 / 命中跳转 /
 * 正则 / 整词 / 替换命令一个都没换），只换面板这一层 DOM：
 *
 *   - 中文文案与 App 的按钮/输入框样式（`.md-find` 那一套，见 `styles/editor.css`）；
 *   - 替换**收进第二行**，默认不出现（点「替换」才展开）—— 找东西时不该先看到替换框；
 *   - 多一个命中计数（`3/17`、`无结果`、`正则无效`），带 `aria-live` 让读屏也听得到；
 *   - 只读锁（`.md-readonly`）下不给替换入口 —— 替换命令在只读文档上本来就什么也做不了。
 *
 * 面板自己的按键**不会**冒泡到编辑器（它在 `.cm-content` 之外），所以 Enter / Esc / F3 /
 * Mod-f 都要在这里显式处理，否则会漏给浏览器（Ctrl+F 会弹出浏览器自带的查找栏）。
 */

/** 命中计数上限：超过就显示 `500+`，免得在长笔记里把整篇扫完。 */
const COUNT_LIMIT = 500;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function button(label: string, title: string, action: string): HTMLButtonElement {
  return el("button", { type: "button", class: "md-find__btn", title, "data-act": action }, [label]);
}

export function createFindPanel(view: EditorView): Panel {
  return new FindPanel(view);
}

class FindPanel implements Panel {
  readonly dom: HTMLElement;

  private query: SearchQuery;
  private caseOn: boolean;
  private regexpOn: boolean;
  private wordOn: boolean;

  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly replaceRow: HTMLElement;
  private readonly replaceToggle: HTMLButtonElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly regexpToggle: HTMLButtonElement;
  private readonly wordToggle: HTMLButtonElement;

  /** 只读锁下的编辑器不给替换入口（`EditorState.readOnly` 会挡掉替换事务）。 */
  private readonly canReplace: boolean;

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    this.caseOn = this.query.caseSensitive;
    this.regexpOn = this.query.regexp;
    this.wordOn = this.query.wholeWord;
    this.canReplace = !view.state.readOnly;

    this.searchField = el("input", {
      class: "md-find__input",
      type: "text",
      name: "search",
      form: "",
      placeholder: "查找",
      "aria-label": "查找",
      autocomplete: "off",
      spellcheck: "false",
      // CodeMirror 靠这个属性找「打开面板时该聚焦哪个输入框」。
      "main-field": "true",
    });
    this.searchField.value = this.query.search;

    this.replaceField = el("input", {
      class: "md-find__input",
      type: "text",
      name: "replace",
      form: "",
      placeholder: "替换为",
      "aria-label": "替换为",
      autocomplete: "off",
      spellcheck: "false",
    });
    this.replaceField.value = this.query.replace;

    this.countEl = el("span", { class: "md-find__count", "aria-live": "polite" });

    this.caseToggle = el("button", { type: "button", class: "md-find__toggle", title: "区分大小写", "data-act": "case" }, ["Aa"]);
    this.regexpToggle = el("button", { type: "button", class: "md-find__toggle", title: "正则表达式", "data-act": "regexp" }, [".*"]);
    this.wordToggle = el("button", { type: "button", class: "md-find__toggle", title: "全词匹配", "data-act": "word" }, ["词"]);

    this.replaceToggle = button("替换", "展开 / 收起替换", "replace-toggle");
    this.replaceToggle.setAttribute("aria-expanded", "false");

    this.replaceRow = el("div", { class: "md-find__row md-find__row--replace", hidden: "" }, [
      this.replaceField,
      button("替换", "替换当前命中（Enter）", "replace"),
      button("全部替换", "替换全部命中", "replace-all"),
    ]);

    this.dom = el("div", { class: "md-find", role: "search", "aria-label": "查找与替换" }, [
      el("div", { class: "md-find__row" }, [
        el("div", { class: "md-find__field" }, [this.searchField, this.countEl]),
        button("上一个", "上一个命中（Shift + Enter）", "prev"),
        button("下一个", "下一个命中（Enter）", "next"),
        button("全部", "选中全部命中", "all"),
        el("span", { class: "md-find__sep" }),
        this.caseToggle,
        this.regexpToggle,
        this.wordToggle,
        ...(this.canReplace ? [el("span", { class: "md-find__sep" }), this.replaceToggle] : []),
        el("button", {
          type: "button",
          class: "md-find__close",
          title: "关闭（Esc）",
          "aria-label": "关闭查找",
          "data-act": "close",
        }, ["×"]),
      ]),
      ...(this.canReplace ? [this.replaceRow] : []),
    ]);

    this.dom.addEventListener("input", (event) => {
      if (event.target === this.searchField || event.target === this.replaceField) this.commit();
    });
    this.dom.addEventListener("click", (event) => {
      const act = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) this.run(act);
    });
    this.dom.addEventListener("keydown", (event) => this.keydown(event));
    this.syncToggles();
  }

  /* 面板挂在编辑器顶部（与 `search({ top: true })` 一致）。 */
  get top(): boolean {
    return true;
  }

  mount(): void {
    this.searchField.select();
    this.refreshCount();
  }

  update(update: ViewUpdate): void {
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          queryChanged = true;
        }
      }
    }
    if (queryChanged) this.syncFields();
    if (queryChanged || update.docChanged || update.selectionSet) this.refreshCount();
  }

  /** 面板自己的按键 —— 不会冒泡到编辑器，所以这里必须自己兜住。 */
  private keydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearchPanel(this.view);
      this.view.focus();
      return;
    }
    if (mod && event.key.toLowerCase() === "f") {
      /* 焦点已经在面板里：把光标收回查找框，而不是让浏览器弹出它自己的查找栏。 */
      event.preventDefault();
      this.searchField.select();
      return;
    }
    if (event.key === "F3" || (mod && event.key.toLowerCase() === "g")) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.target === this.replaceField && this.canReplace) replaceNext(this.view);
      else (event.shiftKey ? findPrevious : findNext)(this.view);
    }
  }

  private run(action: string): void {
    switch (action) {
      case "next":
        findNext(this.view);
        break;
      case "prev":
        findPrevious(this.view);
        break;
      case "all":
        selectMatches(this.view);
        break;
      case "replace":
        replaceNext(this.view);
        break;
      case "replace-all":
        replaceAll(this.view);
        break;
      case "case":
      case "regexp":
      case "word":
        this.toggleFlag(action);
        break;
      case "replace-toggle":
        this.setReplaceOpen(this.replaceRow.hasAttribute("hidden"));
        break;
      case "close":
        closeSearchPanel(this.view);
        this.view.focus();
        break;
      default:
        break;
    }
  }

  private setReplaceOpen(open: boolean): void {
    if (open) this.replaceRow.removeAttribute("hidden");
    else this.replaceRow.setAttribute("hidden", "");
    this.replaceToggle.setAttribute("aria-expanded", String(open));
    this.replaceToggle.classList.toggle("is-on", open);
    if (open) this.replaceField.focus();
  }

  private toggleFlag(kind: "case" | "regexp" | "word"): void {
    if (kind === "case") this.caseOn = !this.caseOn;
    else if (kind === "regexp") this.regexpOn = !this.regexpOn;
    else this.wordOn = !this.wordOn;
    this.syncToggles();
    this.commit();
  }

  private syncToggles(): void {
    this.caseToggle.classList.toggle("is-on", this.caseOn);
    this.caseToggle.setAttribute("aria-pressed", String(this.caseOn));
    this.regexpToggle.classList.toggle("is-on", this.regexpOn);
    this.regexpToggle.setAttribute("aria-pressed", String(this.regexpOn));
    this.wordToggle.classList.toggle("is-on", this.wordOn);
    this.wordToggle.setAttribute("aria-pressed", String(this.wordOn));
  }

  private commit(): void {
    const next = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseOn,
      regexp: this.regexpOn,
      wholeWord: this.wordOn,
    });
    if (!next.eq(this.query)) {
      this.query = next;
      this.view.dispatch({ effects: setSearchQuery.of(next) });
    }
    this.refreshCount();
  }

  /** 面板外的改动（别的入口改了 query，例如「选中下一个匹配」）要同步回输入框。 */
  private syncFields(): void {
    this.searchField.value = this.query.search;
    this.replaceField.value = this.query.replace;
    this.caseOn = this.query.caseSensitive;
    this.regexpOn = this.query.regexp;
    this.wordOn = this.query.wholeWord;
    this.syncToggles();
  }

  /**
   * 命中计数。**只报能确定的数**：
   *   - 空查询 → 什么都不显示；
   *   - 正则写坏了（`query.valid === false`）→ 「正则无效」，不假装 0 个结果；
   *   - 一个都没有 → 「无结果」；
   *   - 超过 `COUNT_LIMIT` → `500+`（不再往下数，长笔记里这一条是性能护栏）。
   */
  private refreshCount(): void {
    const query = this.query;
    const set = (text: string, state: string) => {
      this.countEl.textContent = text;
      this.countEl.dataset.state = state;
    };
    if (!query.search) return set("", "idle");
    if (!query.valid) return set("正则无效", "invalid");
    let total = 0;
    let before = 0;
    const selectionFrom = this.view.state.selection.main.from;
    try {
      const cursor = query.getCursor(this.view.state);
      for (let step = cursor.next(); !step.done; step = cursor.next()) {
        total += 1;
        if (step.value.to <= selectionFrom) before += 1;
        if (total > COUNT_LIMIT) break;
      }
    } catch {
      return set("正则无效", "invalid");
    }
    if (total === 0) return set("无结果", "empty");
    if (total > COUNT_LIMIT) return set(`${COUNT_LIMIT}+`, "many");
    return set(`${Math.min(before + 1, total)}/${total}`, "hit");
  }
}
