---
version: alpha
name: Opennote-design
description: Opennote 是一套「纸与墨」的写作界面 —— 暖白纸面、朱砂印章、衬线正文。整个应用只有一个材质：纸（--paper 四档）与墨（--ink 三档），强调色只用来表示「需要你处理」，状态一律用文字说而不是用颜色喊。5 套调色板 × 4 套强调色构成 20 种组合，全部由 CSS 自定义属性驱动，主题只换值不换结构。界面字是 Figtree 无衬线，正文是 Newsreader 衬线，标题是 Fraunces 变体衬线（SOFT/WONK 轴打开），代码是 JetBrains Mono。品牌记号是一枚朱砂圆角印章里的「記」字。没有任何成功绿 / 警告黄 / 失败红语义色 —— 这是刻意的，见正文 §Colors。

# ─────────────────────────────────────────────────────────────────────────────
# 这份 front-matter 是机器可读的「令牌契约」。
# 取值一律来自 src/styles/tokens.css（唯一产地，全文 55 个自定义属性）。
# colors 一节列出**默认组合**（素笺 paper × 朱砂 seal）的实际取值；
# 其余 4 套调色板 × 3 套强调色的完整取值见正文 §Colors。
# 写代码时请引用 {token.name}，不要抄这里的字面值。
# ─────────────────────────────────────────────────────────────────────────────

colors:
  # 素笺 paper —— 默认亮色主题
  paper: "#fbf8f3"          # 页面底 / 正文底
  paper-2: "#fffdf9"        # 卡片 / 输入框 / 对话框 / 浮层底
  paper-3: "#f2ece1"        # hover 底 / 次级底 / 表头底
  paper-4: "#e9e1d3"        # 滑块槽底 / 禁用底 / 深一档的按下底
  ink: "#221d17"            # 标题 / 正文 / 主要文字
  ink-2: "#5c5347"          # 次要文字 / 条目正文 / 说明句
  ink-3: "#97897a"          # 提示文字。对比度不足，见 §Accessibility，用途受限
  rule: "#e8dfd1"           # 1px 分隔线
  rule-strong: "#d7cbb8"    # 控件边框 / 卡片描边
  code-bg: "#f4eee4"        # 代码底（行内码 / 代码块 / 令牌串）
  mark: "#f6e3a8"           # ==高亮== 底色。全系统只有一个高亮色
  sel: "rgba(178, 58, 46, 0.16)"   # ::selection
  accent: "#b23a2e"
  accent-ink: "#ffffff"
  accent-soft: "rgba(178, 58, 46, 0.12)"
  accent-line: "rgba(178, 58, 46, 0.34)"
  # 强调色在暗色主题下换一套更亮的取值（见 §Colors）
  accent-dark: "#e0664f"
  accent-ink-dark: "#1a0f0c"

# 阴影与纹理（不是颜色：--shadow-c 是「阴影基色」的 RGB 三分量，
# 供 rgb(var(--shadow-c) / α) 形式使用；--grain 是不透明度数值）
effects:
  shadow-c: "52 39 22"
  shadow-1: "0 1px 2px rgb(var(--shadow-c) / 0.06)"
  shadow-2: "0 2px 6px -2px rgb(var(--shadow-c) / 0.1), 0 12px 28px -18px rgb(var(--shadow-c) / 0.28)"
  shadow-3: "0 24px 60px -28px rgb(var(--shadow-c) / 0.36), 0 2px 8px -4px rgb(var(--shadow-c) / 0.12)"
  grain: 0.035              # 纸张颗粒不透明度（body::before 的内联 SVG 噪点）

typography:
  font-ui:
    fontFamily: "Figtree Variable, Figtree, system-ui, -apple-system, Segoe UI, PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    usage: "所有界面文字：按钮、标签、菜单、状态栏、对话框标题以外的控件"
  font-display:
    fontFamily: "Fraunces Variable, Fraunces, Newsreader Variable, Georgia, Songti SC, serif"
    fontVariationSettings: "\"SOFT\" 40, \"WONK\" 1"
    usage: "品牌名 .sidebar__name / 空态大标题 .empty__title / 对话框标题 .dialog__title"
  font-serif:
    fontFamily: "Newsreader Variable, Newsreader, Iowan Old Style, Georgia, Songti SC, Noto Serif SC, Source Han Serif SC, SimSun, serif"
    usage: "正文 --font-doc 默认值；印章字形；收件箱预览摘录"
  font-mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, Cascadia Code, SFMono-Regular, Consolas, Liberation Mono, monospace"
    usage: "代码块、行内代码、令牌串、路径、端口、表格源码"
  font-cjk-serif:
    fontFamily: "Songti SC, Noto Serif SC, Source Han Serif SC, SimSun, serif"
    usage: "仅作为字体栈里的中文回退段出现，不单独用作 --font-doc"
  font-cjk-sans:
    fontFamily: "PingFang SC, Hiragino Sans GB, Microsoft YaHei, sans-serif"
    usage: "同上，界面字栈的中文回退段"
  font-doc:
    fontFamily: "var(--font-serif)（默认）｜由 [data-font] 覆盖为 --font-ui / 霞鹜文楷 / --font-mono"
    usage: "正文与编辑区。用户可在设置里换预设，所有正文样式必须走它，不要写死 --font-serif"

  # 字号刻度（只有 4 档 + 1 个正文变量，不要再造第 5 档）
  fs-xs:
    fontSize: 11.5px
    usage: "时间戳、计数、徽标、分组小标题、kbd、状态栏"
  fs-sm:
    fontSize: 12.5px
    usage: "说明句、次要按钮、列表条目、设置里的辅助文字"
  fs-md:
    fontSize: 13.5px
    usage: "界面默认字号（body 的字号）、按钮、树行、菜单项"
  fs-lg:
    fontSize: 15px
    usage: "品牌名、命令面板输入框、收件箱主标题"
  doc-fs:
    fontSize: 16.5px
    usage: "正文。可被用户设置覆盖（root.style.setProperty），源码里禁止写死"
  doc-lh:
    lineHeight: 1.78
    usage: "正文行高。同上，可被用户设置覆盖"
  tracking-wide:
    letterSpacing: 0.08em
    usage: "全大写分组小标题专用（配 text-transform: uppercase）"

rounded:
  sm: 5px        # --radius-sm：按钮、输入框、树行、菜单项、标签页
  md: 8px        # --radius：卡片、代码块、图片、**对话框与命令面板**（= 桌面端窗口边框的圆角）
  lg: 14px       # --radius-lg：只剩拖放遮罩 .app.is-dropping::after
  micro: 4px     # 直接写的 4px：kbd、tab__close、segmented 按钮、行内码。历史值，不要再扩散
  seal-sm: 5px   # .seal 印章
  seal-boot: 11px
  seal-empty: 12px
  pill: 99px     # 药丸：toast、tag、switch 轨道、storage-bar、滚动条滑块
  pill-alt: 999px
  full: "50%"    # 圆点：statusbar__dot、tab__dirty、busy__spinner

spacing:
  s1: 4px
  s2: 8px
  s3: 12px
  s4: 16px
  s5: 24px
  s6: 32px
  s7: 48px

motion:
  ease: "cubic-bezier(0.22, 0.61, 0.36, 1)"
  ease-out: "cubic-bezier(0.16, 1, 0.3, 1)"
  dur-fast: 120ms   # hover / 状态切换 / 菜单进场
  dur: 220ms        # 面板与弹层进场 / 侧栏滑动 / toast
  dur-slow: 460ms   # 首屏与空态进场
  keyframes: ["rise", "fade", "pop", "pulse", "spin", "sheen（存在但禁止使用）"]

layout:
  sidebar-w: 268px        # 展开态侧栏宽度的**默认值**；用户可在右边框拖拽（200–520px），真值由 applyUi() 写到 :root
  sidebar-w-min: 200px    # 拖拽下限（树行的「文件夹名 + 计数」还排得下）
  sidebar-w-max: 520px    # 拖拽上限（窗口最窄 900px 时编辑器不被挤没）
  sidebar-collapsed: "display: none（只收身体；头部留在顶行，宽度不变）"
  sidebar-w-overlay: "min(84vw, 320px)"   # ≤820px 时的抽屉宽度
  seal-icon: "public/seal/<accent>-<kind>.png · 22px 显示 / 96px 出图"
  outline-w: 232px
  tabbar-h: 40px
  statusbar-h: 30px
  titlebar-inset: 148px   # 桌面端为 Windows/Linux 原生窗口按钮预留的右上角宽度
  measure: 46rem          # --measure：正文栏宽，用户可切成 38rem / 56rem / 100%

