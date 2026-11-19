import { describe, expect, it } from "vitest";
import { MOBILE_QUERY, noteViewMode } from "./mobile";

describe("noteViewMode", () => {
  const base = { isNote: true, isMobile: false, locked: false, mobileEditing: false };

  it("桌面端打开笔记仍是编辑器", () => {
    expect(noteViewMode(base)).toBe("editing");
    expect(noteViewMode({ ...base, mobileEditing: true })).toBe("editing");
  });

  it("移动端默认阅读，点过「编辑」后进编辑器", () => {
    expect(noteViewMode({ ...base, isMobile: true })).toBe("mobile-reading");
    expect(noteViewMode({ ...base, isMobile: true, mobileEditing: true })).toBe("editing");
  });

  it("手动锁定的笔记在任何端都只读，移动端的「编辑」绕不过去", () => {
    expect(noteViewMode({ ...base, locked: true })).toBe("locked");
    expect(noteViewMode({ ...base, isMobile: true, locked: true, mobileEditing: true })).toBe("locked");
  });

  it("画布、HTML 页面不叠阅读视图", () => {
    expect(noteViewMode({ ...base, isNote: false, isMobile: true })).toBe("editing");
    expect(noteViewMode({ ...base, isNote: false, locked: true })).toBe("editing");
  });

  it("移动端判定与抽屉布局同一条 820px 线，并覆盖触屏", () => {
    expect(MOBILE_QUERY).toContain("max-width: 820px");
    expect(MOBILE_QUERY).toContain("pointer: coarse");
  });
});
