/*
 * 不需要登录的四张单卡页：初始化、控制台登录、接受邀请（/join）、设置密码（/reset）。
 * 版式照 docs/sync/mockups/03-admin.html 的状态 1 与状态 10。
 */

import { get, post } from "./api.js";
import { bytes, copy, errorSlot, h, mount, busy, segmented, icon } from "./dom.js";

/** GitHub 标志（与原型同一个路径；fill 跟着文字颜色）。 */
const GITHUB_PATH =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

export function githubMark() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", "gh");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", GITHUB_PATH);
  path.setAttribute("fill", "currentColor");
  svg.append(path);
  return svg;
}

/** 「用 GitHub …」按钮：整页跳到 /auth/github（授权完由服务端跳回来）。 */
function githubButton(label, href) {
  return h("a", { class: "btn btn--block", href }, githubMark(), label);
}

/** 与服务端 `auth/passwords.ts` 的 PASSWORD_MIN_LENGTH 同一个数。 */
const PASSWORD_MIN = 10;

const REGISTRATION = [
  ["invite", "仅限邀请"],
  ["open", "开放注册"],
  ["closed", "关闭注册"],
];

function host() {
  return location.host;
}

function card(title, ...children) {
  window.scrollTo({ top: 0 });
  return h("div", { class: "center-card" }, h("div", { class: "center-card__head" }, h("span", { class: "seal", text: "記" }), h("b", { text: title })), children);
}

function field(label, input, hint) {
  return h("label", { class: "lab" }, label, input, hint ? h("span", { class: "hint", text: hint }) : null);
}

function input(props) {
  return h("input", { class: "field", ...props });
}

/** 两次密码对不上 / 太短：在前端先拦一道（服务端还会再查）。 */
function passwordProblem(password, again) {
  if (password.length < PASSWORD_MIN) return "密码至少 " + PASSWORD_MIN + " 位";
  if (again !== null && password !== again) return "两次输入的密码不一样";
  return null;
}

/* ------------------------------------------------------------ 初始化 */

export function renderSetup(root, session, onDone) {
  let registration = "invite";
  const email = input({ type: "email", autocomplete: "username", required: true, placeholder: "admin@example.com" });
  const name = input({ autocomplete: "nickname", placeholder: "可以不填" });
  const password = input({ type: "password", autocomplete: "new-password", required: true });
  const again = input({ type: "password", autocomplete: "new-password", required: true });
  const error = errorSlot();
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--tall", text: "创建管理员并进入控制台" });
  const modeSlot = h("div");
  const drawMode = () =>
    mount(
      modeSlot,
      segmented(REGISTRATION, registration, (value) => {
        registration = value;
        drawMode();
      }),
    );
  drawMode();

  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: (event) => {
        event.preventDefault();
        const problem = passwordProblem(password.value, again.value);
        if (problem) return error.set(problem);
        error.set(null);
        busy(submit, async () => {
          try {
            await post("/v1/panel/setup", { email: email.value.trim(), password: password.value, displayName: name.value.trim() || undefined, registration });
            onDone();
          } catch (failure) {
            error.set(failure.message);
          }
        });
      },
    },
    field("对外地址", input({ value: session.externalBaseUrl, readOnly: true }), "客户端和邀请链接都用这个地址（环境变量 EXTERNAL_BASE_URL）。"),
    field("管理员邮箱", email),
    field("怎么称呼你", name),
    field("密码", password, "至少 " + PASSWORD_MIN + " 位。"),
    field("再输一次密码", again),
    h("div", { class: "lab" }, "谁可以注册", modeSlot, h("span", { class: "hint", text: "之后可以在「服务设置」里改。" })),
    error.node,
    submit,
  );

  mount(
    root,
    card(
      "欢迎使用 Opennote 同步",
      h("p", { class: "message", text: "这台服务器还没有管理员。创建第一个账号，它会成为管理员，也可以像普通账号一样同步笔记。" }),
      form,
      h("p", { class: "note" }, "只有服务器上还没有任何账号时才会看到这个页面。忘了管理员密码可以在服务器上运行 ", h("code", { text: "node dist/cli.js reset-password <邮箱>" }), "。"),
    ),
  );
  email.focus();
}

/* ------------------------------------------------------------ 登录 */