components:
  # ── 基础控件（base.css） ──────────────────────────────────────────────
  btn:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule-strong}"
    typography: "{typography.fs-md}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: "0 10px"
  btn-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    borderColor: "{colors.accent}"
    hover: "filter: brightness(1.06)（底仍是 accent，不变色）"
  btn-ghost:
    backgroundColor: transparent
    borderColor: transparent
    hover: "backgroundColor: {colors.paper-3}"
  btn-danger:
    backgroundColor: transparent
    textColor: "{colors.accent}"
    note: "危险语义只改文字颜色，不改底色。底色留给 .toast--danger"
  btn-primary-danger:
    selector: ".btn.btn--primary.btn--danger"
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    note: "双类选择器提高特异度：两条类单独写时同特异度、后写的赢，--danger 的 color 会盖掉 --primary 的 --accent-ink，按钮变成没有字的色块"
  btn-disabled:
    opacity: 0.45
    cursor: not-allowed
  icon-btn:
    backgroundColor: transparent
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    size: 26px
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
    active: "transform: translateY(0.5px)"
  icon-btn-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  field:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.sm}"
    height: 30px
    padding: "0 9px"
  field-focused:
    borderColor: "{colors.accent-line}"
    boxShadow: "0 0 0 3px {colors.accent-soft}"
    outline: none
  kbd:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-2}"
    borderColor: "{colors.rule-strong}"
    rounded: 4px
    minWidth: 18px
    height: 19px
    borderBottomWidth: 2px
    typography: "{typography.fs-xs}"
  seal:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.seal-sm}"
    size: 22px
    fontFamily: "{typography.font-serif}"
    fontSize: 13px
    boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.32)"

  # ── 外壳 ────────────────────────────────────────────────────────────
  app:
    layout: "grid-template-columns: auto auto minmax(0, 1fr) auto   # [侧栏] [宽度把手] [主体] [大纲]"
    rows: "var(--tabbar-h) minmax(0, 1fr)   # 顶行 = 侧栏头部 + 标签栏；第 2 行 = 侧栏身体 + 编辑器 + 状态栏"
    height: "100vh / 100dvh"
    note: "两行都必须显式限高，否则内部滚动容器永远不溢出"
  sidebar:
    backgroundColor: "color-mix(in srgb, {colors.paper-2} 62%, {colors.paper})"
    borderColor: "{colors.rule}"
    area: "grid-area: 2 / 1 / 3 / 2（它只是身体：工作区下拉 + 四个页签 + 文件树 + 脚注）"
    collapsed: "display: none；头部留在顶行（见 sidebar-head）"
  sidebar-resizer:
    width: 6px
    margin: "-3px（左右各 -3px → 列宽 0，骑在侧栏右边框上）"
    area: "grid-area: 1 / 2 / 3 / 3（跨两行）；收起时只跨顶行"
    cursor: "col-resize"
    desktop: "-webkit-app-region: no-drag（它不在 .sidebar__head 里，那条「子元素自动 no-drag」管不到）"
  sidebar-head:
    area: "grid-area: 1 / 1 / 2 / 2（顶行，与 .tabbar 同一行；不是 .sidebar 的子元素）"
    width: "{layout.sidebar-w}（恒为拖出来的宽度，收起时也不变 → 标签栏不跳）"
    height: "{layout.tabbar-h}"
    backgroundColor: "color-mix(in srgb, {colors.paper-2} 62%, {colors.paper})"
    borderColor: "{colors.rule}（下边框与右边框都要自己带）"
    desktop: "-webkit-app-region: drag（子元素一律 no-drag）"
  sidebar-logo:
    size: "22 × 22"
    source: "public/seal/<accent>-<kind>.png（4 套强调色 × 明/暗，pnpm icons 生成）"
  sidebar-tab:
    height: 26px
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  sidebar-tab-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    fontWeight: 600
  workspace-button:
    backgroundColor: "{colors.paper-2}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.sm}"
    height: 30px
    hover: "{colors.paper-3} 底 + {colors.ink-3} 边框"
  tree-row:
    backgroundColor: transparent
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    minHeight: 27px
    padding: "3px 8px 3px 6px"
    gap: 6px
    hover: "{colors.paper-3} 底 + {colors.ink} 字（图标转 {colors.accent}）"
  tree-row-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
    fontWeight: 550
  tree-row-drop:
    backgroundColor: "{colors.accent-soft}"
    boxShadow: "inset 0 0 0 1.5px {colors.accent-line}"
  tree-group:
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-xs} + {typography.tracking-wide} + uppercase"
    note: "::after 一条 flex:1 的 1px {colors.rule} 横线填满右侧"
  tree-meta:
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-xs}"
    fontVariantNumeric: tabular-nums
  tabbar:
    backgroundColor: "color-mix(in srgb, {colors.paper-2} 40%, {colors.paper})"
    borderColor: "{colors.rule}"
    height: "{layout.tabbar-h}"
  tab:
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-md}"
    minWidth: 108px
    maxWidth: 220px
    borderRight: "1px solid {colors.rule}"
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  tab-active:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    fontWeight: 550
    indicator: "::after 2px {colors.accent} 下划线，inset: auto 0 -1px 0"
  tab-dirty:
    backgroundColor: "{colors.accent}"
    size: 5px
    rounded: "{rounded.full}"
  statusbar:
    backgroundColor: "color-mix(in srgb, {colors.paper-2} 45%, {colors.paper})"
    borderColor: "{colors.rule}"
    height: "{layout.statusbar-h}"
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-xs}"
  statusbar-item:
    height: 20px
    padding: "0 6px"
    rounded: 4px
    fontVariantNumeric: tabular-nums
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  statusbar-item-on:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
  statusbar-dot:
    size: 6px
    rounded: "{rounded.full}"
    backgroundColor: "{colors.ink-3}"
  statusbar-dot-dirty:
    backgroundColor: "{colors.accent}"
    animation: "pulse 1.8s {motion.ease} infinite"
  outline:
    backgroundColor: "color-mix(in srgb, {colors.paper-2} 40%, {colors.paper})"
    borderColor: "{colors.rule}"
    width: "{layout.outline-w}"
  outline-head:
    height: "{layout.tabbar-h}"
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-xs} + {typography.tracking-wide} + uppercase"
  outline-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
    padding: "3px 8px"
    borderLeft: "2px solid transparent"
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  outline-item-current:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    borderLeftColor: "{colors.accent}"
  editor-host:
    backgroundColor: "{colors.paper}"

  # ── 浮层与弹层 ──────────────────────────────────────────────────────
  overlay-root:
    position: "fixed; inset: 0"
    zIndex: 60
    display: "grid; place-items: center"
    padding: 20px
  scrim:
    background: "color-mix(in srgb, {colors.paper-4} 30%, rgb(20 16 12 / 0.32))"
    backdropFilter: "blur(3px) saturate(0.9)"
    animation: "fade 120ms {motion.ease} both"
  scrim-menu:
    background: "rgb(20 16 12 / 0.28)"
    backdropFilter: "blur(2px)"
    zIndex: 55
  dialog:
    backgroundColor: "{colors.paper-2}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.lg}"
    boxShadow: "{effects.shadow-3}"
    width: "min(560px, calc(100vw - 32px))"
    maxHeight: "min(82vh, 760px)"
    animation: "pop 220ms {motion.ease-out} both"
  dialog-wide:
    width: "min(760px, calc(100vw - 32px))"
  dialog-settings:
    width: "min(900px, calc(100vw - 32px))"
  dialog-tall:
    height: "min(600px, calc(100vh - 96px))"
    note: "设置面板与收件箱共用同一高度，只写在这一处；滚动交给内部各自的容器"
  dialog-head:
    padding: "16px 16px 12px"
    borderColor: "{colors.rule}"
  dialog-title:
    fontFamily: "{typography.font-display}"
    fontSize: 17px
    fontWeight: 600
    letterSpacing: "-0.01em"
  dialog-foot:
    backgroundColor: "color-mix(in srgb, {colors.paper-3} 40%, {colors.paper-2})"
    borderColor: "{colors.rule}"
    padding: "12px 16px"
  palette:
    backgroundColor: "{colors.paper-2}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.lg}"
    boxShadow: "{effects.shadow-3}"
    width: "min(620px, calc(100vw - 32px))"
    maxHeight: "min(66vh, 640px)"
  palette-input:
    height: 48px
    fontSize: 15px
    borderColor: "{colors.rule}"
  palette-item:
    textColor: "{colors.ink-2}"
    padding: "7px 10px"
    rounded: "{rounded.sm}"
  palette-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  palette-kind:
    textColor: "{colors.ink-3}"
    typography: "{typography.fs-xs} + {typography.tracking-wide} + uppercase"
  menu:
    backgroundColor: "{colors.paper-2}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.md}"
    boxShadow: "{effects.shadow-2}"
    minWidth: 190px
    padding: 5px
    zIndex: 80
    animation: "pop 120ms {motion.ease-out} both"
  menu-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-md}"
    padding: "6px 8px"
    rounded: "{rounded.sm}"
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  menu-item-danger:
    textColor: "{colors.accent}"
  menu-sep:
    backgroundColor: "{colors.rule}"
    height: 1px
    margin: "5px 4px"

  # ── 反馈 ────────────────────────────────────────────────────────────
  toast-root:
    position: "fixed; left: 50%; bottom: 44px"
    transform: "translateX(-50%)"
    zIndex: 90
    pointerEvents: none
    note: "带动作的按钮必须自己 pointer-events: auto，否则点不到"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    maxWidth: "min(420px, 100vw - 32px)"
    padding: "8px 14px"
    typography: "{typography.fs-md}"
    boxShadow: "{effects.shadow-2}"
    animation: "rise 220ms {motion.ease-out} both"
  toast-msg:
    selector: ".toast__msg"
    note: "min-width:0 + 溢出三件套，消息恒单行省略。标题过长尾部截断，药丸不许长成两行板砖"
  toast-body:
    selector: ".toast__body"
    note: "仅次级说明存在时（撤销降级）：列向包住 .toast__msg + .toast__sub，gap 2px"
  toast-sub:
    selector: ".toast__sub"
    typography: "{typography.fs-xs}"
    opacity: 0.78
    note: "降级说明小字行，同样单行省略。小字出现即代表撤销力度变弱，属必须告知的语义差别"
  toast-danger:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
  busy:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill-alt}"
    position: "fixed; left: 50%; bottom: 64px"
    zIndex: 80
  busy-spinner:
    size: 12px
    border: "2px solid currentColor; border-top-color: transparent"
    animation: "spin 0.8s linear infinite"
  empty:
    backgroundColor: "{colors.paper}"
    padding: "{spacing.s6}"
    layout: "grid; place-items: center"
  empty-seal:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.seal-empty}"
    size: 52px
    fontFamily: "{typography.font-serif}"
    fontSize: 30px
    boxShadow: "inset 0 0 0 1.5px rgb(255 255 255 / 0.32), {effects.shadow-2}"
  empty-title:
    fontFamily: "{typography.font-display}"
    fontSize: 26px
    fontWeight: 600
    letterSpacing: "-0.015em"
    fontVariationSettings: "\"SOFT\" 40, \"WONK\" 1"
  choice:
    backgroundColor: "{colors.paper-2}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.md}"
    padding: "12px 14px"
    layout: "grid-template-columns: auto 1fr; gap: 2px 12px"
    hover: "{colors.accent-line} 边框 + {colors.accent-soft} 底"
  choice-active:
    backgroundColor: "{colors.accent-soft}"
    borderColor: "{colors.accent-line}"
    boxShadow: "inset 2px 0 0 {colors.accent}"
    note: "选中必须与 hover 可区分，否则键盘 ↑↓ 看不出落点"
  cmd:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.rule}"
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
    rounded: "{rounded.sm}"
    padding: "7px 10px"
    hover: "{colors.accent-line} 边框 + {colors.accent-soft} 底 + {colors.ink} 字"
  cmd-grid:
    gridTemplateColumns: "repeat(auto-fill, minmax(196px, 1fr))"
    gap: 6px
  tag:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.rule-strong}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.pill}"
    height: 20px
    padding: "0 8px"
    typography: "{typography.fs-xs}"
  storage-notice:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    boxShadow: "{effects.shadow-2}"
    zIndex: 95
    position: "fixed; top: 10px; left: 50%"

  # ── 设置面板 ────────────────────────────────────────────────────────
  settings:
    gridTemplateColumns: "148px minmax(0, 1fr)"
    gap: "{spacing.s4}"
  settings-rail:
    borderRight: "1px solid {colors.rule}"
    paddingRight: "{spacing.s3}"
  settings-tab:
    textColor: "{colors.ink-2}"
    padding: "7px 10px"
    rounded: "{rounded.sm}"
    hover: "{colors.paper-3} 底 + {colors.ink} 字"
  settings-tab-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
    fontWeight: 600
  settings-pane:
    maxHeight: "min(62vh, 560px)"
  setting:
    layout: "132px 标签列 + 1fr 控件列"
    padding: "{spacing.s3} 0"
    borderBottom: "1px solid {colors.rule}"
  setting-label:
    width: 132px
    fontWeight: 550
    typography: "{typography.fs-md}"
  setting-stack:
    note: "≤720px 或长控件时改为上下堆叠：.setting--stack 把 display 变 block"

  # ── 表单小控件 ──────────────────────────────────────────────────────
  segmented:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.rule-strong}"
    rounded: "{rounded.sm}"
    padding: 2px
    gap: 2px
  segmented-button:
    height: 24px
    padding: "0 10px"
    rounded: 4px
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
  segmented-button-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.accent}"
    fontWeight: 600
  switch:
    trackWidth: 34px
    trackHeight: 19px
    trackBackground: "{colors.paper-4}"
    borderColor: "{colors.rule-strong}"
    knobSize: 13px
    knobBackground: "{colors.paper-2}"
    knobShadow: "{effects.shadow-1}"
    checked: "轨道转 {colors.accent}，滑块 translateX(15px)，120ms"
  swatch:
    height: 30px
    padding: "0 10px 0 7px"
    borderColor: "{colors.rule-strong}"
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-2}"
    rounded: "{rounded.sm}"
    typography: "{typography.fs-sm}"
    hover: "{colors.ink-3} 边框"
  swatch-active:
    borderColor: "{colors.accent}"
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  swatch-dot:
    size: 13px
    rounded: 4px
    boxShadow: "inset 0 0 0 1px rgb(0 0 0 / 0.12)"
  range:
    accentColor: "{colors.accent}"
    output: "min-width: 52px; {typography.fs-sm}; {colors.ink-3}; tabular-nums"
  storage-bar:
    height: 6px
    rounded: "{rounded.pill}"
    trackBackground: "{colors.paper-4}"
    fillBackground: "{colors.accent}"

  # ── 两栏面板（历史 / 收件箱共用骨架） ────────────────────────────────
  history:
    gridTemplateColumns: "190px minmax(0, 1fr)"
    gap: "{spacing.s4}"
    minHeight: 300px
  history-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
    padding: "7px 9px"
    rounded: "{rounded.sm}"
  history-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  history-preview:
    backgroundColor: "{colors.paper}"
    borderColor: "{colors.rule}"
    rounded: "{rounded.md}"
    padding: "{spacing.s3}"
    fontFamily: "{typography.font-mono}"
    maxHeight: "54vh"
  inbox:
    gridTemplateColumns: "200px minmax(0, 1fr)"
    gridTemplateRows: "minmax(0, 1fr)"
    gap: "{spacing.s4}"
  inbox-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.fs-sm}"
    padding: "7px 9px"
    rounded: "{rounded.sm}"
    borderLeft: "2px solid transparent"
  inbox-item-active:
    backgroundColor: "{colors.accent-soft}"
    textColor: "{colors.ink}"
  inbox-item-error:
    borderLeftColor: "{colors.accent}"
    note: "失败原因 .inbox__sub 用 {colors.accent}，不用 --ink-3"
  inbox-field-err:
    borderLeft: "2px solid {colors.accent}"
    textColor: "{colors.ink}"
    backgroundColor: "{colors.paper}"
    typography: "{typography.fs-sm}"

  # ── 正文层（prose.css，编辑 / 预览 / 打印共用） ──────────────────────
  prose:
    fontFamily: "{typography.font-doc}"
    fontSize: "{typography.doc-fs}"
    lineHeight: "{typography.doc-lh}"
    textColor: "{colors.ink}"
    fontVariantLigatures: "common-ligatures"
    hangingPunctuation: "first allow-end"
  prose-h1:
    fontSize: "1.85em"
    fontWeight: 600
    lineHeight: 1.32
    letterSpacing: "-0.012em"
    borderBottom: "2px solid {colors.rule}"
  prose-h2:
    fontSize: "1.45em"
    borderBottom: "1px solid {colors.rule}"
  prose-h3:
    fontSize: "1.2em"
  prose-h4:
    fontSize: "1.06em"
  prose-h5:
    fontSize: "0.95em"
    textColor: "{colors.ink-2}"
  prose-h6:
    fontSize: "0.83em"
    textColor: "{colors.ink-3}"
    letterSpacing: "{typography.tracking-wide}"
    textTransform: uppercase
  prose-strong:
    fontWeight: 650
  prose-mark:
    backgroundColor: "{colors.mark}"
    rounded: 3px
    padding: "0.06em 0.22em"
  prose-code:
    fontFamily: "{typography.font-mono}"
    fontSize: "0.875em"
    backgroundColor: "{colors.code-bg}"
    borderColor: "{colors.rule}"
    rounded: 4px
    padding: "0.12em 0.34em"
  prose-pre:
    backgroundColor: "{colors.code-bg}"
    borderColor: "{colors.rule}"
    borderLeft: "2px solid {colors.accent-line}"
    rounded: "{rounded.md}"
    padding: "0.9em 1.05em"
  prose-link:
    textColor: "{colors.accent}"
    borderBottom: "1px solid {colors.accent-line}"
  prose-blockquote:
    borderLeft: "2px solid {colors.rule-strong}"
    textColor: "{colors.ink-2}"
    paddingLeft: "1.1em"
  prose-table:
    fontSize: "0.94em"
    cellBorder: "1px solid {colors.rule}"
    cellPadding: "0.42em 0.7em"
    headBackground: "{colors.paper-3}"
    headWeight: 600
  prose-img:
    rounded: "{rounded.md}"
    boxShadow: "{effects.shadow-1}"
    backgroundColor: "{colors.paper-2}"
  prose-task-checkbox:
    size: "1.02em"
    border: "1.5px solid {colors.rule-strong}"
    rounded: 4px
    checkedBackground: "{colors.accent}"
    checkedBorder: "{colors.accent}"
    checkedTick: "2px {colors.accent-ink} 的 ◣ 折角，rotate(42deg)"
  prose-hr:
    style: "dinkus —— 三个 3px 圆点，gap 0.55em，{colors.ink-3}"
  prose-note:
    note: "脚注 {typography.fs-sm} 档的 0.88em，上方 1px {colors.rule} 分隔线"

  # ── 编辑区（editor.css，CodeMirror） ────────────────────────────────
  md-h1:
    fontSize: "1.85em"
    lineHeight: 1.28
    fontWeight: 600
    letterSpacing: "-0.014em"
    borderBottom: "2px solid {colors.rule}"
  md-h6:
    fontSize: "0.84em"
    textTransform: uppercase
    letterSpacing: "{typography.tracking-wide}"
    textColor: "{colors.ink-3}"
  md-strong:
    fontWeight: 650
  md-mark:
    backgroundColor: "{colors.mark}"
    rounded: 3px
    padding: "0.04em 0.16em"
  md-code:
    fontFamily: "{typography.font-mono}"
    fontSize: "0.875em"
    backgroundColor: "{colors.code-bg}"
    borderColor: "{colors.rule}"
    rounded: 4px
    padding: "0.1em 0.32em"
  md-wikilink:
    textColor: "{colors.accent}"
    backgroundColor: "{colors.accent-soft}"
    rounded: 4px
    padding: "0.08em 0.34em"
    hover: "backgroundColor: color-mix(in srgb, {colors.accent} 22%, transparent)"
  md-wikilink-missing:
    textColor: "{colors.ink-3}"
    backgroundColor: "{colors.paper-3}"
    border: "1px dashed {colors.rule-strong}"
  md-src:
    textColor: "{colors.ink-3}"
    note: ".md-src / .md-num / .md-table-delim 是「正在编辑的那一行」才露出的语法标记"
  md-bullet:
    textColor: "{colors.accent}"
    fontWeight: 700
  md-quote:
    borderLeft: "2px solid {colors.rule-strong}"
    textColor: "{colors.ink-2}"
    paddingLeft: "14px"
  md-code-line:
    backgroundColor: "{colors.code-bg}"
    backgroundPaintedOn: "::after 伪元素（position: absolute; inset: 0; z-index: -1; border-radius: inherit）—— 不能画在行本身，否则会盖住 .cm-selectionLayer 的选区高亮"
    borderLeft: "2px solid {colors.accent-line}"
    borderRight: "1px solid {colors.rule}"
    fontFamily: "{typography.font-mono}"
    fontSize: "0.86em"
    padding: "0 14px"
  md-code-lang-badge:
    content: "attr(data-lang)"
    backgroundColor: "color-mix(in srgb, {colors.paper-3} 60%, {colors.code-bg})"
    textColor: "{colors.ink-3}"
    fontSize: 10.5px
    textTransform: uppercase
    letterSpacing: "{typography.tracking-wide}"
  md-focus-mode-dim:
    textColor: "color-mix(in srgb, {colors.ink} 26%, transparent)"
    mediaOpacity: 0.35
    mediaFilter: "saturate(0.4)"
---

# Opennote 设计系统

> **这份文件的用途**：让每一次由 AI 生成的界面代码都长得像同一个人写的。
> 它不是灵感板，是**约束清单** —— 里面的每条规则都能在代码里核对，违反它的代码应当返工。
>
> **三条读法**：
> 1. **令牌只有一个产地**：`src/styles/tokens.css`（55 个自定义属性）。写样式一律 `var(--token)`，**不抄字面值**。
> 2. **新界面只由既有零件拼装**。拼不出来 = 设计走偏了，不是「加个新组件」的理由。
> 3. **拿不准时，先翻 §Known Gaps**：那里列着本项目**已知的历史偏差**；新代码**不许**再跟着学。
>
> 相关文档：[`docs/import/03-UI设计规范-剪藏与导入.md`](docs/import/03-UI设计规范-剪藏与导入.md) 是剪藏 / 导入功能的逐界面规范（本文档是它的上位：全局设计语言）；[`README.md`](README.md) 是产品与架构说明。

---

## Overview · 概览

Opennote 是一个**写作工具**，不是一个仪表盘。它的界面只有一个材质：**纸与墨**。整个应用坐在同一张纸上（`--paper`），文字是墨（`--ink`），分隔线是纸的折痕（`--rule`）而不是墨线。品牌电压来自由此产生的克制感 —— 没有渐变、没有玻璃拟态、没有彩色卡片、没有 emoji 装饰。

三件事定义了它：

1. **一张有纹理的暖纸**。默认主题「素笺」的底色是 `#fbf8f3` —— 暖白，刻意不是纯白。全屏盖一层 3.5% 不透明度的 `feTurbulence` 噪点（`body::before`，`mix-blend-mode: multiply`），让大面积单色不显得像塑料。暗色主题下这层改为 `overlay`。
2. **一枚朱砂印章**。品牌记号是一个圆角方块 + 一圈内描边 + 居中一个宋体「記」字（见 §Shapes）。它出现在启动页、空态、**侧栏左上角**、应用图标里 —— 同一份几何：`scripts/make_icons.py` 生成（`public/favicon.svg` 与 `public/seal/` 的 8 个印章都是它的产物）。侧栏那一枚按强调色 × 明暗出图，其余仍是 CSS 画的（跟随 `--accent`）。
3. **正文与界面的字体分工**。界面用 Figtree 无衬线（`--font-ui`），正文用 Newsreader 衬线（`--font-doc` 默认值），标题用 Fraunces 变体衬线并把 `SOFT 40 / WONK 1` 两个轴打开。这个分工是「编辑与阅读是同一块画布」的视觉表达。

### 关键特征

- **只有两种「表面」**：纸（`--paper` 四档）与墨（`--ink` 三档）。层级靠**纸的白度差**和 **1px 描边**表达，不靠阴影。阴影只在真的浮起来的东西上用（对话框、菜单、toast）。
- **强调色稀缺且语义单一**：`--accent` 表示「需要你处理」——主按钮、当前选中项、危险操作、错误文字、焦点环。它**不**表示「成功」。
- **没有一个语义色令牌**。没有成功绿、警告黄、失败红。这是刻意的：强调色有 4 套（朱砂 / 靛青 / 松绿 / 藤黄），用户可能把强调色设成松绿，那时「成功绿」和强调色就分不清了。状态一律用**文字 + 圆点的填充方式**说（见 §Colors · 语义状态）。
- **界面几乎没有字号**：只有 4 档（11.5 / 12.5 / 13.5 / 15px）加一个用户可调的正文变量（默认 16.5px）。正文以外的字号越少，界面越像一个整体。
- **2 档主要圆角**：`5px`（控件）/ `8px`（卡片**与浮层最外层**，等于桌面端窗口边框的圆角），加药丸 `99px` 和圆点 `50%`。`14px` 只剩拖放遮罩一处。
- **所有交互态只有三档时长**：`120ms`（hover / 状态切换）、`220ms`（面板进场 / 侧栏滑动）、`460ms`（首屏与空态）。缓动只有两条贝塞尔。
- **主题是「换值不换结构」**：5 套调色板 × 4 套强调色 = 20 种组合，全部通过 CSS 自定义属性重绑定实现。**没有任何一条 CSS 规则判断「现在是哪个主题」**（除 `tokens.css` 里的调色板定义区）。

---

## Colors · 颜色

### 令牌命名法

颜色令牌共 **16 个**（12 个调色板色 + 4 个强调色），另有 **4 个阴影令牌 + 1 个颗粒强度**。名字描述的是**角色**而不是色相：

