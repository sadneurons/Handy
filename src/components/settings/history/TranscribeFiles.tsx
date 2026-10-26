import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { commands, events, FileTranscriptResult } from "../../../bindings";
import { useSettings } from "../../../hooks/useSettings";
import {
  IMPORT_GLOBAL,
  IMPORT_NONE,
  resolveImportChoice,
} from "@/lib/importDictionaryChoice";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { ToggleSwitch } from "../../ui/ToggleSwitch";

const GLOBAL = IMPORT_GLOBAL;
const NONE = IMPORT_NONE;
const CHOICE_KEY = "handy.import.dictionary";

const loadChoice = (): string => {
  try {
    return localStorage.getItem(CHOICE_KEY) || GLOBAL;
  } catch {
    return GLOBAL;
  }
};

const AUDIO_EXTENSIONS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "opus",
  "wma",
  "aiff",
  "mp4",
  "webm",
];

const isAudioPath = (p: string) =>
  AUDIO_EXTENSIONS.includes((p.split(".").pop() || "").toLowerCase());

interface Progress {
  index: number;
  total: number;
  file: string;
  stage: string;
}

export const TranscribeFiles: React.FC = () => {
  const { t } = useTranslation();
  const { getSetting } = useSettings();
  const [postProcess, setPostProcess] = useState<boolean>(
    getSetting("post_process_enabled") || false,
  );
  const dictionaries = getSetting("replacement_dictionaries") || [];
  const [dictionaryValue, setDictionaryValue] = useState<string>(loadChoice);
  // Drop events fire from a listener registered once; read the latest
  // options through a ref so the listener never goes stale.
  const optionsRef = useRef({ postProcess, dictionaryValue });
  optionsRef.current = { postProcess, dictionaryValue };
  const dictionariesRef = useRef(dictionaries);
  dictionariesRef.current = dictionaries;

  const chooseDictionary = (value: string | null) => {
    const next = value ?? GLOBAL;
    setDictionaryValue(next);
    try {
      localStorage.setItem(CHOICE_KEY, next);
    } catch {
      // Remembering the choice is a convenience only.
    }
  };

  const dictionaryOptions = [
    {
      value: GLOBAL,
      label: t("settings.history.transcribeFiles.dictionaryGlobal"),
    },
    {
      value: NONE,
      label: t("settings.history.transcribeFiles.dictionaryNone"),
    },
    ...dictionaries.map((d) => ({ value: d.id, label: d.name })),
  ];
  // A remembered dictionary that has since been deleted falls back to global.
  const dictionarySelected = dictionaryOptions.some(
    (o) => o.value === dictionaryValue,
  )
    ? dictionaryValue
    : GLOBAL;
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [results, setResults] = useState<FileTranscriptResult[]>([]);
  const runningRef = useRef(false);

  const run = async (paths: string[]) => {
    const audio = paths.filter(isAudioPath);
    if (audio.length === 0 || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResults([]);
    setProgress({
      index: 0,
      total: audio.length,
      file: audio[0],
      stage: "decoding",
    });
    try {
      const { postProcess: pp, dictionaryValue: dv } = optionsRef.current;
      const res = await commands.transcribeFiles(
        audio,
        pp,
        resolveImportChoice(
          dv,
          dictionariesRef.current.map((d) => d.id),
        ),
      );
      if (res.status === "ok") setResults(res.data);
      else
        setResults([
          {
            source: audio[0],
            raw_path: null,
            cleaned_path: null,
            used_fallback: false,
            history_id: null,
            error: res.error,
          },
        ]);
    } finally {
      runningRef.current = false;
      setRunning(false);
      setProgress(null);
    }
  };

  useEffect(() => {
    const unlistenProgress = events.fileTranscribeProgress.listen((e) =>
      setProgress(e.payload),
    );
    const unlistenDrop = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over")
        setDragging(true);
      else if (e.payload.type === "leave") setDragging(false);
      else if (e.payload.type === "drop") {
        setDragging(false);
        run(e.payload.paths);
      }
    });
    return () => {
      unlistenProgress.then((f) => f());
      unlistenDrop.then((f) => f());
    };
  }, []);

  const pick = async () => {
    const chosen = await open({
      multiple: true,
      filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
    });
    if (!chosen) return;
    run(Array.isArray(chosen) ? chosen : [chosen]);
  };

  const fileName = (p: string) => p.split(/[\\/]/).pop() || p;

  return (
    <div className="space-y-2">
      <div className="px-4">
        <h2 className="text-xs font-medium text-mid-gray uppercase tracking-wide">
          {t("settings.history.transcribeFiles.title")}
        </h2>
      </div>
      <div
        className={`bg-background border rounded-lg p-4 space-y-3 transition-colors ${
          dragging
            ? "border-logo-primary bg-logo-primary/5"
            : "border-mid-gray/20"
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-mid-gray">
            {running && progress
              ? t("settings.history.transcribeFiles.progress", {
                  current: progress.index + 1,
                  total: progress.total,
                  file: fileName(progress.file),
                  stage: t(
                    `settings.history.transcribeFiles.stages.${progress.stage}`,
                  ),
                })
              : t("settings.history.transcribeFiles.description")}
          </p>
          <Button onClick={pick} disabled={running} variant="primary" size="md">
            {t("settings.history.transcribeFiles.choose")}
          </Button>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {t("settings.history.transcribeFiles.dictionary")}
          </span>
          <Select
            value={dictionarySelected}
            options={dictionaryOptions}
            isClearable={false}
            disabled={running}
            className="min-w-[12rem]"
            onChange={chooseDictionary}
          />
        </div>
        <ToggleSwitch
          checked={postProcess}
          onChange={setPostProcess}
          disabled={running}
          label={t("settings.history.transcribeFiles.postProcess")}
          description={t(
            "settings.history.transcribeFiles.postProcessDescription",
          )}
          descriptionMode="tooltip"
          grouped
        />
        {results.length > 0 && (
          <ul className="space-y-1 text-sm">
            {results.map((r) => (
              <li
                key={r.source}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">
                  <span className="font-medium">{fileName(r.source)}</span>
                  {r.error ? (
                    <span className="text-red-500"> — {r.error}</span>
                  ) : (
                    <span className="text-mid-gray">
                      {" — "}
                      {r.cleaned_path
                        ? t("settings.history.transcribeFiles.savedBoth")
                        : t("settings.history.transcribeFiles.savedRaw")}
                      {r.used_fallback &&
                        ` ${t("settings.history.transcribeFiles.fallback")}`}
                    </span>
                  )}
                </span>
                {r.raw_path && (
                  <Button
                    onClick={() => commands.openTranscriptFolder(r.raw_path!)}
                    variant="secondary"
                    size="sm"
                  >
                    {t("settings.history.transcribeFiles.showInFolder")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