export function renderLogin(root, session, onDone) {
  const email = input({ type: "email", autocomplete: "username", required: true });
  const password = input({ type: "password", autocomplete: "current-password", required: true });
  const error = errorSlot();
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--tall", text: "登录" });
  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: (event) => {
        event.preventDefault();
        error.set(null);
        busy(submit, async () => {
          try {
            await post("/v1/panel/login", { email: email.value.trim(), password: password.value });
            onDone();
          } catch (failure) {
            error.set(failure.message);
            password.select();
          }
        });
      },
    },
    field("邮箱", email),
    field("密码", password),
    error.node,
    submit,
  );
  if (!session.passwordLogin) form.hidden = true;
  mount(
    root,
    card(
      "登录控制台",
      h("p", { class: "message", text: host() + " · 只有管理员能登录控制台。普通账号请在 Opennote 客户端里登录。" }),
      session.github ? h("div", { class: "stack mt-lg" }, githubButton("使用 GitHub 登录", "/auth/github?mode=panel"), session.passwordLogin ? h("div", { class: "divider", text: "或用邮箱登录" }) : null) : null,
      form,
      h("p", { class: "note" }, "忘了密码：请另一位管理员发一个设置密码链接，或在服务器上运行 ", h("code", { text: "node dist/cli.js reset-password <邮箱>" }), "。"),
    ),
  );
  email.focus();
}

/* ------------------------------------------------------------ /join */

/** 邀请 / 重置链接用不了时的那张卡（过期、作废、用过、码不对）。 */
function deadEnd(root, title, message) {
  mount(root, card(title, h("p", { class: "message", text: message }), h("p", { class: "note", text: "请联系发给你链接的管理员，请对方重新发一个。" })));
}

/** 建完账号之后：告诉对方去客户端里登录，并把要填的东西摆出来。 */
function nextSteps(email, isAdmin) {
  const server = location.origin;
  return h(
    "div",
    { class: "callout mt-lg" },
    h("b", { text: "下一步" }),
    "：在 Opennote 里打开「设置 → 同步」，用下面的信息登录。",
    h(
      "dl",
      { class: "kv mt" },
      h("dt", { text: "服务器" }),
      h("dd", {}, h("span", { class: "mono break", text: server }), " ", h("button", { type: "button", class: "link", text: "复制", onClick: () => copy(server) })),
      h("dt", { text: "邮箱" }),
      h("dd", { class: "break", text: email }),
    ),
    h(
      "div",
      { class: "row mt" },
      // 装了桌面端 / 手机端的话，深链直接打开「设置 → 同步」并预填服务器与邮箱（不会自动登录）。
      h("a", { class: "btn btn--sm btn--primary", href: "opennote://sync/sign-in?" + new URLSearchParams({ server, email }).toString(), text: "在 Opennote 中打开" }),
      isAdmin ? h("a", { class: "btn btn--sm", href: "/admin", text: "进入控制台" }) : null,
    ),
  );
}

export async function renderJoin(root, code) {
  let info;
  try {
    info = await get("/v1/auth/invites/" + encodeURIComponent(code));
  } catch (error) {
    if (error.code === "registration-closed") return deadEnd(root, "暂时不能加入", error.message);
    if (error.status === 404) return deadEnd(root, "这个邀请链接不对", "链接可能复制得不完整，请从原消息里重新复制一次。");
    if (error.status === 410) return deadEnd(root, "这个邀请用不了了", error.message);
    return deadEnd(root, "打不开这个邀请", error.message);
  }

  const email = input({ type: "email", autocomplete: "username", required: true, value: info.email || "", readOnly: !!info.email });
  const name = input({ autocomplete: "nickname", placeholder: "可以不填" });
  const password = input({ type: "password", autocomplete: "new-password", required: true });
  const again = input({ type: "password", autocomplete: "new-password", required: true });
  const error = errorSlot();
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--tall", text: "创建账号" });
  const who = info.invitedBy ? info.invitedBy + " 邀请你" : "你被邀请";
  const intro = who + "使用这台服务器同步 Opennote 笔记。你会有 " + bytes(info.quotaBytes) + " 空间" + (info.grantAdmin ? "，并且是这台服务器的管理员。" : "。");

  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: (event) => {
        event.preventDefault();
        const problem = passwordProblem(password.value, again.value);
        if (problem) return error.set(problem);
        error.set(null);
        busy(submit, async () => {
          try {
            const accepted = await post("/v1/auth/invites/" + encodeURIComponent(code), {
              email: email.value.trim(),
              password: password.value,
              displayName: name.value.trim() || undefined,
            });
            mount(
              root,
              card(
                "账号建好了",
                h("p", { class: "message", text: "欢迎" + (accepted.me.displayName ? "，" + accepted.me.displayName : "") + "。这个邀请链接已经用掉了，不用再保存它。" }),
                nextSteps(accepted.me.email, accepted.me.isAdmin),
              ),
            );
          } catch (failure) {
            error.set(failure.message);
          }
        });
      },
    },
    field("邮箱", email, info.email ? "这个邀请是发给这个邮箱的。" : null),
    field("怎么称呼你", name),
    field("设置密码", password, "至少 " + PASSWORD_MIN + " 位。忘了可以找管理员重置。"),
    field("再输一次密码", again),
    error.node,
    submit,
  );

  const health = await get("/v1/health").catch(() => null);
  const github = health && health.auth && health.auth.github;
  mount(
    root,
    card(
      "加入 " + host(),
      h("p", { class: "message", text: intro }),
      github ? h("div", { class: "stack mt-lg" }, githubButton("用 GitHub 接受邀请", "/auth/github?mode=join&invite=" + encodeURIComponent(code)), h("div", { class: "divider", text: "或设置一个密码" })) : null,
      form,
    ),
  );
  (info.email ? name : email).focus();
}