| 令牌 | 角色 | 用在哪 |
| --- | --- | --- |
| `--paper` | 页面底 | `body`、`.editor-host`、`.empty`、`.cmd` 底 |
| `--paper-2` | 抬高一层 | 卡片、输入框、对话框、菜单、浮层、`kbd` |
| `--paper-3` | 再抬高 / hover | 列表行 hover、表头底、次级底 |
| `--paper-4` | 最深一档 | 开关轨道槽、存储条槽、`.tab__close:hover` |
| `--ink` | 正文墨 | 标题、主要文字、`.toast` 底（反色） |
| `--ink-2` | 次要墨 | 条目正文、说明句、按钮字、菜单项 |
| `--ink-3` | 提示墨 | 时间戳、计数、分组小标题。**对比度不足，用途受限**（见 §Accessibility） |
| `--rule` | 折痕 | 所有 1px 分隔线 |
| `--rule-strong` | 控件描边 | 按钮、输入框、卡片、菜单的边框 |
| `--code-bg` | 代码底 | 行内码、代码块、令牌串、路径 |
| `--mark` | 高亮 | `==高亮==`。**全系统只有一个高亮色** |
| `--sel` | 选区 | `::selection` |
| `--shadow-c` | 阴影基色 | 只以 `rgb(var(--shadow-c) / α)` 形式被三个阴影令牌消费。**不是颜色**，是 RGB 三分量 |
| `--shadow-1/2/3` | 三级阴影 | 见 §Elevation & Depth（不是颜色） |
| `--grain` | 颗粒强度 | `body::before` 的不透明度。**不是颜色**，是一个 0–1 的数值 |
| `--accent` | 强调 | 主按钮底、选中态底/字、危险、错误、焦点环、品牌印章 |
| `--accent-ink` | 强调上的字 | 主按钮文字、印章里的字 |
| `--accent-soft` | 强调的淡底 | 选中行底、`.btn:hover` 之外的选中块、聚焦外圈 |
| `--accent-line` | 强调的描边 | 焦点环、`is-active` 边框、引用块左线、代码块左线 |

> **`--accent-soft` 与 `--accent-line` 是 rgba，不是给文字用的颜色**。它们只能当**背景**与**边框**。需要「强调色的文字」时用 `--accent` 本身。

### 5 套调色板

主题由 `<html data-theme="…">` 选择。**亮色 3 套 + 暗色 2 套**：

| 令牌 | 素笺 `paper`（默认） | 青瓷 `celadon` | 琥珀 `sepia` | 夜读 `night` | 砚池 `ink` |
| --- | --- | --- | --- | --- | --- |
| `--paper` | `#fbf8f3` | `#f4f7f5` | `#faf3e6` | `#14120f` | `#0e1113` |
| `--paper-2` | `#fffdf9` | `#fbfdfc` | `#fffbf3` | `#1c1915` | `#151a1d` |
| `--paper-3` | `#f2ece1` | `#e8efec` | `#f1e6d2` | `#262119` | `#1d2428` |
| `--paper-4` | `#e9e1d3` | `#dde7e2` | `#e6d8bf` | `#322b21` | `#273034` |
| `--ink` | `#221d17` | `#17221f` | `#2a2118` | `#eae3d7` | `#dfe6e6` |
| `--ink-2` | `#5c5347` | `#4c5c57` | `#6a5a45` | `#b0a796` | `#9faeae` |
| `--ink-3` | `#97897a` | `#86968f` | `#9d8a70` | `#7d7466` | `#6e7d7e` |
| `--rule` | `#e8dfd1` | `#dce5e1` | `#e7d9c0` | `#2e2820` | `#232b2f` |
| `--rule-strong` | `#d7cbb8` | `#c6d3cd` | `#d3c1a2` | `#413930` | `#333d42` |
| `--code-bg` | `#f4eee4` | `#eaf0ed` | `#f3e9d8` | `#1f1b15` | `#161c20` |
| `--mark` | `#f6e3a8` | `#d7ecd6` | `#f3dfa6` | `#4a3b1e` | `#2c3b33` |
| `--sel` | `rgba(178,58,46,.16)` | `rgba(47,111,94,.16)` | `rgba(168,100,42,.18)` | `rgba(224,102,79,.24)` | `rgba(79,181,154,.22)` |
| `--shadow-c` | `52 39 22` | `22 44 38` | `60 44 20` | `0 0 0` | `0 0 0` |
| `--grain` | `0.035` | `0.03` | `0.045` | `0.05` | `0.04` |
| `color-scheme` | light | light | light | dark | dark |

**取向**：三套亮色主题**都是暖的或中性的，没有一套是冷灰**；两套暗色里「夜读」偏暖（写字用）、「砚池」偏冷（高对比）。`--shadow-c` 在亮色主题下是**带色相的深色**（不是纯黑），阴影因此偏暖；暗色主题下改为 `0 0 0` 并把 α 值拉高（`.4 / .5 / .8`）。

### 4 套强调色

强调色是**独立于主题的第二维**，由 `<html data-accent="…">` 选择。每套在亮 / 暗环境各有一个取值（写在同一段 CSS 里，用 `[data-theme="night"]` / `[data-theme="ink"]` 组合选择器覆盖）：

| 强调色 | 亮色 `--accent` | 亮色 `--accent-ink` | 暗色 `--accent` | 暗色 `--accent-ink` |
| --- | --- | --- | --- | --- |
| 朱砂 `seal`（默认） | `#b23a2e` | `#ffffff` | `#e0664f` | `#1a0f0c` |
| 靛青 `indigo` | `#34558b` | `#ffffff` | `#7ea6e0` | `#0b1420` |
| 松绿 `pine` | `#2f6f5e` | `#ffffff` | `#4fb59a` | `#08130f` |
| 藤黄 `gamboge` | `#9a6b12` | `#ffffff` | `#d9a537` | `#171004` |

`--accent-soft` / `--accent-line` 由同一个色相以 `0.12–0.18` / `0.34–0.40` 的 α 派生（暗色档的 α 略高，因为暗底吃色）。

> **暗色档的 `--accent-ink` 不是白色**。暗色主题下强调色本身是亮的，压在上面的字必须是**深色**（`#1a0f0c` 这类），否则白字压亮橘会糊。**任何时候都不要假设「强调色上的字是白的」**。

### 语义状态：没有语义色，只有「中性」与「需要处理」

这是这套系统最容易被写坏的地方。项目**刻意不提供** `--success` / `--warning` / `--error`。表达状态的唯一方法是：

| 想表达 | 用什么 | 具体做法 | 出处 |
| --- | --- | --- | --- |
| **中性结果 / 一般通知** | 墨色药丸 | `.toast`：`--ink` 底 + `--paper` 字 | `app.css .toast` |
| **需要处理 / 失败 / 危险** | 强调色药丸 | `.toast--danger`：`--accent` 底 + `--accent-ink` 字 | `app.css .toast--danger` |
| **危险菜单项** | 只改文字色 | `.menu__item.is-danger`：`color: var(--accent)`，**不动底色** | `app.css .menu__item.is-danger` |
| **行级错误** | 左侧 2px 强调色竖线 | `.inbox__item.is-error`：`border-left-color: var(--accent)`；原因句用 `--accent` | `app.css .inbox__item.is-error` |
| **行内错误说明块** | 左侧 2px 竖线 + 正常墨色文字 | `.inbox__field-err`：`border-left: 2px solid var(--accent)` + `color: var(--ink)` | `app.css .inbox__field-err` |
| **连接 / 保存状态** | **圆点的填充方式 + 一句文字** | 6px 圆点：实心 `--ink-3`（空闲）、`--accent`（就绪）、脉冲 `pulse 1.8s`（进行中）、空心描边（未知）。见 `.statusbar__dot` / `.status-chip` | `app.css .statusbar__dot`、`extension/src/popup/popup.css .status-chip` |

**绝不要**引入一个颜色来表示成功或失败。理由（原话见 `docs/import/03-UI设计规范-剪藏与导入.md` §6.2）：强调色有 4 套，用户把它设成松绿时，「成功绿」将与强调色无法区分；而且两套暗色主题会把某个绿色吃掉。

### 混色而不是加色：`color-mix()` 是这套系统的「第五档」

需要用「比现有令牌淡一点 / 深一点」的中间色时，**不要新增令牌，也不要写 rgba** —— 用 `color-mix()` 混两个既有令牌。项目里已有的混色点构成一套可复用的配方：

| 用途 | 配方 | 出处 |
| --- | --- | --- |
| 外壳三级的「染色纸」 | 侧栏 `paper-2` 62% ← 底栏 45% ← 顶栏 / 大纲 40%（百分比越高越白） | `.sidebar` / `.statusbar` / `.tabbar` / `.outline` |
| 面板脚注条 | `color-mix(in srgb, var(--paper-3) 40%, var(--paper-2))` | `.dialog__foot` / `.inbox__bar` |
| 代码块的语言徽标条 | `color-mix(in srgb, var(--paper-3) 60%, var(--code-bg))` | `.prose .code-lang` / `.md-code-first[data-lang]` |
| 遮罩 | `color-mix(in srgb, var(--paper-4) 30%, rgb(20 16 12 / 0.32))` + `backdrop-filter: blur(3px) saturate(.9)` | `.scrim` |
| 表格行 hover | `color-mix(in srgb, var(--paper-3) 55%, transparent)` | `.prose tbody tr:hover` |
| 搜索命中底色 | `color-mix(in srgb, var(--mark) 75%, transparent)` | `mark.hit` |
| wiki 链接 hover | `color-mix(in srgb, var(--accent) 22%, transparent)` | `.md-wikilink:hover` |
| 选中分类的次级说明 | `color-mix(in srgb, var(--accent) 70%, var(--ink-3))` | `.settings__tab.is-active small` |
| 专注模式里淡出的行 | `color-mix(in srgb, var(--ink) 26%, transparent)` | `.md-focus-mode .cm-line` |
| 语法高亮 8 个 token | 全部由 `--accent` 与 `--ink*` 按 30–82% 混出，见下 | `.tok-*` |

**语法高亮的做法值得单独记住**：代码高亮没有自己的配色表，8 个 `.tok-*` 类**全部**是 `--accent` 与墨色按不同比例混出的（关键字 82% accent、字符串 46%、数字 62%、函数 30%、类型 70%，注释直接用 `--ink-3` 斜体）。因此代码块的颜色**跟着强调色走**，换强调色时高亮整套协调变化。这是这套系统里最漂亮的一个决定，不要用第三方高亮主题替换它。

---

## Typography · 字体

### 字体分工

四个字体栈，各有明确职责，**不要互相借用**：

| 令牌 | 家族 | 职责 |
| --- | --- | --- |
| `--font-ui` | **Figtree** Variable → `system-ui`, PingFang SC, Hiragino Sans GB, Microsoft YaHei | **所有界面文字**。`body` 的默认字体，按钮、标签、菜单、状态栏、树行 |
| `--font-doc` | **Newsreader** Variable → Iowan Old Style, Georgia, Songti SC, Noto Serif SC, SimSun | **正文**。默认 `var(--font-serif)`，可被用户换成黑体 / 霞鹜文楷 / 等宽 |
| `--font-display` | **Fraunces** Variable → Newsreader, Georgia, Songti SC | **品牌与标题**：`.sidebar__name`、`.empty__title`、`.dialog__title` |
| `--font-mono` | **JetBrains Mono** Variable → ui-monospace, Cascadia Code, Consolas | 代码、路径、端口、令牌串、表格源码、时间戳对齐 |
| `--font-cjk-serif` / `--font-cjk-sans` | Songti SC… / PingFang SC… | **只是上面字体栈里的中文回退段**，不要单独用作 `font-family` |

**Fraunces 是变体字体，用它的地方必须打开两个轴**：

```css
font-variation-settings: "SOFT" 40, "WONK" 1;
```

这是 `.sidebar__name` 与 `.empty__title` 都带的一行。不加它，Fraunces 会是默认的硬朗字形，品牌感就没了。

### 字号刻度

只有 4 档界面字号 + 1 个正文变量：

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--fs-xs` | 11.5px | 时间戳、计数、徽标、分组小标题（配 uppercase + `--tracking-wide`）、`kbd`、状态栏、`<small>` 说明 |
| `--fs-sm` | 12.5px | 说明句、次要按钮、列表条目、设置辅助文字、菜单里的次级行 |
| `--fs-md` | 13.5px | **界面默认**（`body` 的字号）。按钮、树行、菜单项、输入框 |
| `--fs-lg` | 15px | 品牌名、命令面板输入框、收件箱主标题 |
| `--doc-fs` | 16.5px | **正文**。用户可在设置里调，运行时由 `root.style.setProperty("--doc-fs", …)` 覆盖 |
| `--doc-lh` | 1.78 | **正文行高**。同上可由用户覆盖 |

**正文里的字号是相对的**：`.prose` 与 `.cm-content` 里的标题用 `em`（h1 `1.85em`、h2 `1.45em`、h3 `1.2em`、h4 `1.06em`、h5 `0.95em`、h6 `0.83em/0.84em`），代码 `0.875em`（行内）/ `0.85em`（块内），表格 `0.94em`，脚注 `0.88em`。这样用户调 `--doc-fs` 时整篇**等比缩放**，不需要逐条改。

### 层级与字重

- **正文层级靠字号，不靠粗细**。`.prose h1/h2/h3` 的都是 `font-weight: 600`，层级差完全由 `em` 字号 + 上边距 + `border-bottom`（h1 两像素、h2 一像素）承担。
- **`--tracking-wide: 0.08em` 只给全大写小标题**。用到它的地方必须同时有 `text-transform: uppercase`。全仓共 11 处：`app.css` 里 5 处（`.tree__group`、`.outline__head`、`.inbox__group`、`.palette__kind`、`.empty__recent h4`）、`prose.css` 2 处（`.prose h6`、`.code-lang`）、`editor.css` 2 处（`.md-h6`、代码块语言徽标）、`clip.css` 与扩展 `popup.css` 各 1 处。中文标题**不要**用 uppercase（无效果），也不要用这么宽的字距。
- **标题字距一律为负**：`.empty__title -0.015em`、`.dialog__title -0.01em`、`.sidebar__name -0.01em`、正文 h1 `-0.012em` / 编辑区 h1 `-0.014em`。这是衬线标题不显得松散的关键。
- **强调用 `--accent`，不用加粗**。选中态普遍是 `font-weight: 550/600` + `--accent-soft` 底；正文里的强调是 `font-weight: 650`（`.prose strong`）—— 注意正文的强调字重是 **650**，不是 700。
- **`font-synthesis-weight: none`** 写在 `body` 上。不要引入会导致字体被浏览器伪加粗的字重（除非该字体真有那个字重）。

### 数字对齐

**所有会变化的数字都用 `font-variant-numeric: tabular-nums`**：`.tree__meta`（文件计数）、`.statusbar__item`（字数 / 行列）、`.range output`（滑块数值）、`.inbox` 里的时间。否则字数从 99 涨到 100 时整行会轻微跳动。

---

## Layout · 布局

### 间距刻度

只有 7 档，`4 → 8 → 12 → 16 → 24 → 32 → 48`（`--s1`…`--s7`），基数是 4px。

| 令牌 | 值 | 典型用途 |
| --- | --- | --- |
| `--s1` | 4px | 图标与文字之间的微调、列表项内 gap、树行的 `gap: 6px` 附近 |
| `--s2` | 8px | 按钮内部 gap、图标按钮组、树行内边距、设置行内 gap |
| `--s3` | 12px | 面板内边距、侧栏头部水平内边距、对话框脚注内边距 |
| `--s4` | 16px | 对话框正文内边距、两栏面板的 gap、设置行距 |
| `--s5` | 24px | 收件箱空态留白、空态按钮组上边距、大块留白 |
| `--s6` | 32px | 整屏空态的内边距、剪藏页预览区留白 |
| `--s7` | 48px | 剪藏页居中层的大留白 |

**不要出现第 8 档**。历史上出现过 `10px` / `18px` / `5px` / `2px` 这类硬编码值（见 §Known Gaps），但**新代码不要再扩散**：需要 2px / 5px / 6px 时优先用 `--s1` 或 `--s2`，确实需要更小的固定值时说明理由。

### 应用外壳

两行四列，一屏填满，**永不出现页面级滚动条**（滚动只发生在面板内部）。
**顶行只有两样东西**：侧栏头部（記 / Opennote / 三个按钮）与标签栏 —— 它们永远同一行、
同样 40px 高，底边线连成一条。第 2 行才是「侧栏身体 + 编辑器 + 状态栏」。
侧栏宽度把手自己占一列（列宽 0，骑在侧栏右边框上）：

```
                     ┌── .sidebar__head (268px) ──┬───────────────────────────┐
                     │ 記 Opennote      + □ ⇥     │  .tabbar          (40px)   │
                     ├────────────────────────────┼───────────────────────────┤
                     │ .sidebar (身体, 268px)      │  .editor-host    (1fr)     │
                     │ 工作区/页签/文件树/脚注      │                            │
                     │                            ├───────────────────────────┤
                     │                            │  .statusbar       (30px)   │
                     └────────────────────────────┴───────────────────────────┘
          .sidebar__resizer 骑在两者之间（列宽 0）

收起 = 只收起左栏身体（.sidebar → display:none），头部留在顶行；
       编辑器与状态栏绕到头部下面，从 x=0 起占满整宽（.main → grid-column: 1 / 4）。
