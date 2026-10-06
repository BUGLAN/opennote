import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENTS, THEMES, type ThemeKind } from "../data/types";
import { themeKind } from "../data/ui";
import { sealIconUrl } from "./sealIcon";

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

describe("sealIconUrl", () => {
  it("按「强调色-明暗」拼出相对路径（桌面版 file:// 下也能解析）", () => {
    expect(sealIconUrl("indigo", "dark")).toBe("./seal/indigo-dark.png");
    expect(sealIconUrl("seal", "light")).toBe("./seal/seal-light.png");
  });

  it("每套强调色 × 主题组合都指向一个**真实存在**的图标", () => {
    // 图标是 `pnpm icons` 生成的。少一个文件只会在「切到那套主题」时才暴露成破图，
    // 所以这里把 4 套强调色 × 5 套主题的 20 种组合都查一遍。
    const missing: string[] = [];
    for (const accent of ACCENTS.map((entry) => entry.id)) {
      for (const theme of THEMES) {
        const url = sealIconUrl(accent, themeKind(theme.id));
        if (!existsSync(PUBLIC_DIR + url.replace("./", ""))) missing.push(`${theme.id} + ${accent} → ${url}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("明暗两档都有对应文件（生成器从 tokens.css 读颜色，不是手抄）", () => {
    const kinds: ThemeKind[] = ["light", "dark"];
    for (const accent of ACCENTS.map((entry) => entry.id)) {
      for (const kind of kinds) {
        const file = `${PUBLIC_DIR}seal/${accent}-${kind}.png`;
        expect(existsSync(file), `${file} 不存在，跑一次 pnpm icons`).toBe(true);
      }
    }
  });
});
