import assert from "node:assert/strict";
import { parseDictionaryCsv, serializeDictionaryCsv } from "./dictionaryCsv";

// Header row is skipped.
assert.deepEqual(parseDictionaryCsv("from,to\ngithub,GitHub\n"), [
  { from: "github", to: "GitHub" },
]);

// Quoted fields keep embedded commas and quotes; blank lines are ignored.
assert.deepEqual(parseDictionaryCsv('"a, b",c\n\n"say ""hi""",hello\n   \n'), [
  { from: "a, b", to: "c" },
  { from: 'say "hi"', to: "hello" },
]);

// CRLF endings, surrounding whitespace, and a missing second column.
assert.deepEqual(parseDictionaryCsv("From,To\r\n  um  ,\r\nfoo\r\n"), [
  { from: "um", to: "" },
  { from: "foo", to: "" },
]);

// Rows with an empty "from" are dropped.
assert.deepEqual(parseDictionaryCsv(",x\n"), []);

// Round trip is stable and always writes a header.
const entries = [
  { from: "a, b", to: "c" },
  { from: 'say "hi"', to: "" },
  { from: "plain", to: "Plain" },
];
const csv = serializeDictionaryCsv(entries);
assert.ok(csv.startsWith("from,to\n"), csv);
assert.deepEqual(parseDictionaryCsv(csv), entries);

console.log("dictionaryCsv tests passed");