```

```css
.app {
  display: grid;
  /* [侧栏] [宽度把手] [标签栏 / 编辑器 + 状态栏] [大纲] */
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  /* 顶行 = 头部 + 标签栏；两行都必须显式限高 */
  grid-template-rows: var(--tabbar-h) minmax(0, 1fr);
  height: 100dvh;
  overflow: hidden;
}
```

**`grid-template-rows` 两行都不是可选的**。默认的 `auto` 行会被内容撑高，导致侧栏 / 大纲内部的滚动容器永远不溢出（`min-height: auto` 的老问题）。同理，每个作为 flex/grid 子项的滚动容器都要显式写 `min-height: 0`。

**`.sidebar__head` 为什么不是 `.sidebar` 的子元素**：栅格分区按「行」切，头部要留在第 1 行、身体在第 2 行，所以 `Sidebar` 返回 fragment（头部 + `<aside class="sidebar">`），两者都是 `.app` 的直接子项。头部因此要自己带底色与右边框，宽度**恒为 `var(--sidebar-w)`**（收起时也不变 —— 标签栏就不会跳）。同理 `<TabBar>` 从 `.main` 里搬出来，`.main` 只剩「空态 / 编辑器 + 状态栏」，才能在收起时整块绕到最左。

**`.sidebar__resizer` 为什么是独立一列**：宽度 6px、左右各 `-3px` 外边距，算出来的列宽是 0，把手正好骑在侧栏右边框上（各压 3px）。放进 `.sidebar` 里会盖住文件树自己的滚动条（滚动条滑块只剩 1px 可抓），放进 `.main` 里会被编辑器盖住。它必须写 `min-width: 0`（grid 子项默认 `min-width: auto` 会把这一列撑成 6px），拖拽时挂 `window` 上的 `pointermove` / `pointerup`（**不用 `setPointerCapture`**：指针拖到把手外面就收不到事件了），并显式 `-webkit-app-region: no-drag`。

**侧栏的收起**：`>820px` 是「只收缩左栏」—— 头部与标签栏那一行完全不动，`.sidebar` 身体 `display: none`，`.main` 从第 3 列改成跨第 1–3 列（编辑器与状态栏占满整宽）；`≤820px` 是抽屉：从**顶行下面**（`top: var(--tabbar-h)`）滑出，头部留在上面始终可用，`.scrim--drawer` 也让开顶行。`.outline` 仍是负 `margin-right` 位移。

### 正文栏

- `--measure` 是正文的最大宽度，默认 `46rem`，用户可切 `38rem`（窄）/ `46rem`（标准）/ `56rem`（宽）/ `100%`（满幅）。
- 阅读区默认居中（`.clip__prose { max-width: var(--measure); margin: 0 auto }`）。
- 正文行高 `--doc-lh` 默认 `1.78`（用户可调），**比一般 UI 的 1.6 松得多** —— 这是「一张纸」的感觉来源之一，不要为了「更紧凑」把它收窄。

### 尺寸常量

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `--sidebar-w` | 268px | 展开态侧栏的**默认**宽度。用户在右边框拖拽后由 `applyUi()` 写成内联值（夹取 200–520px）。≤820px 变 `min(84vw, 320px)` 浮层 |
| `--outline-w` | 232px | 大纲面板。≤1080px 整个隐藏 |
| `--tabbar-h` | 40px | 标签栏高度。**侧栏头部也是它**（`height: var(--tabbar-h)`），两条底边线连成一条 |
| `--statusbar-h` | 30px | 状态栏高度（贴着底边，内容多时靠 `.statusbar__item--compact` 隐藏降级） |
| `--titlebar-inset` | 148px | **仅桌面端**：为 Windows/Linux 压右上角的原生窗口按钮留的宽度。见下 |

**桌面窗口的硬约束**（`electron/main.cjs`，改布局时必须知道）：

| 项 | 值 |
| --- | --- |
| 默认窗口 | `width: 1280` × `height: 840` |
| **最小窗口** | `minWidth: 900` × `minHeight: 600` |
| `backgroundColor` | `'#fbf8f3'`（素笺的 `--paper`，防止加载期白闪） |
| 标题栏 | `titleBarStyle: 'hidden'` + Windows/Linux 的 `titleBarOverlay`（macOS 用 `trafficLightPosition: { x: 14, y: 13 }`） |

> **`minWidth: 900` 意味着 `≤820px` 与 `≤720px` 这两档断点在桌面端几乎不会触发** —— 它们服务的是浏览器 / PWA。改桌面端布局时不要拿这两档当借口。
> `electron-builder.yml` **没有**声明任何窗口尺寸（只有 appId / 目标平台 / 打包清单），窗口约束的唯一产地是 `electron/main.cjs`。

### 样式的加载顺序（决定层叠）

`src/main.tsx` 的 CSS 导入顺序是**有意义的**，新样式文件只能插在正确的位置：

```
tokens.css  →  base.css  →  prose.css  →  editor.css  →  app.css
（令牌，无选择器） （重置 + 公共 chrome） （正文层）   （CodeMirror 深选择器） （外壳与界面）
```

- 字体与 KaTeX 的 CSS 在这五个之前导入（`@fontsource-variable/*`、`katex/dist/katex.min.css`）。
- `prose.css` 在 `app.css` **之前**：正文层是基础，界面层负责覆盖。
- `editor.css` 的选择器最深（两到三层），排在它后面的 `app.css` 若也要命中 `.cm-*` 就会争抢层级 —— **不要**在 `app.css` 里写 `.cm-*`。
- 剪藏页（`src/clip-web/main.tsx`）用同一套顺序，只是去掉 `editor.css`、把 `clip.css` 放在最后。

### 桌面端的无边框标题栏

桌面端没有系统标题栏，**应用自己的头部就是标题栏**：

- `.app--desktop .sidebar__head`、`.tabbar`、`.outline__head` 是 `-webkit-app-region: drag`（可拖动窗口），它们的**所有子元素**必须是 `-webkit-app-region: no-drag`（否则按钮点不动）。
- `.sidebar__resizer`（侧栏宽度把手）**不在**头部里，所以那条「子元素自动 no-drag」的规则管不到它 —— 它自己显式写了 `-webkit-app-region: no-drag`。漏了就会变成「拖窗口」。
- `.tabbar` 右侧留 `--titlebar-inset: 148px`；大纲展开时，这块留白**跟着搬到** `.outline__head`（用 `:has()` 选择器）。
- 改动头部区域时**必须**同时检查 `app-region` 与这块留白，否则会出现「窗口拖不动」或「窗口按钮盖住标签」。

---

## Elevation & Depth · 层级与阴影

**默认没有任何阴影。** 层级首先靠**表面色的白度差**与 **1px 描边**表达：

| 层级 | 做法 | 例子 |
| --- | --- | --- |
| 页面底 | `--paper`，无边框无阴影 | `body`、`.editor-host`、`.empty` |
| 染色纸 | `color-mix()` 把 `--paper-2` 掺进 `--paper`（62% / 45% / 40%） | `.sidebar`、`.statusbar`、`.tabbar`、`.outline` |
| 抬高一层的块 | `--paper-2` 底 + `1px --rule-strong` 描边，**无阴影** | `.choice`、`.cmd`（后者用 `1px --rule`）、`.history__preview` |
| 浮起来的层 | `--paper-2` 底 + `1px --rule-strong` 描边 + **阴影** | `.dialog`、`.palette`、`.menu`、`.workspace__menu` |
| 反色药丸 | `--ink` 底 + `--paper` 字 | `.toast`、`.busy`、`.storage-notice` |

三级阴影（亮色主题的实际值）：

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--shadow-1` | `0 1px 2px rgb(var(--shadow-c) / 0.06)` | 贴地的一点点浮起：图片、开关滑块、`.clip__card` |
| `--shadow-2` | `0 2px 6px -2px /0.1, 0 12px 28px -18px /0.28` | 中层浮层：右键菜单、toast、印章方块（配 `inset` 内描边） |
| `--shadow-3` | `0 24px 60px -28px /0.36, 0 2px 8px -4px /0.12` | 最高层：对话框、命令面板、大纲/侧栏浮层、工作区下拉 |

**阴影基色是 `--shadow-c`**（亮色下是 `52 39 22` —— 带暖色相的深棕，不是黑；暗色下是 `0 0 0` 并把 α 提到 `.4–.8`）。写阴影**只能**用 `rgb(var(--shadow-c) / α)` 这个形式，**不要**写 `rgba(0,0,0,…)`。

**内描边（inset ring）是印章专用的**：`.seal` / `.empty__seal` / `.boot__seal` / `.clip__empty .empty__seal` 都用 `box-shadow: inset 0 0 0 1px|1.5px rgb(255 255 255 / 0.32|0.35)` 画那圈纸色的内框。这是**唯一**允许写死白色 rgba 的地方（它是「纸色压在同色相上」的高光，不是主题色）。

### z-index 阶梯（全项目只有这几档）

**新弹层必须落进这张表，不要随手写 999。**

| z-index | 层 | 出处 |
| --- | --- | --- |
| 40 | 工作区（笔记本）下拉 | `.workspace__menu` |
| 55 | 移动端侧栏的遮罩 | `.scrim--menu`（`≤820px` 才 `display: block`） |
| 58 | 移动端侧栏抽屉本身 | `.sidebar`（在 `≤820px` 内） |
| 60 | **模态层**：命令面板 + 所有对话框 | `.overlay-root` |
| 70 | 拖放遮罩 | `.app.is-dropping::after` |
| 80 | 进行中药丸 / 右键菜单 | `.busy` / `.menu`（**两处同值，是既成事实**） |
| 90 | toast | `.toast-root` |
| 95 | 站点数据被禁用的提示条 | `.storage-notice`（`base.css`） |
| 9998 | 启动页 | `.boot`（`base.css`） |
| 9999 | 纸张颗粒（`pointer-events: none`） | `body::before`（`base.css`） |
| 30 | CodeMirror 查找面板（**独立层叠上下文内**） | `.cm-panels`（`editor/theme.ts`） |
| 2147483647 | 扩展注入宿主页面时的元素选择覆盖层 | `extension/src/content/picker.js`（**不是令牌**：它的职责就是盖住任意页面） |

> 空档：41–54、56–57、59、61–69、71–79、81–89、91–94。需要新层时优先用空档，并**同时更新这张表**。

---

## Shapes · 形状

### 圆角刻度

| 令牌 | 值 | 用途 |
| --- | --- | --- |
| `--radius-sm` | 5px | **控件**：`.btn`、`.field`、`.tree__row`、`.menu__item`、`.sidebar__tab`、`.settings__tab`、`.palette__item`、`.cmd`、`.inbox__item`、`.history__item`、`.segmented`（容器）、`.swatch`、`.workspace__button`、`.outline__item` |
| `--radius` | 8px | **卡片、内嵌块、以及所有浮层最外层**：`.choice`、`.history__preview`、`.menu`、`.workspace__menu`、`.dialog`、`.palette`、`.prose pre`、`.prose img`、`.prose .toc`、`.mermaid-block`、`.inbox__preview`、`.seal`（8px 档的空态印章） |
| `--radius-lg` | 14px | 拖放遮罩 `.app.is-dropping::after`（**唯一剩下的用处**：它不是浮层，圆角只影响那圈虚线描边） |
| `99px` / `999px` | 药丸 | `.toast`（99px）、`.tag`（99px）、`.switch` 轨道（99px）、`.storage-bar`（99px）、滚动条滑块（99px）、`.busy`（999px） |
| `50%` | 圆点 | `.statusbar__dot`、`.tab__dirty`、`.busy__spinner`、`.task-checkbox` 的勾 |
| `4px` | 微圆角（**直接写值**） | `kbd`、`.tab__close`、`.segmented button`、`.statusbar__item`、行内码、`.md-wikilink`、`.swatch__dot`、`.md-mark` |

**层级语义**：控件 5px → 卡片 8px → 浮层 8px（= 桌面端窗口边框的圆角）。**外层圆角 ≥ 内层圆角**，不要出现「8px 对话框里放一个 16px 的块」。

> 浮层曾经是 14px。0.4.3 起改成 **8px**：命令面板 / 对话框比窗口本身的圆角还圆，看起来像「贴上去的一块」。

> `4px` 与 `99px` / `999px` 是历史遗留的写法（没有对应令牌，且 `99px` 与 `999px` 两个写法并存）。新代码里药丸一律写 **`99px`**；4px 微圆角是既定观感，可以继续用，但**不要**再写 6px / 7px / 10px 这类第三种值。

### 品牌印章（唯一的图形标识）

印章是「圆角方块 + 一圈纸色内描边 + 居中一个宋体「記」字」。**一个绘制源，四个尺寸档**：

| 场景 | 尺寸 | 圆角 | 字号 | 内描边 | 额外 |
| --- | --- | --- | --- | --- | --- |
| 行内印章 `.seal` | 22px | 5px | 13px | `inset 0 0 0 1px rgba(255,255,255,.32)` | 剪藏页仍用；**主界面左上角改用图标资源**（见下） |
| 侧栏品牌图标 `.sidebar__logo` | 22px | 图形自带 | 图形自带 | 图形自带 | `public/seal/<accent>-<kind>.png` |
| 插件/收件箱空态 | 40px | `--radius` 8px | 23px | `inset 0 0 0 1.5px …` | — |
| 启动页 `.boot__seal` | 46px | 11px | 26px | `inset 0 0 0 1.5px rgba(255,255,255,.35)` | `+ --shadow-2` |
| 整屏空态 `.empty__seal` | 52px | 12px | 30px | `inset 0 0 0 1.5px …` | `+ --shadow-2` |
| 应用图标 | 64 视框 | rx 13 | 40 | 内框 inset 4.5, rx 10, 描边 `#fbf8f3` @ .45 | 见 `public/favicon.svg` |

统一规则：
- 底 = `--accent`，字 = `--accent-ink`，字族 = `--font-serif`（**不是** `--font-display`：印章要的是宋体的方正，不是 Fraunces 的柔和）。
- 印章本身就是「强调色出现的地方」，**不要**再给它加渐变、投影色或旋转。
- **侧栏左上角那枚是图标资源，不是 CSS 画的方块**：`public/seal/<accent>-<kind>.png`（4 套强调色 × 明/暗 = 8 个），由 `pnpm icons` 生成，颜色由 `scripts/make_icons.py` **直接解析 `tokens.css`** 得到并烘焙进 PNG。界面按 `data-accent` + 主题明暗挑文件（`lib/sealIcon.ts` 的 `sealIconUrl(accent, kind)`，路径写成 `./seal/...` 相对形式，桌面版 `file://` 也解析得到）。为什么不用 CSS：`<span>記</span>` + 背景色的形状取决于机器上有没有宋体，也不和窗口/任务栏图标共用同一个绘制源。**改了强调色令牌就要重跑 `pnpm icons`**，否则界面一套色、图标另一套色。
- 图标资源由 `pnpm icons` 从 `scripts/make_icons.py` 生成（favicon / PWA 图标 / 多尺寸 `build/icon.ico` / 侧栏印章集）。应用图标那三份的 `#b23a2e` 是**唯一写死的品牌色**（构建期 PNG 生成器没法读 CSS 变量）；侧栏印章集不写死任何颜色。

### 图标

只有一个图标组件 `Icon`（`src/components/Icons.tsx`），39 个名字，统一的几何契约：

```tsx
<Icon name="folderOpen" size={15} />
// svg: width/height = size，viewBox "0 0 24 24"
//      fill = filled ? "currentColor" : "none"
//      stroke = "currentColor"，strokeWidth = 1.7
//      strokeLinecap/Linejoin = "round"
//      aria-hidden="true"，focusable="false"
```

- **默认尺寸 15**（配 `--fs-md` 的 13.5px 字）。树行 / 菜单 / 按钮里用 14–15；`.tree__caret` 是 14。
- **颜色一律靠 `currentColor` 继承父级**，不要在图标上写 `color` 或 `fill`（`filled` 除外）。父级的 `:hover` / `.is-active` 里改色即可（例：`.tree__row:hover .tree__icon { color: var(--accent) }`）。
- 线宽 `1.7` 是这套图标的手感来源，**不要改成 1.5 或 2**。
- 用的是极简描边图标（feather / lucide 风格），**不要**引入实心图标集或第三方图标字体。

---

## Motion · 动效

**总则：动效只用来解释「东西从哪来、到哪去」，不用来吸引注意。** 全部复用既有的 6 个 `@keyframes` 与 3 档时长。

### 时长与缓动

| 令牌 | 值 | 用在哪 |
| --- | --- | --- |
| `--dur-fast` | 120ms | **hover / 状态切换 / 菜单和遮罩进场**。占绝大多数 |
| `--dur` | 220ms | 面板与弹层进场（`.dialog`、`.palette`、`.busy`）、侧栏滑动、`toast` 进场 |
| `--dur-slow` | 460ms | 只有首屏与整屏空态（`.boot__seal`、`.boot__name`、`.empty__inner`） |
| `--ease` | `cubic-bezier(0.22, 0.61, 0.36, 1)` | 通用（默认选它） |
| `--ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进场动画（`rise` / `pop` 的减速感） |

### 动画清单

| 动画 | 定义 | 用在哪 |
| --- | --- | --- |
| `rise` | 从 `opacity: 0; translateY(6px)` 到无 | `.toast`、`.empty__inner`、`.busy`、启动页三层（错开 0 / 60ms / 120ms）、`.storage-notice` |
| `fade` | 从 `opacity: 0` 到 1 | `.scrim`、`.scrim--menu` |
| `pop` | 从 `opacity: 0; translate: 0 -6px; scale: .985` 到 1 | `.dialog`、`.palette`、`.menu`、`.workspace__menu` |
| `pulse` | `opacity` 1 ↔ .35 | `.statusbar__dot.is-dirty`（1.8s）、`.status-chip.is-busy` 的圆点 |
| `spin` | `rotate(360deg)` | `.busy__spinner`（0.8s linear infinite） |
| `sheen` | 背景位置扫光 | **存在但禁止使用** —— 扫光属于「SaaS 仪表盘」语言 |

> `pop` **故意用独立的 `translate` / `scale` 属性**而不是 `transform` —— 因为对话框靠 `transform: translate(-50%,-50%)` 居中，若 `pop` 动 `transform` 会把居中覆盖掉。改这个动画时不要退回去用 `transform`。

### 明确禁止

1. **列表行不做逐条 stagger 入场**（收件箱条目、最近导入列表）。列表跳动会打断写作。
2. **数字徽标不弹跳**。计数从 0 变 1 不做缩放。
3. **错误不抖动、不闪红**。
4. **按钮 hover 不做位移或缩放**。整个项目里唯一的点击位移是 `.icon-btn:active { transform: translateY(0.5px) }`，新控件沿用这一级。
5. **加载态不用整屏遮罩**。加载只发生在被操作的那个控件上（`.busy` 药丸 / 按钮内的 `.busy__spinner`）。
6. **不使用 `sheen`**。

### 降级

`base.css` 有一处全局降级，新组件**自动继承，不要各自再写一份**：

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

**降级后必须仍然可用**：凡是靠动画表达的状态，必须同时有文字或静态形状。例：`.statusbar__dot.is-dirty` 除了脉冲还有 `--accent` 的实心填充；「正在启动」除了 spinner 还有文字。

> 插件 popup 与内容脚本的 Shadow DOM 是独立文档，**拿不到应用的 CSS**，各自内联同一段降级规则。

---

## Components · 组件

**先看这条原则**：新界面只允许由**既有类名**拼装。任何一个界面如果拼不出来，说明设计走偏了，不是「该加个新组件」。下面按「可直接复用的零件」列出。

### 基础控件

| 组件 | 类名 | 尺寸 / 圆角 | 默认 | hover | 选中 / 激活 | 禁用 |
| --- | --- | --- | --- | --- | --- | --- |
| 按钮 | `.btn` | h28 · `--radius-sm` · `0 10px` · `--fs-md` | `--paper-2` 底 / `--rule-strong` 边 / `--ink` 字 | `--paper-3` 底 | — | `opacity: .45` + `not-allowed` |
| 主按钮 | `.btn.btn--primary` | 同上 | `--accent` 底 / `--accent-ink` 字 | `filter: brightness(1.06)`（**底色不变**） | — | 同 `.btn` |
| 幽灵按钮 | `.btn.btn--ghost` | 同上 | 透明底 + 透明边 | `--paper-3` 底 | — | 同 `.btn` |
| 危险按钮 | `.btn.btn--danger` | 同上 | 文字 `--accent`，**底色不变** | 同 `.btn` | — | 同 `.btn` |
| 危险主按钮 | `.btn.btn--primary.btn--danger` | 同上 | 底 `--accent` + 字 **`--accent-ink`**（双类选择器，见下） | 同 `.btn` | — | 同 `.btn` |
| 图标按钮 | `.icon-btn` | 26×26 · `--radius-sm` | 透明底 / `--ink-2` | `--paper-3` 底 + `--ink` 字 | `.is-active`：`--accent-soft` 底 + `--accent` 字 | — |
| 输入框 | `.field` | h30 · `--radius-sm` · `0 9px` · `--fs-md` | `--paper-2` 底 / `--rule-strong` 边 | — | 聚焦：`--accent-line` 边 + `0 0 0 3px --accent-soft` 外圈，**去掉默认 outline** | — |
| 搜索框 | `.field.field--search` | h28 · 左内边距 28px | 同上 + 内联 SVG 放大镜（`background-image`） | — | — | — |
| 键帽 | `kbd` | min-w18 · h19 · 4px · `--fs-xs` | `--paper-2` 底 / `--rule-strong` 边 / **下边框 2px** | — | — | — |

> `.btn--primary:hover` 用 `filter: brightness(1.06)` 而**不是**换一个更深的颜色 —— 因为强调色有 4 套，写死「更深一档」会需要 8 个额外令牌。

> **`--primary` 与 `--danger` 同时出现时，必须用 `.btn--primary.btn--danger` 这个双类选择器把特异度提上去，让文字色赢**（`color: var(--accent-ink)`）。两条类单独写时同特异度、后写的赢，`--danger` 的 `color: var(--accent)` 会盖掉 `--primary` 的 `--accent-ink` —— 结果是 `color === background`，按钮变成**一块没有字的色块**。危险操作（清空回收站 / 彻底删除 / 丢弃 / 删除文件夹）正是这个组合，改按钮样式时别把这个特例删掉。

### 选择类控件

| 组件 | 类名 | 手感 | 选中态 |
| --- | --- | --- | --- |
| 分段控件 | `.segmented` + `button.is-active` | 整体 `--paper` 底 + `2px` 内衬 + 2px gap，按钮 h24 / 4px / `--fs-sm` | 选中底 `--accent-soft`、字 `--accent`、粗体 600 |
| 开关 | `.switch input` | 轨道 34×19 `--paper-4` + `--rule-strong` 边；滑块 13px `--paper-2` + `--shadow-1` | 轨道转 `--accent`，滑块 `translateX(15px)`，120ms |
| 色板 / 标签选择 | `.swatch` + `.swatch__dot` | h30 `--paper` 底 + `--rule-strong` 边 + `--fs-sm`，左侧 13px 圆角色块 | 边 `--accent`、底 `--accent-soft`、字 `--ink` |
| 滑块 | `.range` + `input[type=range]` | `accent-color: var(--accent)`，右侧 `output` 52px 最小宽 + tabular-nums | — |
| 大号选择卡 | `.choice` | `grid-template-columns: auto 1fr`，图标跨两行并自动 `--accent`，标题 600 + `small` 用 `--ink-3` | `.is-active`：`--accent-soft` 底 + `--accent-line` 边 + **左侧 2px `inset` 强调条** |
| 命令格 | `.cmd`（容器 `.cmd-grid`） | `repeat(auto-fill, minmax(196px, 1fr))`，h 自适应 · `--fs-sm` | hover：`--accent-line` 边 + `--accent-soft` 底 + `--ink` 字 |

> `.choice.is-active` 与 `.choice:hover` 的**视觉必须可区分**（选中多一条左侧 2px 强调条），否则键盘 ↑↓ 移动时看不出落点在哪。

### 列表与行

统一的手感（`.tree__row` 是全项目的行模板，其它列表都是它的变体）：

```
高 27px（min-height）· padding 3px 8px 3px 6px · gap 6px · --fs-md · --radius-sm
默认：--ink-2 字
hover：--paper-3 底 + --ink 字 + 图标转 --accent
激活（is-active）：--accent-soft 底 + --ink 字 + font-weight 550
拖放（is-drop）：--accent-soft 底 + inset 0 0 0 1.5px --accent-line
```

| 变体 | 类名 | 差异 |
| --- | --- | --- |
| 树行 | `.tree__row` | 左侧 `.tree__caret`（14px，`.is-open` 转 90°）+ `.tree__icon` + `.tree__label`（省略号）+ `.tree__meta`（`--fs-xs` + tabular-nums）+ `.tree__extra`（**默认 `opacity: 0`，hover / 激活时才显形**） |
| 折叠组头 | `.tree__group` | `--fs-xs` + `--tracking-wide` + uppercase + `--ink-3`，`::after` 一条 `flex: 1` 的 1px `--rule` 横线填满右侧 |
| 大纲行 | `.outline__item` | `--fs-sm`、`padding: 3px 8px`、左 2px 透明边；`.is-current` 时字 `--accent` + 左边 `--accent` + 底 `--accent-soft` |
| 历史条目 | `.history__item` | `--fs-sm`、`padding: 7px 9px`，内部 `<time>` 用 `--fs-xs` + `--ink-3` 单独一行 |
| 收件箱条目 | `.inbox__item` | `--fs-sm`、`padding: 7px 9px`、**左 2px 透明边**；`.is-error` 时左边转 `--accent` 且 `.inbox__sub` 也转 `--accent` |
| 最近打开 | `.empty__recent-item` | `padding: 5px 8px`，右侧 `<time>` 用 `margin-left: auto` |
| 面板条目 | `.palette__item` | `gap: 12px`（留给图标），双行：`.palette__item-title` + `.palette__item-sub`（`--fs-xs` + `--ink-3`），右侧 `.palette__kind` |
| 设置行 | `.setting` | **132px 标签列 + 1fr 控件列**，行间 1px `--rule`；长控件 / 窄屏时用 `.setting--stack` 改成上下堆叠 |

**共通的实现约定**：行元素一律是 `<button>`（或 `role="button"`）而不是 `<div onclick>`；文字列一律 `min-width: 0` + `overflow: hidden` + `text-overflow: ellipsis` + `white-space: nowrap` 三件套。

### 面板与浮层

| 组件 | 类名 | 关键值 |
| --- | --- | --- |
| 遮罩 | `.scrim` | `color-mix(paper-4 30%, rgb(20 16 12 / .32))` + `backdrop-filter: blur(3px) saturate(.9)` + `fade 120ms` |
| 菜单遮罩 | `.scrim--menu` | 更轻：`rgb(20 16 12 / .28)` + `blur(2px)`，`z-index: 55`，`display: none`，靠 `.app.is-sidebar-open` 打开 |
| 移动端抽屉遮罩 | `.scrim--menu.scrim--drawer` | 同一条遮罩，但 `top: var(--tabbar-h)`：让开顶行，头部与它的按钮保持可用（点它就能把抽屉收回去） |
| 对话框 | `.dialog` | `--paper-2` 底 + `--rule-strong` 边 + `--radius` + `--shadow-3`；宽 `min(560px, 100vw - 32px)`、高 `min(82vh, 760px)`；`pop 220ms` |
| 宽对话框 | `.dialog--wide` | 760px（收件箱、历史） |
| 设置对话框 | `.dialog--settings` | 900px |
| 定高对话框 | `.dialog--tall` | `height: min(600px, calc(100vh - 96px))`，**设置与收件箱共用**，只写在这一处 |
| 命令面板 | `.palette` | `min(620px, 100vw - 32px)`、高 `min(66vh, 640px)`、`--radius`；输入框 h56 / 15px 且 **`flex: none`**（见下）；脚注一行 `kbd` + `--fs-xs` |
| 右键菜单 | `.menu` | `min-width: 190px`、`padding: 5px`、`--radius`、`--shadow-2`、`pop 120ms`，`z-index: 80` |
| 工作区下拉 | `.workspace__menu` | 贴 `.sidebar__workspace` 绝对定位，`top: 36px`，左右各留 `--s3`，`max-height: 62vh`，`--shadow-3` |

**对话框内部结构固定**：`.dialog__head`（标题 `--font-display` 17px/600 + 右侧 `.icon-btn` 关闭按钮）→ `.dialog__body`（`--s4` 内边距，**自己滚动**）→ `.dialog__foot`（`color-mix(paper-3 40%, paper-2)` 底、上方 1px `--rule`、`.spacer` 把主按钮推到右边）。

**滚动归谁**（这是本项目踩过坑的地方）：
- **不要让 `.dialog__body` 整块滚**：定高面板里，左侧分类栏 / 条目列表会跟着滚上去。做法是让内层容器撑满定高、**各自滚动**（`.settings__pane`、`.inbox__list`、`.inbox__detail`）。
- 两栏面板的 grid 行高必须是 `grid-template-rows: minmax(0, 1fr)`，否则行高由最长的那一栏决定，切筛选 / 切条目时面板尺寸会跳（表现为「闪」）。
- **列向 flex 里，有固定高度的子项必须写 `flex: none`**。`.palette` 是 `flex-direction: column` + `max-height`，`.palette__list` 是 `flex: 1`；结果一多（60 项）容器顶到 `max-height` 时，**唯一还有基础高度的输入框**会被压到自己的自动最小高度（实测 48px → 20px，文字贴着上下边框）。这条不只影响命令面板：任何「定高容器 + 一个 `flex: 1` 的滚动区 + 一个定高头部」的组合都要显式 `flex: none`。

### 反馈

| 组件 | 类名 | 关键值 |
| --- | --- | --- |
| 提示 | `.toast`（容器 `.toast-root`） | `--ink` 底 + `--paper` 字 + **`--radius: 99px` 药丸** + `--shadow-2`；`max-width: min(420px, 100vw - 32px)`；`padding: 8px 14px`；`--fs-md`；`rise 220ms` |
| 危险提示 | `.toast--danger` | `--accent` 底 + `--accent-ink` 字 |
| 提示消息 | `.toast__msg` | `min-width: 0` + 溢出三件套，**恒单行省略**——长标题截断尾部，药丸不许换行长成两行板砖（行模板三件套，见 §列表与行） |
| 提示次级说明 | `.toast__body` + `.toast__sub` | 仅有降级说明时出现：列向两段，`--fs-xs` + `opacity .78` + 同样单行省略；主文案保持完整，标题不因降级消失 |
| 提示动作 | `.toast__action` | 下划线文字按钮，`text-underline-offset: 2px`，**必须自己 `pointer-events: auto`**；**`flex: none` + `white-space: nowrap` 恒宽**——没有这两条，长 CJK 标题会把「撤销」挤成竖排两个字 |
| 进行中 | `.busy` + `.busy__spinner` | `--ink` 药丸 + 12px 旋转环（`2px currentColor` 边 + 透明顶边，`spin .8s linear infinite`） |
| 空态（整屏） | `.empty` | `grid; place-items: center` + `--s6` 内边距；内部 `.empty__inner`（`max-width: 420px` 居中，`rise 460ms`） |
| 空态（面板内） | `.tree__empty` / `.inbox__empty` | `--ink-3` + `--fs-sm` + `line-height: 1.7`，居中（定高面板里用 `flex: 1` + `justify-content: center`，不要贴顶） |
| 存储提示 | `.storage-notice` | 吸顶的 `--ink` 药丸，`z-index: 95`，`--fs-sm` |
| 投递中淡化 | `[data-busy="true"]` 容器 | 子区域 `opacity: .6` + `pointer-events: none`（**只淡化被操作的区域，不遮整屏**） |

### 状态语义的写法（重要）

```
成功 / 中性结果   →  .toast（墨色药丸）+ 一句能读懂的中文
失败 / 需要处理   →  .toast--danger（强调色药丸）+ 一句能读懂的中文
行级状态         →  6px 圆点的填充方式 + 文字（.statusbar__dot / .status-chip）
```

`.toast` 的实现在 `src/lib/toast.ts`：`notify(message, { kind: "info" | "danger", action, duration })`。**同时最多堆 4 条**（`.slice(-4)`）；**默认停留时长**：带 `action` 6000ms，不带 2600ms。需要更长的撤销窗口时**显式传 `duration`**（导入的「撤销」按需求传 10 秒）。

### 正文与编辑区

正文排版在 `prose.css`，**被三个地方共用**：编辑区的渲染层、剪藏页预览、导出 HTML 与打印样式表。因此**改一处等于改三处** —— 这正是它必须走令牌、不能用上下文相关写法的原因。

| 元素 | 手感 |
| --- | --- |
| 段落 | `margin: 0.85em 0`（用 `em`，跟 `--doc-fs` 缩放） |
| h1 / h2 | `1.85em`（下边框 **2px**）/ `1.45em`（**1px**），都 `font-weight: 600` |
| 强调 | `strong` = 650；`em` = italic；`del` = `--ink-3` + 1.5px 删除线；`mark` = `--mark` 底 + 3px 圆角 |
| 链接 | `--accent` 字 + `1px --accent-line` **下边框**（不是 `text-decoration`），hover 时边框转 `--accent` |
| 行内码 | `--font-mono` + `0.875em` + `--code-bg` 底 + 1px `--rule` 边 + 4px 圆角 |
| 代码块 | `--code-bg` 底 + **左侧 2px `--accent-line`** + 1px `--rule` 其余三边 + `--radius` + `tab-size: 2`；首行可选语言徽标（uppercase + `--tracking-wide` + 10.5px + 混色底）。**编辑区里的底色画在 `::after`（`z-index: -1`）上**，不是行本身 —— 否则会盖住选区高亮，见下方约束 3 |
| 引用 | 左侧 **2px `--rule-strong`** + `--ink-2` 字 + `padding-left: 1.1em` |
| 表格 | `0.94em`、单元格 `1px --rule` + `0.42em 0.7em`、表头 `--paper-3` 底 + 600、行 hover 混色底 |
| 图片 | `--radius` + `--shadow-1` + `--paper-2` 底（图片没加载也不显突兀） |
| 分隔线 | **不用 `<hr>` 的默认样式**：渲染成 `.dinkus` —— 三个 3px 圆点，gap `0.55em`，`--ink-3` |
| 任务列表 | 自定义 checkbox `1.02em` + `1.5px --rule-strong` 边 + 4px 圆角；勾选后底/边转 `--accent`，勾是 `2px --accent-ink` 的折角 `rotate(42deg)` |
| 公式 / 图表 | KaTeX 缩放 `1.06em`；Mermaid 块 `1px --rule` 边 + `--radius` + `--paper-2` 底 + `padding: 0.8em` |
| 脚注 | 上方 1px `--rule` + `0.88em` + `--ink-2` |

**编辑区专属**（`editor.css`）：
- 选择器是**两到三层深**（`.cm-editor .cm-content .cm-line.md-h1`），因为 CodeMirror 在运行时注入自己的基础主题，层级不够会输掉层叠。**这是刻意的，不要为了「简洁」把选择器缩短。**
- **语法标记只在光标所在行露出**：`.md-src` / `.md-num` / `.md-table-delim` / 代码围栏 / `$$` 都是 `--ink-3`。非当前行的标记由 JS 加上隐藏类（`.md-hide-line`）。
- **专注模式**：非当前块的行 `color: color-mix(in srgb, var(--ink) 26%, transparent)`，其内部元素强制 `background-color: transparent` / `box-shadow: none`，图片与图表降到 `opacity: .35` + `saturate(.4)`。**不要**改成 `display: none`（那会让文档跳动）。
- **打字机模式**：只在 `.cm-content` 上加 `padding-top: 28vh` / `padding-bottom: 62vh`，让光标能停在屏幕中间。空文档提示的 `top` 也跟着从 `56px` 改为 `28vh`。

**CodeMirror 的结构层主题在这个文件里**（`src/editor/theme.ts`，用 `EditorView.theme()` / `HighlightStyle` 写在 JS 里）——它是**第 6 个样式面**，很容易被漏掉：

| 归属 | 规则 | 说明 |
| --- | --- | --- |
| 文档面 | `&` → `color: var(--ink)` / `fontSize: var(--doc-fs)` / 背景透明 | 编辑器不自己上底色，露给 `.editor-host` 的 `--paper` |
| 滚动与排版 | `.cm-scroller` → `fontFamily: var(--font-doc)` / `lineHeight: var(--doc-lh)` | 正文的字体与行高从这里进编辑器 |
| 正文栏 | `.cm-content` → `maxWidth: var(--measure)` / `margin: 0 auto` | 栏宽 = 用户设置 |
| 光标 | `.cm-cursor` → `borderLeft: 2px solid var(--accent)` / `borderRadius: 1px` / `transform: translateY(-15%)` | 光标是强调色，2px。**那个 15% 不是随手写的**：CodeMirror 给的高度是这一行的**字体盒**，而汉字墨迹比字体盒**高 0.12em、下沿又短 0.12em**（同 `.cm-selectionBackground` 撑开 padding 的成因），不补就「比字低一截」——用户 0.5.0 报的「光标偏移? 偏下」。用百分比是因为 **`translateY` 的百分比按元素自身高度算**，而那个高度正是这一行的字体盒 ⇒ 任意字号、任意标题级别、任意字体预设下都等于要补的那 0.12em；写死 `-2px` 在 H1（30px 光标）上补不够、在小字号上又补过头。实测：正文行光标 101–117 → 100–114（汉字墨迹 100–115），H1 行 185–214 → 181–209（墨迹 181–209，上下各 0px）。**几何只能在真实浏览器里量**（`pnpm dev` → 取 `.cm-cursor` 的 `getBoundingClientRect()` 与同一行墨迹的像素范围对比），所以 `src/editor/theme.test.ts` 只守「必须是百分比、不许写死像素」这条性质 |
| 选区（失焦 / 原生） | `.cm-selectionBackground, .cm-content ::selection` → `var(--sel)` | 只管编辑器**没有焦点**时的选区（含浏览器原生 `::selection`）；聚焦态那条故意不在这里，见下 |
| 选区（聚焦） | **不在这个文件里**，落在 `editor.css` 的 `.cm-selectionLayer .cm-selectionBackground` | 见下「聚焦选区的两条硬约束」 |
| 行号槽 | `.cm-gutters` → `color: var(--ink-3)` / `fontFamily: var(--font-mono)` / `fontSize: 11px`、无边框、透明底 | |
| 查找面板 | `.cm-panels` → `var(--paper-2)` / `var(--ink)` / `borderColor: var(--rule)` / `fontSize: 13px` / `zIndex: 30`；输入与按钮 → `--paper-2` 底 + `--rule-strong` 边 + `4px` 圆角 | 顶部面板 `border-bottom: 1px solid var(--rule)` |
| 补全 / 提示 | `.cm-tooltip` → `--paper-2` 底 + `--rule-strong` 边 + `var(--radius)` + `var(--shadow-2)`；选中项 → `--accent-soft` 底；匹配文字 → `--accent` + 600 | |
| 搜索命中 | `.cm-searchMatch` → `background: var(--mark)` + `outline: 1px solid var(--accent-line)` + `2px` 圆角；当前命中 → `--accent-soft` | 与 `mark.hit` 不同：这里是方块底 + 描边 |
| 语法高亮 | 全部走 `HighlightStyle` 的 **class 名**（`tok-keyword` 等），颜色定义在 `prose.css` | **不要在 `theme.ts` 里写颜色** —— 高亮颜色只有 `prose.css` 一处产地，编辑器与导出 HTML 因此永远一致 |
| 空文档提示 | `contentAttributes: { "data-placeholder": "开始写下这一刻…" }`，由 `editor.css` 的 `::before` 绘制 | |

**这个文件里仅有的非令牌值**：`.cm-content { padding: "56px 10px 45vh" }`、`.cm-gutters { fontSize: "11px" }`、`.cm-panels` / `.cm-tooltip` 的 `fontSize: "13px"`、`.cm-searchMatch { borderRadius: "2px" }`、面板输入框的 `borderRadius: "4px"`、`zIndex: "30"`、**`.cm-cursor { transform: "translateY(-15%)" }`**（补汉字墨迹与字体盒之间的 0.12em，见上表「光标」那一行 —— 这一条**必须**写成自身高度的百分比，换成像素值就会在标题级别上失准）。改这些之前先确认没有对应令牌。

**选区与行底色的三条硬约束**（踩过坑的，改 CodeMirror 样式前必读）：

1. **聚焦态的选区规则不能写在 `theme.ts` 里，要在 `editor.css` 用 6 个类压过 CodeMirror 自己的 baseTheme。** CM 用 5 个类（`.ͼ2.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`）画它自己的固定色（浅色 `#d7d4f0` / 深色 `#233`），而本应用的主题是 CSS 变量驱动、CM 这边**永远被当成 light** —— 于是夜读主题里也会出现那块淡紫，浅色字压在上面几乎看不清。`EditorView.theme()` 里既写不出 `&light` / `&dark`（会抛 `RangeError: Unsupported selector`），特异度也压不过它。现在这条落在 `editor.css`：`.editor-host .cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`，颜色交回 `--sel`（跟着主题与强调色走）。
2. **那条规则的颜色必须落成不透明的**：先 `background-color: var(--paper)`，再用 `linear-gradient(var(--sel), var(--sel))` 把半透明的 `--sel` 叠上去。原因有两个：`--sel` 是 rgba，而选区矩形**彼此紧挨**；同时每个矩形还要用 `padding-block: 4px 2px`（配 `margin-block: -4px -2px` 抵消占位）上下撑开 6px，好覆盖从字体盒上沿冒出去的汉字墨迹 —— 矩形一重叠，半透明色就会叠出 6px 的深色接缝。撑开量 6px 仍小于最小行间空隙（行高下限 1.4 ⇒ 空 6.8px），不会吃掉下一行。
3. **给 CM 的行加不透明底色时，必须画在负 `z-index` 的伪元素上。** `.cm-selectionLayer` 在 `.cm-content` **下面**，行自己带不透明底就会把选区高亮整块盖住（选中代码块里的字会**看不见**；失焦时反而看得见，因为那是浏览器原生 `::selection`，画在底色之上）。所以 `.md-code-line` 的 `--code-bg` 落在 `::after { position: absolute; inset: 0; z-index: -1; border-radius: inherit }` 上 —— 用 `::after` 是因为 `::before` 被 `.md-code-first[data-lang]` 的语言标签占用了，`border-radius: inherit` 让首/末行的 8px 圆角照旧。

---

## Control States · 控件状态

**所有控件的状态写法统一为 `S-C1…S-C8`。** 这是一套跨界面、跨组件的**通例**，任何新控件都必须能逐条对上；对不上就是走偏了。（编号沿用 `docs/import/03-UI设计规范-剪藏与导入.md` §4.0，全项目一致。）

| 编号 | 状态 | 规定 |
| --- | --- | --- |
| `S-C1` | **默认** | 描边 `--rule-strong`；底 `--paper-2`（按钮 / 输入框）或透明（行 / 图标钮）；字 `--ink` 或 `--ink-2` |
| `S-C2` | **hover** | 底 `--paper-3`；行与图标钮同时把字提到 `--ink`、图标提到 `--accent`；过渡 `--dur-fast` |
| `S-C3` | **聚焦** | 沿用 `base.css` 的 `:focus-visible`：`2px solid var(--accent-line)`、`outline-offset: 2px`、`border-radius: 3px`。**输入类控件额外**加 `box-shadow: 0 0 0 3px var(--accent-soft)`。**不允许移除轮廓、不允许改成只用颜色变化** |
| `S-C4` | **禁用** | `opacity: .45` + `cursor: not-allowed`。**禁用原因必须写成旁边的可见文字或 `title`** —— 不允许出现「不知道为什么点不了」的按钮 |
| `S-C5` | **加载** | 文案改进行时；主按钮内左侧放 12px `.busy__spinner`；**按钮宽度不跳变**（加载态与默认态同 padding，文字长度差用 `min-width` 吸收） |
| `S-C6` | **错误** | 控件边框 `--accent-line`；错误句放在控件下方、用 `--fs-sm` 的 **`--ink`**（**不是 `--ink-3`**，对比度不够）；必要时句首加一个 12px 的 `--accent` 描边圆点，而不是图标字体 |
| `S-C7` | **空** | 沿用 `.tree__empty`（居中、`--ink-3`、`--fs-sm`、行高 1.7）或 `.empty`（整屏居中 + 印章）。文案口吻：**陈述事实 + 一句「怎么办」**，例如「回收站是空的。」——**不写「暂无数据」** |
| `S-C8` | **选中** | 底 `--accent-soft`；字 `--ink`（列表行）或 `--accent`（分段控件 / 标签页），粗体 550–600。**不新增勾选图标以外的装饰** |

**四条容易写错的补充**：
1. **不写 hover 文档**。写规范时只记 `S-C1` 与选中 / 激活态，hover 是实现细节，全项目只有 `S-C2` 一种写法。
2. **视觉与读屏用同一个状态**。选中 / 按下类控件一律用 `aria-pressed` / `aria-checked` / `aria-current` 驱动样式（例：`.clip__pick .btn[aria-pressed="true"]`），不要另加一个 `.is-selected` 类再让它们各写一套。
3. **两个反例**：`.is-active`（视觉选中）与 `:active`（鼠标按下）是两件事，**不要混用**；`.tab.is-active` 用的是前者。
4. **`is-*` 是状态类的唯一前缀**。现有状态类：`is-active`、`is-open`、`is-collapsed`、`is-current`、`is-on`、`is-dirty`、`is-error`、`is-drop`、`is-dim`、`is-missing`、`is-loading`、`is-dropping`、`is-gone`、`is-danger`、`is-quiet`、`is-busy`、`is-sidebar-open`。**不要新增 `active` / `selected` / `opened` 这类不带前缀的写法。**

---

## Accessibility · 无障碍

### 对比度（实测值，可复算）

| 主题 | 前景 / 背景 | 对比度 | 结论 |
| --- | --- | --- | --- |
| 素笺 | `--ink` / `--paper` | ≈ 14.5:1 | AAA，无限制 |
| 素笺 | `--ink-2` / `--paper` | ≈ 7.1:1 | AAA，无限制 |
| 素笺 | `--ink-3` / `--paper` | ≈ 3.2:1 | **低于 AA 4.5:1** |
| 素笺 | `--accent` / `--paper` | ≈ 5.6:1 | AA，可用于错误文字与危险操作 |
| 素笺 | `--accent-ink` / `--accent` | ≈ 5.9:1 | AA，主按钮文字达标 |
| 夜读 | `--ink` / `--paper` | ≈ 14.8:1 | AAA |
| 夜读 | `--ink-2` / `--paper` | ≈ 7.9:1 | AAA |
| 夜读 | `--ink-3` / `--paper` | ≈ 4.1:1 | **略低于 AA** |
| 夜读 | `--accent` / `--paper` | ≈ 5.6:1 | AA |
| 夜读 | `--accent-ink` / `--accent` | ≈ 5.5:1 | AA |

**硬规则（`--ink-3` 是这个系统唯一的对比度缺口）**：

> `--ink-3` **禁止**承载：按钮文字、错误句、状态句、任何「不看会漏掉操作」的信息。
> 它**只能**用于：时间戳、计数、分组小标题、补充说明、语法标记这类「不看也不影响操作」的信息。

这是**现有系统的既有限制**，不是某次改动引入的。修它需要改整套令牌（并波及所有既有界面），因此当前策略是**限制用途**，而不是新增一个更深的提示色令牌。

### 焦点

- 全部可聚焦元素沿用 `base.css` 的全局 `:focus-visible`，**一致、不自定义、没有任何例外**。`:focus { outline: none }` 只是消掉鼠标点击时的环，`focus-visible` 仍然成立。
- 模态层（对话框、命令面板）必须「焦点进入 → 困住 → 关闭后归还」。
- 焦点顺序必须与视觉顺序一致（例：收件箱两栏在 DOM 里是「列表在前、详情在后」，与视觉一致）。
- 覆盖在宿主页面上的 Shadow DOM 覆盖层（元素选择）**不进焦点顺序**：宿主 `pointer-events: none` + `aria-hidden="true"`。

### 屏幕阅读器

| 对象 | 要求 |
| --- | --- |
| 全部 toast | `role="status"` + `aria-live="polite"`。危险 toast 也用 `status`**而不是** `alert`，避免打断正在朗读的内容 |
| 全部对话框 | `role="dialog"` + `aria-modal="true"` + `aria-label` |
| 状态类文字 | `role="status"`，状态变化朗读一次（连接芯片、交付说明行） |
| 列表 | 容器 `aria-label="…，共 {n} 条"`；当前条目 `aria-current="true"` |
| 分段控件 | `role="radiogroup"` + 子项 `role="radio"` + `aria-checked`，`←/→` 切换 |
| 纯图标按钮 | 图标本身 `aria-hidden="true"`，按钮用 `aria-label` 或 `title` 提供名称 |
| 装饰性元素 | `aria-hidden="true"` |
| 仅读屏可见的文字 | `.sr-only`（`clip-path: inset(50%)`，不是 `display: none`） |
| 加载中的按钮 | `aria-busy="true"` |

### 命中区域与其它

- **最小可点区域 24×24px**。现有实现的下限是状态栏按钮（h20）与大纲行（h 约 24），**新界面不出现更小的目标**。
- **不依赖颜色**：所有状态都有文字（见 §Colors · 语义状态）。
- **浏览器缩放 200%** 时不得出现横向滚动：对话框 ≤720px 走单栏规则，表单行改上下堆叠。
- **语言**：所有文档 `lang="zh-CN"`。
- **打印**：`prose.css` 末尾的 `@media print` 会隐藏 `.sidebar / .sidebar__head / .sidebar__resizer / .outline / .tabbar / .statusbar / .overlay-root / .toast-root / .storage-notice` 与纸张颗粒，把外壳解开成单列，正文字号转 `11.5pt`，并把 `pre` / `table` 设为 `break-inside: avoid`。**新增的任何外壳级容器都要加进这份隐藏清单**，否则会印到 PDF 上。

---

## Theming Contract · 主题契约

主题是这套系统最容易出错的地方，因为它跨 4 个文件。

### 数据流

```
用户改设置
  └─ src/data/ui.ts  patchUi()
       ├─ persist()   → localStorage["opennote.ui.v1"]（整个 UiSettings 序列化）
       └─ applyUi()   → <html> 上的 5 个 data-* 属性 + 2 个行内 CSS 变量
                          data-theme       素笺 paper | 青瓷 celadon | 琥珀 sepia | 夜读 night | 砚池 ink
                          data-accent      朱砂 seal | 靛青 indigo | 松绿 pine | 藤黄 gamboge
                          data-font        serif | sans | wenkai | mono      → 覆盖 --font-doc
                          data-width       narrow | normal | wide | full     → 覆盖 --measure
                          data-appearance  light | dark                      → 供非颜色分支使用
                          --doc-fs   = ui.fontSize + "px"
                          --doc-lh   = ui.lineHeight
```

- **首屏防闪**：`index.html` 里有一段内联脚本，在应用模块加载**之前**从 `localStorage` 读出主题并写到 `<html>`，避免先渲染错主题再跳色。它**同时**设置了 `data-appearance`，并在「用户从未存过任何东西」时跟随系统 `prefers-color-scheme`。**改动主题持久化的键名或字段名时，必须同步改 `index.html` 里那段脚本**（它没法 import TS）。
- `meta[name="theme-color"]` 也跟着切：亮色 `#fbf8f3` / 暗色 `#14120f`。
- **两个已知的不一致（见 §Known Gaps）**：首屏脚本只写 `theme` / `accent` / `appearance`，**不写 `font` 与 `width`** —— 所以选了「文楷」或「窄栏」的用户，首帧会先按默认字体 / 栏宽渲染一次；而 `data-appearance` 目前**没有任何 CSS 选择器消费它**（只有那段脚本与 `applyUi()` 在写它）。
- **数值范围**（设置面板的滑块）：正文字号 `13–22px`、步长 `0.5`；正文行高 `1.4–2.2`、步长 `0.02`。改范围要同时确认正文排版在两端都不会坏（`--doc-fs` 是正文里所有 `em` 的基）。

### 六条硬规则

1. **令牌只有一个产地**：`src/styles/tokens.css`。调色板写在 `[data-theme="…"]` 区块里，强调色写在 `[data-accent="…"]` 区块里，暗色档用 `[data-theme="night"][data-accent="…"]` 组合选择器覆盖。
2. **CSS 里不判断「现在是哪个主题」**。除了 `tokens.css` 的调色板定义区与 `base.css` 里两处 `[data-theme="night"], [data-theme="ink"] body::before { mix-blend-mode: overlay }`，**任何地方都不许**出现 `[data-theme=…]` 选择器来改变某个组件的样式。要「在暗色下不一样」，唯一的办法是**加一个令牌**，让它在两套调色板里有不同取值。
3. **新增令牌的默认答案是「0 个」**。想加一个颜色 / 间距 / 字号令牌时，先证明现有的 55 个表达不了它。现有系统的做法是 `color-mix()` 混色，而不是加第 56 个令牌。
4. **主题只换值，不换结构**：任何组件在两套主题下的盒子模型、圆角、间距、字号必须完全一致。
5. **强调色是独立维度**：不要写「主按钮是朱砂色的」，要写「主按钮底是 `--accent`」。也不要在 JS 里判断 `accent === "seal"` 来改样式。
6. **`tokens.css` 有一份跨端拷贝，构建期整份复制 + sha256 门禁**：`extension/build.mjs` 把 `src/styles/tokens.css` **逐字节**复制到 `extension/src/styles/tokens.css` 与 `extension/dist/styles/tokens.css`，并比对哈希；不一致就报错。内容脚本的 Shadow DOM 也由构建期注入同一份内容（只把 `:root` 机械改写成 `:host`）。
   - **因此：永远不要手改 `extension/src/styles/tokens.css` 或 `extension/dist/**/tokens.css`**，改 `src/styles/tokens.css` 然后跑扩展的构建。

### 加一个新设置的路径

1. `src/data/types.ts`：加进 `UiSettings`，并把默认值加进 `DEFAULT_UI`（两者必须同时改，且旧存档要能靠 `{ ...DEFAULT_UI, ...parsed }` 自动补齐）。
2. 如果它影响外观：在 `src/data/ui.ts` 的 `applyUi()` 里写进 `data-*` 或 `root.style.setProperty`。
3. 在 `src/styles/tokens.css` 的对应 `[data-*]` 区块里加选择器（**不要**在组件样式里判断）。
4. 在设置面板（`src/components/AppDialogs.tsx`）里用 `SettingRow` 加一行；需要新控件时优先复用 `.segmented` / `.switch` / `.swatch` / `.range`。

---

## Do's and Don'ts · 该做与不该做

### Do · 该做

- **所有颜色、间距、圆角、字号、时长都写 `var(--token)`**。写样式时先把 `tokens.css` 的 55 个名字过一遍，几乎总能找到对应的。
- **新界面先用既有类名拼**：`.dialog` / `.setting` / `.segmented` / `.switch` / `.swatch` / `.cmd` / `.tree__row` / `.choice` / `.toast` / `.statusbar__item` / `.empty` / `.menu` / `.field` / `.btn` / `.icon-btn` / `kbd`。拼不出来再谈新类名，且新类名必须**只由既有令牌**构成。
- **需要「淡一点 / 深一点」时用 `color-mix()`** 混两个既有令牌，不要写 rgba、不要加令牌。
- **列表行统一走 `.tree__row` 的手感**（高度 / 内边距 / hover / `is-active` / 省略号三件套）。
- **状态一律给文字**。颜色只是辅助；`--ink-3` 之外的任何颜色都不该是唯一的信息通道。
- **给所有变化中的数字加 `font-variant-numeric: tabular-nums`**。
- **给所有会溢出的文字列加 `min-width: 0` + 省略号三件套**。
- **进场动画只用 `rise` / `fade` / `pop`**，时长只用 `--dur-fast` / `--dur` / `--dur-slow`。
- **圆角按层级给**：控件 5px → 卡片 8px → 浮层 14px → 药丸 99px。
- **改动画 / 令牌 / 主题时，同时检查全部消费方**：`src/styles/*`（5 个 CSS）、`src/editor/theme.ts`、`src/clip-web/clip.css`、`extension/src/popup/popup.css`、`extension/src/content/picker.js` —— 一共 **9 处**，见 §Iteration Guide 的样式面清单。
- **代码里出现「危险 + 主按钮」时，记得 `.btn--primary.btn--danger` 那条双类规则**：它保住的是按钮上的字。

### Don't · 不该做

- **不要在 CSS 里写死颜色**。任何一个 `#rrggbb` / `rgb()` / `rgba()` 都应当是可疑的 —— 现有例外全部列在 §Known Gaps 第 1 节（印章内高光、遮罩底、搜索框放大镜的 data URI、主题预览色块、扩展徽标色、`make_icons.py`），**新代码一个都不许再添**。
- **不要引入成功绿 / 警告黄 / 失败红**。用 `--accent` 表达「需要处理」，用 `--ink` 反色表达「中性结果」。
- **不要把强调色铺满**。强调色是稀缺资源：当前项、主按钮、危险动作、焦点环。整块铺强调色只有 `.toast--danger` 与印章。
- **不要写 `[data-theme="…"] .my-component`** 来让某个组件在暗色下变样。加令牌。
- **不要加第 5 档界面字号、第 8 档间距、第 4 种圆角**。4 档字号 / 7 档间距 / 3 档主要圆角是刻意的约束。
- **不要用 `transform` 写 `pop` 动画**（会覆盖对话框的居中 `transform`），用独立的 `translate` / `scale`。
- **不要用 `sheen` 扫光**，不要 stagger 列表入场，不要数字弹跳，不要错误抖动。
- **不要移除 `:focus-visible` 轮廓**。无障碍红线。
- **不要把 `.dialog__body` 当滚动容器**（定高面板里会让左栏一起滚）。
- **不要图省事把 `.cm-editor .cm-content .cm-line.md-h1` 缩写成一层选择器** —— CodeMirror 运行时注入的基础主题会赢。
- **不要把聚焦态的选区样式写进 `src/editor/theme.ts`**：CM 的 baseTheme 权重更高、且 `&light` / `&dark` 会抛 `RangeError`。它属于 `editor.css`（见 §Components 的三条硬约束）。
- **不要给 CodeMirror 的行（或任何在 `.cm-selectionLayer` 之上的元素）直接加不透明底色**：会把选区高亮整块盖住。画在负 `z-index` 的伪元素上。
- **不要手改 `extension/**/tokens.css`**（构建期整份复制 + sha256 门禁）。
- **不要把 `--doc-fs` / `--doc-lh` 的值抄进组件样式**。它们是用户设置，永远走变量。
- **不要在 `.prose` 之外的容器上重写正文样式**（.prose 被编辑器 / 剪藏预览 / 导出 HTML / 打印共用）。
- **不要新增图标集或图标字体**。用 `Icon` 的 39 个名字，缺图标先讨论。
- **不要写 `active` / `selected` / `opened` 这类状态类**，统一用 `is-*`。

---

## Responsive Behavior · 响应式

### 断点（全项目只有 5 个，不要新增）

| 断点 | 出处 | 变化 |
| --- | --- | --- |
| `≤1180px` | `app.css` | `.statusbar__item--compact` 隐藏（状态栏减少次要项，避免挤成两行） |
| `≤1080px` | `app.css` | `.outline` 整个隐藏（`display: none`） |
| `≤900px` | `clip.css` | 剪藏页两栏改上下堆叠，分隔线从「预览栏的右边」挪成「它的下边」 |
| `≤820px` | `app.css` | `.app` 变两列（`[头部][标签栏]` / `[编辑器+状态栏]` 两行）；`.sidebar` 变 `position: fixed` 抽屉，从**顶行下面**（`top: var(--tabbar-h)`）滑出（`min(84vw, 320px)` + `--shadow-3` + `translateX`，`z-index: 58`，`display: flex` 保留动画）；`.sidebar__head` 宽 `auto` 且 `max-width: 46vw`（窄屏不挤掉标签栏）；`.sidebar__resizer` `display: none`；`.scrim--drawer` 让开顶行；`.app.is-sidebar-open` 显示 `.scrim--menu` |
| `≤720px` | `app.css` | `.settings` 变单列（左导轨转横向换行、`small` 说明隐藏）；`.setting` 长控件改上下堆叠 |
| `>720px` | `app.css` | `.dialog--tall` 内的 `.settings` 变为撑满定高、只有 `.settings__pane` 滚动 |
| `print` | `prose.css` | 见 §Accessibility · 打印 |
| `prefers-reduced-motion: reduce` | `base.css` | 全局动效降到 0.01ms |

> 注意 `≤720px` 与 `>720px` 是**同一鉴权的两面**（设置面板的两栏 ↔ 单栏），改一侧必须改另一侧。

### 折叠策略

- **列数减，不是把卡片压小**：`.cmd-grid` 用 `repeat(auto-fill, minmax(196px, 1fr))` 自动降列；`.shortcuts` 用 `minmax(250px, 1fr)`。
- **侧栏**：`>820px` 是常驻列。**收起 = 只收起左栏本身**：顶行（头部 + 标签栏）完全不动，`.sidebar` 身体 `display: none`，编辑器与状态栏绕到头部下面占满整宽。头部宽度恒为 `var(--sidebar-w)`，所以标签栏不会跳。之所以不是整条滑出去：那样会把「把侧栏叫回来」的按钮一起带走（`Ctrl/⌘+\` 与命令面板是看不见的退路）。`≤820px` 是抽屉 + 遮罩：从顶行下面滑出，头部留在上面始终可用。
- **大纲**：`≤1080px` 直接隐藏（内容不重要到值得占掉正文宽度）。
- **对话框**：宽度一律 `min(Npx, calc(100vw - 32px))`，**永远不横向溢出**。
- **命令面板**：`min(620px, calc(100vw - 32px))`，高 `min(66vh, 640px)`。
- **正文**：`--measure` 由用户控制，窄屏时 `100%` 生效（`46rem` 在 360px 屏上是溢出宽度，但正文容器不会被撑破，因为 `.prose` 有 `overflow-wrap: break-word`）。
- **状态栏**：不换行（`flex-wrap: nowrap` + `overflow: hidden`），靠逐个 `display: none` 降级。

### 触摸与命中

- 最小可点 24×24px；`.icon-btn` 是 26×26，`.btn` 高 28，`.field` 高 30。
- 367px 宽的扩展 popup 固定 `width: 360px; height: 600px`（Chrome popup 上限），内部**只有一个滚动容器**（`.clip__body`），避免嵌套滚动条。

---

## Iteration Guide · 改这个项目时的操作手册

### 事实来源（按可信度排序）

| 顺序 | 位置 | 是什么 |
| --- | --- | --- |
| 1 | `src/styles/tokens.css` | **令牌唯一产地**（55 个自定义属性）。有分歧时以它为准 |
| 2 | `src/styles/base.css` | 重置、公共 chrome（`.btn` / `.icon-btn` / `.field` / `kbd` / `.seal` / `.hairline` / `.muted` / `.truncate` / `.sr-only`）、4 个进场景动画、全局 `:focus-visible`、滚动条、启动页、存储提示 |
| 3 | `src/styles/app.css` | 应用外壳、侧栏、文件树、标签栏、状态栏、大纲、空态、浮层、对话框、命令面板、设置、菜单、toast、收件箱、拖放 |
| 4 | `src/styles/prose.css` | 正文排版（**被编辑器 / 剪藏预览 / 导出 HTML / 打印共用**）+ `@media print` |
| 5 | `src/styles/editor.css` | CodeMirror 内的文档表面：标题、行内标记、wiki 链接、代码块、专注 / 打字机模式 |
| 6 | `src/editor/theme.ts` | CodeMirror 的**结构层**（正文栏 / 光标 / 行号槽 / 查找面板 / 补全提示）+ 语法高亮的 class 映射。样式写在 TS 里的唯一一处 |
| 7 | `src/clip-web/clip.css` | 剪藏页自己的布局（**只用既有令牌，新增令牌 0**） |
| 8 | `extension/src/popup/popup.css` | 扩展 popup（**不定义任何令牌、不出现任何色值**，另有一条 base 层的逐字拷贝） |
| 9 | `extension/src/content/picker.js` | 注入宿主页面的覆盖层（Shadow DOM；令牌由构建期注入，`:root` → `:host`） |
| 10 | `docs/import/03-UI设计规范-剪藏与导入.md` | 剪藏 / 导入功能的逐界面规范与状态编号（`UI-xx` / `S-xx` / `C-xx`） |

**依赖方向**：`tokens.css` ← 其它所有。`prose.css` 的正文类名被 4 个消费方共用（编辑器 widget、剪藏预览、导出 HTML、打印）。`app.css` 里的 `.inbox__*` 已经开始承载「导入收件箱」这个具体界面 —— 新界面**不要**再往 `app.css` 里堆，优先考虑是否能用既有零件拼出来。

**一共 6 个样式面**（`src/styles/*` 5 个 CSS + `src/editor/theme.ts`）**加 3 个外围**（`clip.css`、扩展 `popup.css`、扩展 `picker.js`）。改任何全局令牌时，这 9 处都要过一遍。

### 一次改动的标准流程

1. **先定「这是哪一类改动」**：
   - 新界面 / 新面板 → §Do's 的零件清单里拼；确认零新增令牌。
   - 令牌取值调整（换色 / 换间距）→ 只改 `tokens.css`，然后**全仓跑一遍视觉核对**（5 主题 × 4 强调色的组合都要看）。
   - 主题机制变化 → 同时改 `src/data/types.ts` + `src/data/ui.ts` + `index.html` 的内联脚本 + `tokens.css` 的 `[data-*]` 区块。
   - 组件视觉修正 → 改对应 CSS 文件里那一条规则，并回看 `editor.css` / `editor/theme.ts` / `clip.css` / `popup.css` 有没有同一份拷贝（它们是平行的多份实现）。
2. **确认没有引入新令牌**。新增令牌必须在改动说明里写清理由；默认答案是 0。
3. **确认没有字面色值**。在编辑器里全局搜索正则 `#[0-9a-fA-F]{3,8}\b|rgba?\(`（或装了 ripgrep 时 `rg -n "…" src/styles src/editor extension/src`），检查范围至少覆盖 `src/styles/`、`src/editor/`、`extension/src/`。
   结果应当只剩 §Known Gaps 第 1 节列出的已知例外（印章内高光、遮罩底色、放大镜 data URI、`make_icons.py`）。
4. **在 5 套主题下各看一遍**（至少：素笺 + 夜读），因为亮暗两套的 `--shadow-c` / `--accent-*` 取值不同。
5. **在 4 套强调色下看一遍主按钮、选中态、焦点环、印章**（强调色是独立维度，最容易在某套色下糊掉）。
6. **验降级**：`prefers-reduced-motion` 打开后，靠动画表达的状态是否仍有静态表达。
7. **验键盘**：Tab 顺序与视觉顺序一致；对话框焦点进出正确；`:focus-visible` 未被移除。
8. **改到正文排版时，四处都要看**：编辑器、剪藏页预览、导出 HTML、打印预览。
9. **跑检查**：`pnpm typecheck && pnpm test`；扩展相关的改动另有 `extension/verify.mjs` 与 `pnpm --dir extension test`。
10. **提交信息**遵循 Conventional Commits（例：`feat(editor): …` / `fix(popup): …`）。

### 命名约定速查

| 对象 | 约定 | 例子 |
| --- | --- | --- |
| 组件类名 | `block__element`（BEM：块与元素两段） | `.tree__row`、`.dialog__body`、`.settings__tab` |
| 结构性变体 | 独立类 `block--modifier`：**只用于结构 / 尺寸变体，不用于状态** | `.dialog--wide`、`.btn--primary`、`.tree__row--stacked`、`.statusbar__item--compact` |
| 状态 | 另一套独立类，前缀一律 `is-` | `.tree__row.is-active`、`.sidebar.is-collapsed`、`.inbox__item.is-error` |
| 组合类名 | 用 `cn()`，不要字符串拼接 | `cn("tab", active && "is-active")` |
| 私有类（不参与主题） | 只用一次的类可以只由既有令牌拼，不必进 §Components | `.dinkus`、`.swatch__dot` |
| 局部 CSS 变量 | `--block-xxx`，定义在使用它的块上 | `--titlebar-inset` 定义在 `.app--desktop` 上 |
| 全局令牌 | 在 `tokens.css` 里、不带块前缀 | `--paper-2`、`--radius-sm`、`--dur-fast` |
| React 组件 | 具名导出函数组件，返回类型写 `ReactNode`，props 内联类型标注 | `export function Modal({...}: {...}): ReactNode` |
| 组件文件组织 | 一个文件一个主组件；子组件放同文件下方，用注释横幅分隔 | `/* ------------ sub-screens */` |
| 图标 | `<Icon name="…" size={15} />`，颜色靠 `currentColor` | 缺图标先讨论，别引新图标集。**右键菜单项（`MenuItem`）的 `icon` 是必填字段**：漏写会在 `pnpm typecheck` 就红（0.5.0 用户实测过「关闭其他标签」那一行图标列是空的，而上下每项都有） |
| 状态管理 | `src/lib/store.ts` 的 `createStore` + `useStore` / `useStoreSelector` | `toastStore`、`uiStore` |
| 交互态 | 默认 `S-C1` → hover 底 `--paper-3` **并把字提到 `--ink`** → 选中 `--accent-soft`（`S-C8`） | 见 §Control States |
| 无障碍 | 纯图标按钮给 `aria-label` 或 `title`；装饰性元素 `aria-hidden="true"`；状态类文字 `role="status"` | 见 §Accessibility |
| 文案 | **界面文案一律中文全角、不使用 emoji**，硬编码在组件里，没有 i18n 层 | 「回收站是空的。」 |

### 常见错误对照

| 症状 | 正确做法 |
| --- | --- |
| 写了一个新颜色 | 先用 `color-mix()` 混既有令牌；确实不够再讨论加令牌 |
| 输入框聚焦时「没反应」 | 输入类控件要**去掉** outline 再补 `--accent-line` 边 + `3px --accent-soft` 外圈（`S-C3`） |
| 暗色主题下某个颜色糊了 | 检查是不是写了字面色值或 `rgba(0,0,0,…)`；阴影必须走 `--shadow-c` |
| 侧栏 / 大纲里滚动条不出现 | 给 grid/flex 子项补 `min-height: 0`，给容器补 `minmax(0, 1fr)` |
| 切筛选时面板「闪」 | 把行高钉死在定高容器上（`grid-template-rows: minmax(0, 1fr)`），让每栏各自滚动 |
| 对话框里的左栏跟着滚 | 滚动容器放错了，应当在 `.settings__pane` / `.inbox__list` 上，不是 `.dialog__body` |
| 按钮在加载态宽度跳变 | 用 `min-width` 吸收文案长度差（`S-C5`） |
| 字数从 99 变 100 时整行抖 | 加 `font-variant-numeric: tabular-nums` |
| 长标题把布局撑破 | 补 `min-width: 0` + 省略号三件套 |
| 全大写小标题看起来「挤」或「散」 | 同时用 `--tracking-wide`（0.08em）+ `text-transform: uppercase`；中文标题不要用 uppercase |
| 对话框进场动画把居中弄丢了 | `pop` 必须用独立的 `translate` / `scale`，不能用 `transform` |
| 扩展里的颜色跟应用对不上 | 跑扩展构建（它会重新整份复制 `tokens.css` 并比对哈希），不要手改拷贝 |

---

## Known Gaps · 已知缺口与历史偏差

这一节是**诚实清单**。下面这些是当前代码里**确实存在**的不一致；写新代码时**不要跟着学**，有机会修时按「正确做法」一列改。

### 1. 字面色值（应改用令牌或 `color-mix()`）

| 位置 | 现状 | 正确做法 |
| --- | --- | --- |
| `.scrim` / `.scrim--menu` | `rgb(20 16 12 / 0.32)` / `rgb(20 16 12 / 0.28)` | 遮罩底色是「墨的透明版」，应当有一个令牌或走 `color-mix(--ink …)`。当前写死导致它不随主题的墨色变化 |
| `.field--search` 的放大镜 | 内联 SVG 的 `stroke='%2397897a'` —— **写死了素笺的 `--ink-3`** | 这是**真实缺陷**：暗色主题下放大镜仍然是浅灰。data URI 里没法用 `var()`，修法是用 `mask-image` + `background-color: var(--ink-3)`，或维护两份 data URI |
| `.seal` / `.empty__seal` / `.boot__seal` 的内高光 | `rgb(255 255 255 / α)`，α 有 `0.32` 与 `0.35` 两个值 | 可接受（纸色高光），但应统一成一个值 |
| `src/components/AppDialogs.tsx` 的主题预览色块 | `style={{ background: "linear-gradient(135deg,#1c1915 50%,#eae3d7 50%)" }}` —— **写死了夜读主题的 `--paper-2` / `--ink`** | 主题预览要显示「这套主题长什么样」，所以它天然需要该主题的色值；正确做法是从 `THEMES` 元数据里带出两个代表色（像 `ACCENTS[].swatch` 那样），而不是在 JSX 里写 hex |
| `extension/src/background.js:613` 的徽标色 | `color: "#8c2f24"` | 见 §6 |
| `.swatch__dot` | `inset 0 0 0 1px rgb(0 0 0 / 0.12)` | 同上，可接受，但应走 `--shadow-c` |
| `scripts/make_icons.py` / `public/favicon.svg` | `#b23a2e` / `#fbf8f3` | **故意的例外**：构建期 PNG 生成器读不到 CSS 变量。改品牌色时两处一起改 |

