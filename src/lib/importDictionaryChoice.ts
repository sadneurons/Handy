import type { FileDictionaryChoice } from "@/bindings";

// Select values for the per-import dictionary choice. Dictionary ids are
// UUIDs, so these two sentinels cannot collide with one.
export const IMPORT_GLOBAL = "__global__";
export const IMPORT_NONE = "__none__";

// Turns the remembered dropdown value into the backend choice. A dictionary
// that no longer exists resolves to the global one, so what is sent always
// matches what the dropdown shows.
export const resolveImportChoice = (
  value: string,
  dictionaryIds: string[],
): FileDictionaryChoice => {
  if (value === IMPORT_NONE) return { kind: "none" };
  if (dictionaryIds.includes(value)) return { kind: "dictionary", id: value };
  return { kind: "global" };
};