/* ------------------------------------------------------------ /reset */

export async function renderReset(root, code) {
  let info;
  try {
    info = await get("/v1/auth/password-resets/" + encodeURIComponent(code));
  } catch (error) {
    if (error.status === 404) return deadEnd(root, "这个链接不对", "链接可能复制得不完整，请从原消息里重新复制一次。");
    return deadEnd(root, "这个链接用不了了", error.message);
  }

  const password = input({ type: "password", autocomplete: "new-password", required: true });
  const again = input({ type: "password", autocomplete: "new-password", required: true });
  const error = errorSlot();
  const submit = h("button", { type: "submit", class: "btn btn--primary btn--tall", text: "设置新密码" });
  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: (event) => {
        event.preventDefault();
        const problem = passwordProblem(password.value, again.value);
        if (problem) return error.set(problem);
        error.set(null);
        busy(submit, async () => {
          try {
            await post("/v1/auth/password-resets/" + encodeURIComponent(code), { password: password.value });
            mount(
              root,
              card(
                "新密码设好了",
                h("p", { class: "message", text: "之前登录过的设备都已经下线。请在每台设备的「设置 → 同步」里用新密码重新登录。" }),
                h("div", { class: "callout mt-lg" }, icon("lock", 13), " 端到端加密的笔记本不受影响：那把钥匙只在你自己的设备上，和登录密码无关。"),
              ),
            );
          } catch (failure) {
            error.set(failure.message);
          }
        });
      },
    },
    h("input", { type: "email", autocomplete: "username", value: info.email || "", hidden: true, readOnly: true }),
    field("新密码", password, "至少 " + PASSWORD_MIN + " 位。"),
    field("再输一次", again),
    error.node,
    submit,
  );
  mount(root, card("设置新密码", h("p", { class: "message", text: "为 " + (info.email || "你的账号") + " 设置一个新密码。链接只能用一次。" }), form));
  password.focus();
}

/* ------------------------------------------------------------ /auth/result */

/** GitHub 授权在网页上的收尾：接受邀请 / 绑定成功，或者失败原因（服务端把人话放在 message 里）。 */
export function renderAuthResult(root, params) {
  const done = params.get("done");
  if (done === "joined") {
    return mount(
      root,
      card(
        "账号建好了",
        h("p", { class: "message", text: "已经用 GitHub" + (params.get("github") ? "（@" + params.get("github") + "）" : "") + " 接受邀请。之后在 Opennote 里点「使用 GitHub 登录」即可。" }),
        nextSteps(params.get("email") || "", false),
      ),
    );
  }
  if (done === "linked") {
    return mount(
      root,
      card("GitHub 已绑定", h("p", { class: "message", text: "这个账号以后也可以用 GitHub" + (params.get("github") ? "（@" + params.get("github") + "）" : "") + " 登录。可以关掉这个页面，回到 Opennote 了。" })),
    );
  }
  mount(
    root,
    card(
      "没能完成 GitHub 登录",
      h("p", { class: "message", text: params.get("message") || "授权没有完成，请重试。" }),
      h("p", { class: "note", text: "可以关掉这个页面，回到原来的地方重试。" }),
    ),
  );
}