### 2. 硬编码的字号与间距（应改用令牌）

| 位置 | 现状 | 应为 |
| --- | --- | --- |
| `.palette__input` | `font-size: 15px` | `var(--fs-lg)` |
| `.sidebar__name` | `font-size: 15.5px` | `var(--fs-lg)`（15px）或明确保留 15.5 并说明 |
| `.dialog__title` | `font-size: 17px` | 无对应令牌；`--fs-lg`（15px）偏小 —— 需要讨论是否给标题加一档，或接受现状 |
| `.empty__title` | `26px` | 同上 |
| `.setting__value` | `13px` | `var(--fs-md)`（13.5px） |
| `.setting__path` / `.setting__meta` | `12.5px` | `var(--fs-sm)` |
| `.history__preview` | `12.5px` | `var(--fs-sm)` |
| `.app.is-dropping::after` | `font-size: 15px` | `var(--fs-lg)` |
| `.md-code-first[data-lang]::before` | `10.5px` | 无对应令牌（`--fs-xs` 是 11.5px）；保留并统一 |
| `.tree` / `.workspace__button` / `.tree__row` 等的 gap | `6px`、`7px`、`5px`、`2px`、`10px`、`18px` 混用 | 优先 `--s1`(4) / `--s2`(8)；`6px` 是高达 20+ 处的既成事实，收敛需单独一轮 |

