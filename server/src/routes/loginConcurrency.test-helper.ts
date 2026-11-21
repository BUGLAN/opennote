import { vi } from "vitest";
import type { AccountStore } from "../auth/accounts";

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function waitUntil(predicate: () => boolean, description: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

export type HeldAccountMethod = "login" | "create" | "setup" | "acceptInvite" | "resetPassword" | "changePassword" | "setPassword";

/** 把真实的账号操作挡在入口，用来确定性地制造多个 KDF 同时在途。 */
export function holdAccountMethod(accounts: AccountStore, method: HeldAccountMethod): {
  entered: () => number;
  release: () => void;
  restore: () => void;
} {
  const gate = deferred<void>();
  const holder = accounts as unknown as Record<HeldAccountMethod, (...args: never[]) => Promise<unknown>>;
  const original = holder[method].bind(accounts);
  let entered = 0;
  const spy = vi.spyOn(holder, method).mockImplementation(async (...args) => {
    entered += 1;
    await gate.promise;
    return original(...args);
  });
  return {
    entered: () => entered,
    release: () => gate.resolve(undefined),
    restore: () => spy.mockRestore(),
  };
}

/** 把真实账号校验挡在闸门前，用来确定性地制造并发登录。 */
export function holdAccountLogins(accounts: AccountStore): ReturnType<typeof holdAccountMethod> {
  return holdAccountMethod(accounts, "login");
}
