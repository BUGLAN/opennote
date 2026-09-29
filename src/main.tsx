import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

/* Self-hosted typefaces — no CDN round-trip on first paint. */
import "@fontsource-variable/fraunces/full.css";
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";
import "@fontsource-variable/figtree/index.css";
import "@fontsource-variable/figtree/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";
import "katex/dist/katex.min.css";

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/prose.css";
import "./styles/editor.css";
import "./styles/app.css";

import App from "./App";
import { loadAssetIndex } from "./data/assets";
import { applyUi, getUi, systemPrefersDark } from "./data/ui";

const ui = getUi();
// First visit: follow the operating system instead of forcing a light page.
if (ui.theme === "paper" && ui.appearance === "light" && systemPrefersDark() && !localStorage.getItem("opennote.ui.v1")) {
  localStorage.setItem("opennote.ui.v1", JSON.stringify({ ...ui, theme: ui.darkTheme, appearance: "dark" }));
}
applyUi(getUi());

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void loadAssetIndex().then((count) => {
  if (count > 0) console.info(`[opennote] ${count} 个图片资源已就绪`);
});
