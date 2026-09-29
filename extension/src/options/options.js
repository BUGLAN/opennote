/**
 * 选项页（`options_ui`）：模板管理（00 §6.14 ㉙ / 03 §UI-01 C06「管理模板…」）。
 *
 * 纪律：
 * - popup 的 `⋯` 菜单是**冻结的 6 项**（03 §UI-01 C63），模板管理不能塞回那里；
 *   模板选择器列表最后一行是「管理模板…」，指向本页。
 * - 模板能改的字段就是 `TEMPLATE_KEYS` 白名单里的那些（`opennote.templates.v1`）；
 *   `overwrite` **不在** `behavior` 白名单里，本页也不提供任何「覆盖」选项。
 * - 校验一律走 `validateTemplate`（与 popup、verify V10 同一份规则）。
 */

import {
  PROPERTY_KEYS,
  TEMPLATE_FILTERS,
  TEMPLATE_VARIABLES,
  normalizeTemplate,
  templateOption,
  validateTemplate,
} from "../lib/templates.js";

const $ = (id) => document.getElementById(id);
const list = $("list");
const status = $("status");
const editor = $("editor");
const fName = $("fName");
const fTriggers = $("fTriggers");
const fPriority = $("fPriority");
const fFolder = $("fFolder");
const fTags = $("fTags");
const fNameFormat = $("fNameFormat");
const fProps = $("fProps");
const fBehavior = $("fBehavior");
const fAppendTo = $("fAppendTo");
const jsonArea = $("json");

let templates = [];
let editingId = null;

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (reply) => {
      if (chrome.runtime.lastError) resolve({ ok: false, label: chrome.runtime.lastError.message });
      else resolve(reply || { ok: false, label: "没有响应" });
    });
  });
}

function say(text) {
  status.textContent = text;
}

/** 触发条件与文本互转：每行 `domain:example.com`、`url:…`、`path:/docs/`。 */
function triggersToText(triggers) {
  return (triggers || []).map((trigger) => `${trigger.type}:${trigger.value}`).join("\n");
}

function textToTriggers(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(":");
      if (index < 0) return { type: "domain", value: line };
      return { type: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    });
}