### 3. 圆角写法不统一

`99px`（`.toast` / `.tag` / `.switch` / `.storage-bar` / 滚动条）与 `999px`（`.busy`）并存；`4px`（多处的微圆角）、`5px`（`.seal` 的内联值，等于 `--radius-sm`）、`11px` / `12px` / `13px`（各档印章）、`3px`（`.md-mark` / `.md-wikilink` / 焦点环）都没有令牌。
**不影响观感，但新代码请用 `99px` 与既有令牌。**

### 4. 内联样式（`src/*.tsx` + `src/components/*.tsx`：`style={…}` 共 78 处，其中 `style={{ … }}` 字面对象 62 处）

按文件分布（`style={{` 计数）：**62 处**，分布：

| 文件 | 处数 |
| --- | --- |
| `src/components/ImportApiPanel.tsx` | 24 |
| `src/components/Sidebar.tsx` | 15 |
| `src/components/AppDialogs.tsx` | 8 |
| `src/components/Overlays.tsx` | 5 |
| `src/components/InboxPanel.tsx` | 4 |
| `src/components/Outline.tsx` | 3 |
| `src/components/CommandPalette.tsx` | 2 |
| `src/App.tsx` | 1 |

三类要分开看：

1. **合理且已文档化**：`ImportApiPanel.tsx` 是最大的一处（`style={{` 24 处 / `style={` 约 55 处），文件顶部明确写了「不新增 CSS：只用既有类名 + 既有 token 的内联样式」，并且用的是**引用令牌的 `CSSProperties` 常量**（`gap: "var(--s2)"`、`fontSize: "var(--fs-xs)"`、`borderRadius: "var(--radius-sm)"`）。这一处**不是违规**。
2. **合理**：把运行时才知道的值传给固定定位的浮层 —— `Overlays.tsx` 的 `.menu` 的 `left` / `top`、`Sidebar.tsx` 的树缩进 `paddingLeft: 6 + depth * 13`、`Outline.tsx` 的 `paddingLeft: 8 + (level - 1) * 11`。
3. **应当进 CSS 的**：例如 `Overlays.tsx` 里 `style={{ display: "block", fontSize: 12.5, marginBottom: 6 }}`（`12.5` 就是 `--fs-sm`）、`Outline.tsx:30` 的 `fontSize: level <= 2 ? 13 : 12.5`（`--fs-md` / `--fs-sm`）、`AppDialogs.tsx` 里给主题预览色块写的 `linear-gradient(135deg,#1c1915 50%,#eae3d7 50%)`（**字面色值**，且写死了夜读主题的两个色）。

