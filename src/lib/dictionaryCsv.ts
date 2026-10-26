import type { WordReplacement } from "@/bindings";

// Two-column CSV (`from,to`) for sharing replacement dictionaries. A small
// RFC 4180 subset: quoted fields may hold commas, newlines and doubled
// quotes. The header row is optional on import and always written on export.

const HEADER = "from,to";

const splitRecords = (text: string): string[][] => {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  return records;
};

export const parseDictionaryCsv = (text: string): WordReplacement[] => {
  const entries: WordReplacement[] = [];
  for (const [index, record] of splitRecords(text).entries()) {
    const from = (record[0] ?? "").trim();
    const to = (record[1] ?? "").trim();
    if (
      index === 0 &&
      from.toLowerCase() === "from" &&
      to.toLowerCase() === "to"
    ) {
      continue;
    }
    if (!from) continue;
    entries.push({ from, to });
  }
  return entries;
};

const quote = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

export const serializeDictionaryCsv = (entries: WordReplacement[]): string =>
  [HEADER, ...entries.map((e) => `${quote(e.from)},${quote(e.to)}`)].join(
    "\n",
  ) + "\n";
