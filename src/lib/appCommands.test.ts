import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildAppCommands, type AppCommand, type CommandContext } from "./appCommands";

function commandsFor(readOnly: boolean): AppCommand[] {
  const view = {
    state: EditorState.create({ doc: "正文", extensions: EditorState.readOnly.of(readOnly) }),
  } as EditorView;
  return buildAppCommands({ view: () => view } as unknown as CommandContext);
}

describe("editorCommand：只读锁", () => {
  it("点文档的格式命令在只读时不可用，解锁后恢复", () => {
    const locked = commandsFor(true);
    const unlocked = commandsFor(false);
    const ids = [
      "undo",
      "redo",
      ...locked.filter((command) => command.group === "格式" && command.id !== "copy-markdown").map((command) => command.id),
    ];

    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      expect(locked.find((command) => command.id === id)?.enabled?.()).toBe(false);
      expect(unlocked.find((command) => command.id === id)?.enabled?.()).toBe(true);
    }
  });
});