**新代码的规则**：只有「值在运行时才知道」时才用内联样式，且**只放定位与尺寸**；颜色 / 字体 / 圆角一律进 CSS，需要令牌时写 `var(--token)` 而不是它的字面值。

### 5. 三份平行的组件实现

同一套设计语言现在有三处独立实现，**没有共享机制**：

| 位置 | tokens | base 层 | 各自的组件 |
| --- | --- | --- | --- |
| 应用 `src/styles/*` | `tokens.css` | `base.css` | `app.css` + `prose.css` + `editor.css` |
| 剪藏页 `src/clip-web/clip.css` | 引用同一个 `tokens.css` | 引用 `base.css` | `.clip__*` |
| 扩展 `extension/src/**` | **构建期整份复制** | **逐字拷贝**（`popup.css` 顶部） | `.clip__*` / `.status-chip` |

后果：改 `base.css` 的 `.btn` 不会自动影响扩展的 popup；扩展有一份自己的 `.btn` 拷贝。
**缓解措施**：`extension/build.mjs` 对 `tokens.css` 有 sha256 门禁（改令牌不改扩展会构建失败），但 `base.css` **没有**这个门禁。

另外还有一个容易漏掉的样式面：**`src/editor/theme.ts`**（`EditorView.theme()` 用 JS 写 CodeMirror 的结构层：正文栏、光标、行号槽、查找面板、补全提示）。它是唯一一个「样式写在 TS 里」的地方，同样只用令牌 —— 但改令牌或改 CodeMirror 版本时它不在 `src/styles/` 里，别忘了一起看。

