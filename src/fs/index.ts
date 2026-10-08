export * from "./paths";
export * from "./types";
export * from "./handles";
export * from "./opfs";
export * from "./fsa";
export { createHandleBackend } from "./handleBackend";
export { createNodeBackend } from "./nodeBackend";
export {
  CAPACITOR_NOTES_ROOT,
  capacitorWorkspaceDir,
  createCapacitorBackend,
  ensureCapacitorPermissions,
  isCapacitorNative,
} from "./capacitorBackend";