function propsToText(properties) {
  return Object.entries(properties || {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function textToProps(text) {
  const properties = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    properties[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return properties;
}

function renderList() {
  list.replaceChildren();
  if (!templates.length) {
    const li = document.createElement("li");
    li.className = "opt__empty";
    li.textContent = "还没有模板。带上「默认」的模板会一直兜底，所以这里可以留空。";
    list.appendChild(li);
    return;
  }
  for (const template of templates) {
    const option = templateOption(template, { builtin: Boolean(template.builtin) });
    const li = document.createElement("li");
    li.className = "opt__item";
    const main = document.createElement("div");
    const name = document.createElement("p");
    name.className = "opt__name";
    name.textContent = option.name;
    const summary = document.createElement("p");
    summary.className = "opt__summary";
    summary.textContent = `${option.summary || "无触发条件"} · 优先级 ${template.priority}${template.folder ? ` · 存到 ${template.folder}` : ""}`;
    main.appendChild(name);
    main.appendChild(summary);
    li.appendChild(main);

    const acts = document.createElement("div");
    acts.className = "opt__item-acts";
    if (template.builtin) {
      const tag = document.createElement("span");
      tag.className = "opt__tag";
      tag.textContent = "内置";
      acts.appendChild(tag);
    } else {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => fill(template));
      acts.appendChild(edit);
      const drop = document.createElement("button");
      drop.type = "button";
      drop.className = "btn";
      drop.textContent = "删除";
      drop.addEventListener("click", async () => {
        const reply = await send({ type: "opennote:template-delete", id: template.id });
        if (reply.ok) {
          templates = reply.templates || [];
          renderList();
          say(`已删除「${option.name}」。`);
        } else say(reply.label || "删除失败。");
      });
      acts.appendChild(drop);
    }
    li.appendChild(acts);
    list.appendChild(li);
  }
}

function fill(template) {
  editingId = template.id;
  fName.value = template.name || "";
  fTriggers.value = triggersToText(template.triggers);
  fPriority.value = String(template.priority === undefined ? 0 : template.priority);
  fFolder.value = template.folder || "";
  fTags.value = (template.tags || []).join(", ");
  fNameFormat.value = template.noteNameFormat || "";
  fProps.value = propsToText(template.properties);
  fBehavior.value = template.behavior || "new";
  fAppendTo.value = template.appendTo || "";
  say(`正在编辑「${template.name}」。`);
}

function reset() {
  editingId = null;
  editor.reset();
  fPriority.value = "0";
  fBehavior.value = "new";
  say("新模板：填完点「保存模板」。");
}

editor.addEventListener("submit", async (event) => {
  event.preventDefault();
  const template = normalizeTemplate({
    id: editingId || `t-${Date.now().toString(36)}`,
    name: fName.value,
    triggers: textToTriggers(fTriggers.value),
    priority: Number(fPriority.value || 0),
    folder: fFolder.value,
    tags: fTags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
    noteNameFormat: fNameFormat.value,
    properties: textToProps(fProps.value),
    behavior: fBehavior.value,
    appendTo: fAppendTo.value,
  });
  const problems = validateTemplate(template);
  if (problems.length) {
    say(`没有保存：${problems[0]}`);
    return;
  }
  const reply = await send({ type: "opennote:template-save", template });
  if (!reply.ok) {
    say(reply.label || "保存失败。");
    return;
  }
  templates = reply.templates || [];
  editingId = template.id;
  renderList();
  say(`已保存「${template.name}」。`);
});

$("fReset").addEventListener("click", () => reset());

$("export").addEventListener("click", async () => {
  const reply = await send({ type: "opennote:template-export" });
  if (!reply.ok) {
    say(reply.label || "导出失败。");
    return;
  }
  jsonArea.value = reply.json || "[]";
  try {
    await navigator.clipboard.writeText(jsonArea.value);
    say("模板 JSON 已复制到剪贴板。");
  } catch {
    say("没能自动复制，请在下面文本框里手动全选复制。");
  }
});

$("import").addEventListener("click", async () => {
  if (!jsonArea.value.trim()) {
    say("先把模板 JSON 粘贴到下面的文本框里。");
    return;
  }
  const reply = await send({ type: "opennote:template-import", json: jsonArea.value });
  if (!reply.ok) {
    say(`没有导入：${(reply.detail && reply.detail[0]) || reply.label || "JSON 无法解析。"}`);
    return;
  }
  templates = reply.templates || [];
  renderList();
  const skipped = (reply.problems || []).length;
  say(`已导入 ${reply.imported} 个模板${skipped ? `，跳过 ${skipped} 条不合规内容` : ""}。`);
});

$("vars").textContent = TEMPLATE_VARIABLES.map((name) => `{{${name}}}`).join(" · ");
$("filters").textContent = TEMPLATE_FILTERS.map((name) => `|${name}`).join(" · ");
$("props").textContent = PROPERTY_KEYS.join(" · ");

async function load() {
  const reply = await send({ type: "opennote:template-export" });
  const listed = await send({ type: "opennote:templates" });
  if (listed.ok) {
    // 列表里要连内置模板一起显示（内置不可改），所以走 templates 消息
    templates = await readAll();
    renderList();
  }
  if (reply.ok) jsonArea.value = reply.json || "[]";
}

/** `opennote:templates` 只回摘要，这里要完整对象，所以用导出消息 + 内置清单拼接。 */
async function readAll() {
  const reply = await send({ type: "opennote:templates" });
  const summary = (reply && reply.templates) || [];
  const exported = await send({ type: "opennote:template-export" });
  let custom = [];
  try {
    const parsed = JSON.parse(exported.json || "[]");
    custom = Array.isArray(parsed) ? parsed : parsed.templates || [];
  } catch {
    custom = [];
  }
  return summary.map((item) => {
    if (!item.builtin) {
      const found = custom.find((template) => template.id === item.id);
      if (found) return { ...found, builtin: false, summary: item.summary };
    }
    return {
      id: item.id,
      name: item.name,
      triggers: item.triggers || [],
      priority: item.priority || 0,
      folder: item.folder || "",
      builtin: Boolean(item.builtin),
      summary: item.summary,
    };
  });
}

void load();