### 6. 扩展里两处残留的字面色值 / 空类名

| 位置 | 现状 | 正确做法 |
| --- | --- | --- |
| `extension/src/background.js:613` | `chrome.action.setBadgeBackgroundColor({ color: "#8c2f24" })` —— 写死了「比朱砂稍深」的一个值，**不是任何一个令牌** | 徽标色应取自 `--accent`（构建期已经会解析 `--accent` 来生成图标 PNG，同一个机制可以复用）。当前写死导致换强调色时徽标不跟着变 |
| `extension/src/popup/popup.html` | 用了 `.clip__token`、`.clip__token-main`、`.clip__token-saved`、`.clip__token-code`、`.clip__token-next`、`.clip__token-input`、`.clip__hint--cost`、`.clip__confirm--foot` 这些类名，但**`popup.css` 里没有任何对应规则**（逐条核对为 0 命中），还有 `.btn--danger` 也没定义 | 要么补规则，要么从 HTML 里删掉。留着会让人以为有样式约束，实际没有 |

### 7. 交互态的写法不统一

同一件事在项目里有两种写法，新代码请统一到「bg + 字色」那一列：

| 只改背景 | 背景 + 字色（**推荐，是多数**） |
| --- | --- |
| `.history__item:hover`、`.inbox__item:hover`、`.segmented button:hover`、`.swatch:hover`（只改边框）、`.tree__group--toggle:hover`（只改字色） | `.tree__row`、`.tab`、`.sidebar__tab`、`.outline__item`、`.menu__item`、`.settings__tab`、`.cmd`、`.empty__recent-item`、`.workspace__button`、`.statusbar__item--button`、`.choice`（边框 + 底） |

另外：
- **声明了过渡的**：多数列表行 `transition: background …, color … var(--dur-fast) var(--ease)`；**漏了过渡的**：`.history__item`、`.menu__item`、`.segmented` —— 导致同类控件手感不一致。
- **禁用态有两条路径**：`.menu__item[disabled]`（属性选择器）vs `.choice:disabled` / `.cmd:disabled` / `.btn:disabled`（伪类）。用 `<button disabled>` 就用 `:disabled`；用 `<div role="menuitem">` 时才需要 `[disabled]`。**不要**两套都写。
- **层叠上有两处需要小心**（`is-on` 与 hover 的顺序、`.workspace__menu .menu__item.is-active` 用三节选择器压过 `.menu__item:hover`）：改这两处的选择器顺序 / 权重前先跑一遍键盘导航。

### 8. 重复的写法

| 重复项 | 说明 |
| --- | --- |
| `.tree__group::after` 与 `.inbox__group::after` | **逐字节相同**（`flex: 1` + 1px `--rule` 横线），出现两处 |
| `.empty__seal` 与 `.inbox__empty .empty__seal` | 同一个印章徽标的两份定义（52px / 40px），第二份还少了 `--shadow-2` |
| 印章的内描边 | `.seal`（1px/.32）、`.boot__seal`（1.5px/.35）、`.empty__seal`（1.5px/.32）、扩展 `.seal`（1px/.32）—— **四个近似值**，规范值应是 `inset 0 0 0 1.5px rgb(255 255 255 / 0.32)` |
| `.btn` 的公共层 | 应用 `base.css` 一份 + 扩展 `popup.css` 一份（见 §5） |

### 9. 令牌的「定义了但没人用」与「用了但不是令牌」

- **`app.css` 里从未使用的令牌**：`--s7`、`--fs-lg`、`--code-bg`、`--sel`、`--grain`、`--measure`、`--doc-fs`、`--doc-lh`（后四个的消费方在 `prose.css` / `editor.css` / `editor/theme.ts`）。`--shadow-1` 只用了一次（开关滑块）。
  → 这不代表可以删：它们是**跨文件的契约**。但如果你在 `app.css` 里手写了 `15px`，先想到 `--fs-lg` 就在那儿。
- **`font-weight: 550`**（`.tree__row.is-active`、`.tab.is-active`、`.setting__label`）依赖**可变字体的中间字重**。如果哪天把 `--font-ui` 换成非可变字体，这些地方会退化成 600（或 400），需要重新指定。正文里的强调用 650（`.prose strong`、`.md-strong`），同理。
- **`.sr-only` 已定义但当前全仓无人使用**（`base.css`）。它是正确的工具，需要「仅读屏可见」的文字时用它，不要 `display: none`。

### 10. 没有自动化的设计约束检查

「不出现字面色值」「不新增令牌」「不使用 `sheen`」这些规则目前**只靠人看**。仓库里现有的检查是 `pnpm typecheck` / `pnpm test`（Vitest）与扩展自带的 `verify.mjs`，**没有** CSS lint 或令牌门禁（扩展侧的 tokens 哈希除外）。
这是一个可以考虑补上的缺口：一个「CSS 里不出现 `#hex`/`rgb()`」的机检脚本，就能把本节的第 1 类问题永久挡住。

### 11. 明确「不在范围内」的东西

- **动画的物理细节**：Mermaid / KaTeX 的渲染时序、CodeMirror 的滚动惯性、系统级滚动条在 Windows 上的宽度（`10px` 是作者样式，`scrollbar-width: thin` 生效于 Firefox）。
- **移动端布局**：`≤720px` 是当前实现的下限，但没有针对触屏做专门的手势与安全区适配（`viewport-fit=cover` 已设，`env(safe-area-inset-*)` 未使用）。
- **高对比度模式（`forced-colors`）**：没有适配。
- **`--ink-3` 的对比度**：见 §Accessibility，是既有限制，修它需要改整套令牌。
- **5 主题 × 4 强调色的视觉回归**：目前靠人眼，没有截图基线。`docs/screenshot*.png` 是 README 用的样张，不是回归基线。
- **`clip-web` 与扩展 popup 的「同一界面两份实现」**：这是刻意的（插件里那半件事已由「Opennote 自己服务网页版剪藏页」取代），见 `docs/import/03-UI设计规范-剪藏与导入.md` 的 tombstone 记录。

---

## Sources of Truth · 事实来源

本文档的所有取值都来自以下文件，改动它们时请同步本文件：

| 文件 | 承载的事实 |
| --- | --- |
| `src/styles/tokens.css` | 55 个令牌的全部取值：布局常量、间距、动效、字体栈、字号、5 套调色板、4 套强调色、`[data-font]` / `[data-width]` 预设 |
| `src/styles/base.css` | 重置、公共 chrome 类、`:focus-visible`、4 个进场景动画、`prefers-reduced-motion` 降级、滚动条、纸张颗粒、启动页 |
| `src/styles/app.css` | 应用外壳与全部界面组件（§Components 的出处） |
| `src/styles/prose.css` | 正文排版 + `@media print` |
| `src/styles/editor.css` | CodeMirror 文档表面 + 专注 / 打字机模式 |
| `src/editor/theme.ts` | **第 6 个样式面**：CodeMirror 的结构层主题（正文栏 / 光标 / 行号槽 / 查找面板 / 补全提示）与语法高亮的 class 映射 |
| `src/clip-web/clip.css` | 剪藏页布局 |
| `extension/src/popup/popup.css` | 扩展 popup（含「不定义令牌、不出现色值」的自述） |
| `extension/src/content/picker.js` | 注入宿主页面的元素选择覆盖层（构建期注入 `tokens.css`，`:root` → `:host`） |
| `extension/build.mjs` | 令牌整份复制 + sha256 门禁；图标由 `--accent` 生成 |
| `src/main.tsx` | CSS 导入顺序（tokens → base → prose → editor → app）与字体 / KaTeX 的导入 |
| `src/data/types.ts` | `ThemeId` / `AccentId` / `FontId` / `WidthId` 枚举、`THEMES` / `ACCENTS` / `FONTS` / `WIDTHS` 元数据、`DEFAULT_UI` |
| `src/data/ui.ts` | 主题的持久化（`opennote.ui.v1`）、`applyUi()` 的 `data-*` 契约、霞鹜文楷的按需加载 |
| `index.html` | 首屏防闪的内联主题脚本、`theme-color`、`lang="zh-CN"`、启动失败卡片 |
| `electron/main.cjs` | 窗口尺寸与最小尺寸、无边框标题栏（`titleBarStyle` / `titleBarOverlay` / macOS 红绿灯位置）、`--titlebar-inset` 的由来 |
| `src/components/Icons.tsx` | 39 个图标名字与 `Icon` 的几何契约 |
| `src/lib/toast.ts` | toast 的两档时长与最多 4 条的堆叠上限 |
| `scripts/make_icons.py` / `public/favicon.svg` | 品牌印章的几何与唯一的「品牌色字面值」 |
| `docs/import/03-UI设计规范-剪藏与导入.md` | `S-C1…S-C8` 控件状态通例、断点与最小尺寸、对比度实测表、逐界面状态编号 |

---

**最后一句**：这份文件的价值不在于它列了多少取值，而在于**当你在两条路之间犹豫时，它能替你决定** —— 需要一个新的灰？用 `color-mix()` 混。需要一个新的强调？不要，用 `--accent`。需要一个新字号？没有，用 4 档里最接近的那档。需要一个新的成功色？**绝对不要**，用一句中文说清楚。

如果某条规则真的挡住了必须做的事，**改这份文件**，再改代码。不要偷偷绕过它 —— 那样下次生成出来的代码就会和现在这版不一样了。
