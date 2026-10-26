import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { ReplacementDictionary, WordReplacement } from "@/bindings";
import {
  parseDictionaryCsv,
  serializeDictionaryCsv,
} from "@/lib/dictionaryCsv";
import { useSettings } from "../../hooks/useSettings";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { SettingContainer } from "../ui/SettingContainer";

interface WordReplacementsProps {
  grouped?: boolean;
}

// Decorative separator between the "from" and "to" terms. Kept as a constant
// (not inline JSX text) so the i18next no-literal-string lint passes.
const ARROW = "→";

// Sentinel option value for "no dictionary active" in the activation select.
const NONE = "__none__";

const triggerDownload = (name: string, text: string) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

export const WordReplacements: React.FC<WordReplacementsProps> = React.memo(
  ({ grouped = false }) => {
    const { t } = useTranslation();
    const { getSetting, updateSetting, isUpdating } = useSettings();
    const dictionaries: ReplacementDictionary[] =
      getSetting("replacement_dictionaries") || [];
    const activeId = getSetting("active_dictionary_id") ?? null;
    const updating =
      isUpdating("replacement_dictionaries") ||
      isUpdating("active_dictionary_id");

    // Which dictionary is being edited (independent of which is active).
    const [editingId, setEditingId] = useState<string | null>(null);
    const editing =
      dictionaries.find((d) => d.id === editingId) ?? dictionaries[0] ?? null;

    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [newName, setNewName] = useState("");
    const [renaming, setRenaming] = useState(false);
    const [renameValue, setRenameValue] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const dictionaryOptions = useMemo(
      () => dictionaries.map((d) => ({ value: d.id, label: d.name })),
      [dictionaries],
    );
    const activeOptions = useMemo(
      () => [
        { value: NONE, label: t("settings.advanced.wordReplacements.none") },
        ...dictionaryOptions,
      ],
      [dictionaryOptions, t],
    );

    const saveDictionaries = (next: ReplacementDictionary[]) =>
      updateSetting("replacement_dictionaries", next);

    const replaceEditing = (entries: WordReplacement[]) => {
      if (!editing) return;
      saveDictionaries(
        dictionaries.map((d) => (d.id === editing.id ? { ...d, entries } : d)),
      );
    };

    const handleAddDictionary = () => {
      const name = newName.trim();
      if (!name) return;
      const id = crypto.randomUUID();
      saveDictionaries([...dictionaries, { id, name, entries: [] }]);
      setEditingId(id);
      setNewName("");
    };

    const handleRename = () => {
      const name = renameValue.trim();
      setRenaming(false);
      if (!editing || !name || name === editing.name) return;
      saveDictionaries(
        dictionaries.map((d) => (d.id === editing.id ? { ...d, name } : d)),
      );
    };

    const handleDelete = () => {
      if (!editing) return;
      if (
        !window.confirm(
          t("settings.advanced.wordReplacements.deleteConfirm", {
            name: editing.name,
          }),
        )
      ) {
        return;
      }
      const remaining = dictionaries.filter((d) => d.id !== editing.id);
      // The backend also clears a dangling active id; mirror it here so the
      // store does not briefly show a stale choice.
      if (activeId === editing.id) updateSetting("active_dictionary_id", null);
      saveDictionaries(remaining);
      setEditingId(remaining[0]?.id ?? null);
    };

    const handleAdd = () => {
      const trimmedFrom = from.trim();
      const trimmedTo = to.trim();
      if (!trimmedFrom || !editing) return;
      if (
        editing.entries.some(
          (r) => r.from.toLowerCase() === trimmedFrom.toLowerCase(),
        )
      ) {
        toast.error(
          t("settings.advanced.wordReplacements.duplicate", {
            word: trimmedFrom,
          }),
        );
        return;
      }
      replaceEditing([
        ...editing.entries,
        { from: trimmedFrom, to: trimmedTo },
      ]);
      setFrom("");
      setTo("");
    };

    const handleRemove = (fromToRemove: string) => {
      if (!editing) return;
      replaceEditing(editing.entries.filter((r) => r.from !== fromToRemove));
    };

    const handleKeyPress = (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleAdd();
      }
    };

    const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file || !editing) return;
      const parsed = parseDictionaryCsv(await file.text());
      const known = new Set(editing.entries.map((r) => r.from.toLowerCase()));
      const fresh = parsed.filter((r) => {
        const key = r.from.toLowerCase();
        if (known.has(key)) return false;
        known.add(key);
        return true;
      });
      replaceEditing([...editing.entries, ...fresh]);
      toast.success(
        t("settings.advanced.wordReplacements.importedCount", {
          count: fresh.length,
        }),
      );
    };

    const handleExport = () => {
      if (!editing) return;
      triggerDownload(
        `${editing.name}.csv`,
        serializeDictionaryCsv(editing.entries),
      );
    };

    return (
      <>
        <SettingContainer
          title={t("settings.advanced.wordReplacements.activeForDictation")}
          description={t(
            "settings.advanced.wordReplacements.activeDescription",
          )}
          descriptionMode="inline"
          grouped={grouped}
        >
          <Select
            value={activeId ?? NONE}
            options={activeOptions}
            isClearable={false}
            disabled={updating}
            className="min-w-[12rem]"
            onChange={(value) =>
              updateSetting(
                "active_dictionary_id",
                value && value !== NONE ? value : null,
              )
            }
          />
        </SettingContainer>

        <SettingContainer
          title={t("settings.advanced.wordReplacements.title")}
          description={t("settings.advanced.wordReplacements.description")}
          descriptionMode="inline"
          layout="stacked"
          grouped={grouped}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={editing?.id ?? null}
              options={dictionaryOptions}
              isClearable={false}
              disabled={updating || dictionaries.length === 0}
              placeholder={t(
                "settings.advanced.wordReplacements.noDictionaries",
              )}
              className="min-w-[12rem]"
              onChange={(value) => setEditingId(value)}
            />
            <Input
              type="text"
              className="flex-1 min-w-[10rem]"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddDictionary();
                }
              }}
              placeholder={t(
                "settings.advanced.wordReplacements.newDictionaryName",
              )}
              variant="compact"
              disabled={updating}
              aria-label={t(
                "settings.advanced.wordReplacements.newDictionaryName",
              )}
            />
            <Button
              onClick={handleAddDictionary}
              disabled={!newName.trim() || updating}
              variant="primary"
              size="md"
              className="shrink-0"
            >
              {t("settings.advanced.wordReplacements.addDictionary")}
            </Button>
          </div>

          {editing && (
            <div className="flex flex-wrap items-center gap-2">
              {renaming ? (
                <Input
                  type="text"
                  className="min-w-[10rem]"
                  value={renameValue}
                  autoFocus
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleRename}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleRename();
                    } else if (e.key === "Escape") {
                      setRenaming(false);
                    }
                  }}
                  variant="compact"
                  aria-label={t("settings.advanced.wordReplacements.rename")}
                />
              ) : (
                <Button
                  onClick={() => {
                    setRenameValue(editing.name);
                    setRenaming(true);
                  }}
                  disabled={updating}
                  variant="secondary"
                  size="sm"
                >
                  {t("settings.advanced.wordReplacements.rename")}
                </Button>
              )}
              <Button
                onClick={() => fileInputRef.current?.click()}
                disabled={updating}
                variant="secondary"
                size="sm"
              >
                {t("settings.advanced.wordReplacements.importCsv")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={handleImportFile}
              />
              <Button
                onClick={handleExport}
                disabled={updating || editing.entries.length === 0}
                variant="secondary"
                size="sm"
              >
                {t("settings.advanced.wordReplacements.exportCsv")}
              </Button>
              <Button
                onClick={handleDelete}
                disabled={updating}
                variant="danger"
                size="sm"
              >
                {t("settings.advanced.wordReplacements.delete")}
              </Button>
            </div>
          )}

          {editing && (
            <div className="flex items-center gap-2">
              <Input
                type="text"
                className="flex-1 min-w-0"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder={t(
                  "settings.advanced.wordReplacements.fromPlaceholder",
                )}
                variant="compact"
                disabled={updating}
                aria-label={t("settings.advanced.wordReplacements.fromLabel")}
              />
              <span
                className="text-mid-gray shrink-0 select-none"
                aria-hidden="true"
              >
                {ARROW}
              </span>
              <Input
                type="text"
                className="flex-1 min-w-0"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                onKeyDown={handleKeyPress}
                placeholder={t(
                  "settings.advanced.wordReplacements.toPlaceholder",
                )}
                variant="compact"
                disabled={updating}
                aria-label={t("settings.advanced.wordReplacements.toLabel")}
              />
              <Button
                onClick={handleAdd}
                disabled={!from.trim() || updating}
                variant="primary"
                size="md"
                className="shrink-0"
              >
                {t("settings.advanced.wordReplacements.add")}
              </Button>
            </div>
          )}
        </SettingContainer>
        {editing && editing.entries.length > 0 && (
          <div
            className={`px-4 p-2 ${grouped ? "" : "rounded-lg border border-mid-gray/20"} flex flex-wrap gap-1`}
          >
            {editing.entries.map((replacement) => (
              <Button
                key={replacement.from}
                onClick={() => handleRemove(replacement.from)}
                disabled={updating}
                variant="secondary"
                size="sm"
                className="inline-flex items-center gap-1.5 cursor-pointer"
                aria-label={t("settings.advanced.wordReplacements.remove", {
                  from: replacement.from,
                  to: replacement.to,
                })}
              >
                <span className="font-semibold">{replacement.from}</span>
                <span className="text-mid-gray" aria-hidden="true">
                  {ARROW}
                </span>
                <span className="font-semibold">
                  {replacement.to || (
                    <span className="italic font-normal text-mid-gray">
                      {t("settings.advanced.wordReplacements.emptyTarget")}
                    </span>
                  )}
                </span>
                <svg
                  className="w-3 h-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </Button>
            ))}
          </div>
        )}
      </>
    );
  },
);
