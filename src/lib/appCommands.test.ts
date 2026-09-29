import { describe, expect, it } from "vitest";
import { accel, matchesShortcut } from "./appCommands";

/** Node has no KeyboardEvent — a structural stand-in is enough for the matcher. */
function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
  return {
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...init,
  } as KeyboardEvent;
}

// These run on a non-Apple platform, so `mod` resolves to Ctrl.
describe("matchesShortcut", () => {
  it("matches the platform modifier", () => {
    expect(matchesShortcut(key({ key: "k", ctrlKey: true }), "mod+k")).toBe(true);
    expect(matchesShortcut(key({ key: "k" }), "mod+k")).toBe(false);
    expect(matchesShortcut(key({ key: "k", metaKey: true }), "mod+k")).toBe(false);
  });

  it("is case insensitive and accepts shifted letters", () => {
    expect(matchesShortcut(key({ key: "K", ctrlKey: true, shiftKey: true }), "mod+shift+k")).toBe(true);
    expect(matchesShortcut(key({ key: "F", ctrlKey: true, shiftKey: true }), "mod+shift+f")).toBe(true);
  });

  it("maps shifted digit symbols back to their digit", () => {
    expect(matchesShortcut(key({ key: "&", ctrlKey: true, shiftKey: true }), "mod+shift+7")).toBe(true);
    expect(matchesShortcut(key({ key: "7", ctrlKey: true, shiftKey: true }), "mod+shift+7")).toBe(true);
    expect(matchesShortcut(key({ key: "7", ctrlKey: true }), "mod+shift+7")).toBe(false);
  });

  it("rejects extra modifiers", () => {
    expect(matchesShortcut(key({ key: "k", ctrlKey: true, shiftKey: true }), "mod+k")).toBe(false);
    expect(matchesShortcut(key({ key: "k", ctrlKey: true, altKey: true }), "mod+k")).toBe(false);
  });

  it("handles named keys", () => {
    expect(matchesShortcut(key({ key: "ArrowRight", altKey: true }), "alt+arrowright")).toBe(true);
    expect(matchesShortcut(key({ key: "ArrowLeft", altKey: true, shiftKey: true }), "alt+arrowleft")).toBe(false);
    expect(matchesShortcut(key({ key: " ", ctrlKey: true }), "mod+space")).toBe(true);
  });

  it("does not fire a bare alt shortcut while ctrl is held", () => {
    expect(matchesShortcut(key({ key: "w", altKey: true }), "alt+w")).toBe(true);
    expect(matchesShortcut(key({ key: "w", altKey: true, ctrlKey: true }), "alt+w")).toBe(false);
  });

  it("accepts several bindings for one command", () => {
    const keys = ["alt+w", "mod+w", "mod+alt+w"];
    expect(keys.some((spec) => matchesShortcut(key({ key: "w", altKey: true }), spec))).toBe(true);
    expect(keys.some((spec) => matchesShortcut(key({ key: "w", ctrlKey: true }), spec))).toBe(true);
    expect(keys.some((spec) => matchesShortcut(key({ key: "q", altKey: true }), spec))).toBe(false);
  });
});

describe("accel", () => {
  it("renders a platform hint", () => {
    expect(accel("K")).toMatch(/K$/);
    expect(accel("K")).toMatch(/^(Ctrl|⌘) \+ K$/);
  });
});
