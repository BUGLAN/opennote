/**
 * 页面内桥的页面侧实现（自包含，供 `chrome.scripting.executeScript({func, args})` 注入）。
 *
 * 它跑在 Opennote 网页版那个标签页的内容脚本隔离世界里，做四件事：
 *   ① 发 `hello`；② 等 `ready`（300 ms）；③ 发 `import`（带信封）；④ 等 `result`（5 s）；
 * 然后把结果用 `chrome.runtime.sendMessage` 回给 service worker（与 `content/picker.js`
 * 回报 `opennote:element-picked` 是同一条路）。
 *
 * 自包含不变量（与 `extract-page.js` / `clipboard.js` 同规）：**只有一个顶层声明** ——
 * `executeScript({func})` 传的是函数的**源码副本**，引用模块外层任何变量都会当场
 * `ReferenceError`。所以协议字面量在这里重复一份，唯一事实源是 `lib/inpage.js`，
 * `verify.mjs` 的 V21 逐字比对两处。
 *
 * 两条硬约束：
 *   - `window.postMessage(data, targetOrigin)` **必须显式给 origin**（契约硬红线：
 *     绝不 `"*"`）。这里的目标就是页面自己的 origin。
 *   - 页面侧无法校验「消息来自扩展」——内容脚本与页面共享同一个窗口，同窗口消息的
 *     `origin` 必然是页面自己的 origin。真正的判据是页面侧的 `event.source === window`。
 *
 * 回给 service worker 的消息类型是 `opennote:inpage-report`：它**刻意**不叫
 * `opennote:inpage:result` —— 后者是协议里页面回给我们的类型，两者只差一个分隔符，
 * 放在一起看必然看串。
 */

export async function deliverInpage(payload) {
  const PREFIX = "opennote:inpage:";
  const VERSION = 1;
  const HELLO = PREFIX + "hello";
  const READY = PREFIX + "ready";
  const IMPORT = PREFIX + "import";
  const RESULT = PREFIX + "result";

  const reqId = String((payload && payload.reqId) || "");
  const envelope = payload ? payload.envelope : null;
  const readyMs = Number((payload && payload.readyMs) || 300);
  const resultMs = Number((payload && payload.resultMs) || 5000);
  const origin = window.location.origin;

  // 唯一出口：内容脚本没有别的办法把结果交回扩展（扩展上下文失效时只能留在页面 console）。
  const report = (outcome) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: "opennote:inpage-report", reqId }, outcome));
    } catch (error) {
      console.warn("[opennote] 页面内桥的结果没能回传给扩展", error);
    }
  };

  if (!reqId || !envelope) {
    report({ ok: false, local: true, code: "IMP-3014", label: "这次剪藏没有带上必要的信息（reqId / 信封）。" });
    return false;
  }

  /** 发一条消息并等**同一 reqId** 的回复；`listen → post` 的顺序保证不会漏掉快回复。 */
  const ask = (wantType, message, timeoutMs) =>
    new Promise((resolve) => {
      let timer = null;
      const onMessage = (event) => {
        // 与页面侧对称：只认本窗口 + 同 origin 的消息
        if (event.source !== window) return;
        if (event.origin !== origin) return;
        const reply = event.data;
        if (!reply || typeof reply !== "object") return;
        if (reply.type !== wantType || reply.v !== VERSION || reply.reqId !== reqId) return;
        finish();
        resolve(reply);
      };
      const finish = () => {
        window.removeEventListener("message", onMessage);
        if (timer !== null) clearTimeout(timer);
      };
      timer = setTimeout(() => {
        finish();
        resolve(null);
      }, timeoutMs);
      window.addEventListener("message", onMessage);
      window.postMessage(message, origin);
    });

  const ready = await ask(READY, { type: HELLO, v: VERSION, reqId }, readyMs);
  if (!ready) {
    report({ ok: false, local: true, code: "IMP-1004", label: "Opennote 的页面没有响应。请确认笔记本标签页还开着，或改用桌面版本地接口。" });
    return false;
  }
  if (ready.ok !== true) {
    report({ ok: false, local: true, code: "IMP-1006", label: "这个标签页没有回应 Opennote 的握手，可能不是网页版笔记本。" });
    return false;
  }

  const result = await ask(RESULT, { type: IMPORT, v: VERSION, reqId, envelope }, resultMs);
  if (!result || typeof result !== "object") {
    report({ ok: false, local: true, code: "IMP-1004", label: "Opennote 的页面没有响应。请确认笔记本标签页还开着，或改用桌面版本地接口。" });
    return false;
  }

  // 页面侧的回执形状与 API-02 同形：ok / result / error 原样转交，扩展侧再映射成状态。
  report({ ok: result.ok === true, result: result.result, error: result.error, local: false });
  return result.ok === true;
}
