export interface FatalCardOptions {
  title: string;
  message: string;
  /** 给人看的补充说明（可选）。 */
  note?: string;
  /** 原始错误名/消息一类的技术细节（可选，等宽小字）。 */
  detail?: string;
  retryLabel?: string;
  onRetry: () => void;
}

/**
 * 一次性页面的失败卡。复用 base.css 里已有的 `.boot` / `.boot--failed` 样式
 * （与应用启动失败卡是同一套），所以这里一个令牌都不用加。
 *
 * 全程 `createElement` + `textContent`：没有 innerHTML，注入不了东西；也不写内联 style
 * （桥给的是 `script-src 'self'`、多半也带 `style-src 'self'`）。
 */
export function renderFatalCard(host: HTMLElement, options: FatalCardOptions): void {
  host.textContent = "";

  const card = document.createElement("div");
  card.className = "boot boot--failed";
  card.setAttribute("role", "alert");

  const seal = document.createElement("div");
  seal.className = "boot__seal";
  seal.setAttribute("aria-hidden", "true");
  seal.textContent = "記";

  const title = document.createElement("div");
  title.className = "boot__name";
  title.textContent = options.title;

  const message = document.createElement("div");
  message.className = "boot__hint";
  message.textContent = options.message;

  const actions = document.createElement("div");
  actions.className = "boot__actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "boot__retry";
  retry.textContent = options.retryLabel ?? "重新载入";
  retry.addEventListener("click", options.onRetry);
  actions.appendChild(retry);

  card.append(seal, title, message, actions);

  if (options.detail !== undefined && options.detail !== "") {
    const detail = document.createElement("pre");
    detail.className = "boot__detail";
    detail.textContent = options.detail;
    card.appendChild(detail);
  }

  if (options.note !== undefined && options.note !== "") {
    const note = document.createElement("p");
    note.className = "boot__note";
    note.textContent = options.note;
    card.appendChild(note);
  }

  host.appendChild(card);
}
