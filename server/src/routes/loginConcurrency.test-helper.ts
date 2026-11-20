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

/** 把真实账号校验挡在闸门前，用来确定性地制造并发请求。 */
export function holdAccountLogins(accounts: AccountStore): {
  entered: () => number;
  release: () => void;
  restore: () => void;
} {
  const gate = deferred<void>();
  const original = accounts.login.bind(accounts);
  let entered = 0;
  const spy = vi.spyOn(accounts, "login").mockImplementation(async (email, password) => {
    entered += 1;
    await gate.promise;
    return original(email, password);
  });
  return {
    entered: () => entered,
    release: () => gate.resolve(undefined),
    restore: () => spy.mockRestore(),
  };
}
