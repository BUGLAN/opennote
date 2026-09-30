/**
 * 新标签页里的**可编辑剪藏**（整页形态）：把标题与正文取出来给用户改，改完再入库。
 *
 * 三条约束（与 popup 完全一致，不另造通路）：
 *   1. 读取走**同一条** opennote:load 消息（后台 loadSnapshot，页面自动提取）；
 *   2. 提交走**同一条** submit 消息，正文用**用户改过的** body —— 这就是「所见即所剪」；
 *   3. 落点不变：由后台按 ㉕ 落**收件箱**（这里不指定落点、不下发 conflict）。
 * 零新依赖、只用既有令牌、无第三方库。
 */
const $ = (id) => document.getElementById(id);
const MAX_BODY = 400000;

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return hex() + hex() + "-" + hex() + "-" + hex() + "-" + hex() + "-" + hex() + hex() + hex();
}

async function activeSource() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  return { url: (tab && tab.url) || "", title: (tab && tab.title) || "" };
}

function msg(text, bad) {
  const node = $("msg");
  node.textContent = text;
  node.classList.toggle("is-bad", Boolean(bad));
}

async function prefill() {
  const src = await activeSource();
  $("src").textContent = src.url || "（这个页面没有可剪藏的网址）";
  $("title").value = src.title || "";
  // **无 URL 就不渲染入口**（不画死按钮）：没有网址就没有可信来源
  $("save").hidden = !src.url;
  if (!src.url) return;
  try {
    const response = await chrome.runtime.sendMessage({ type: "opennote:load" });
    const ex = response && response.extraction;
    if (ex && ex.article && typeof ex.article.markdown === "string" && ex.article.markdown) {
      $("body").value = ex.article.markdown;
    } else {
      // 失败要**看得见**，不静默留一个空框
      msg("没能读到正文，你可以直接粘贴内容。", true);
    }
  } catch (error) {
    msg("没能读到正文：" + error.message, true);
  }
}

async function save() {
  const title = $("title").value.trim();
  const body = $("body").value;
  if (!body.trim()) {
    msg("正文是空的，先写点内容再保存。", true);
    return;
  }
  $("save").disabled = true;
  msg("正在保存到收件箱…", false);
  try {
    const response = await chrome.runtime.sendMessage({
      type: "opennote:submit",
      mode: "page",
      title: title,
      importId: newId(),
      body: body.slice(0, MAX_BODY),
    });
    if (response && response.ok) msg("已保存到收件箱。", false);
    else msg((response && response.message) || "保存失败，请重试。", true);
  } catch (error) {
    msg("保存失败：" + error.message, true);
  } finally {
    $("save").disabled = false;
  }
}

void prefill();
$("save").addEventListener("click", () => void save());
