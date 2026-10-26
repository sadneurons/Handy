import assert from "node:assert/strict";
import { resolveImportChoice } from "./importDictionaryChoice";

const ids = ["d1", "d2"];
assert.deepEqual(resolveImportChoice("__global__", ids), { kind: "global" });
assert.deepEqual(resolveImportChoice("__none__", ids), { kind: "none" });
assert.deepEqual(resolveImportChoice("d2", ids), {
  kind: "dictionary",
  id: "d2",
});
// A remembered dictionary that has since been deleted falls back to global,
// matching what the dropdown displays.
assert.deepEqual(resolveImportChoice("gone", ids), { kind: "global" });
console.log("importDictionaryChoice tests passed");
