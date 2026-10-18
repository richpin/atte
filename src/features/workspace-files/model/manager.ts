import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TranslationKey } from "shared/i18n";
import {
  createEffect,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createFilesModel } from "./files";

type Translate = (key: TranslationKey) => string;
export type FileDialog = {
  title: string;
  message: string;
  choices: { id: string; label: string }[];
  input?: string;
  resolve: (value: { choice: string; text: string }) => void;
};
export function createFilesManager(t: Translate) {
  const [models, setModels] = createSignal<
    ReturnType<typeof createFilesModel>[]
  >([]);
  const [dialog, setDialog] = createSignal<FileDialog>();
  const disposers = new Map<string, () => void>();
  let checking = false;
  function ask(options: Omit<FileDialog, "resolve">) {
    if (dialog()) return Promise.resolve({ choice: "cancel", text: "" });
    return new Promise<{ choice: string; text: string }>((resolve) =>
      setDialog({ ...options, resolve }),
    );
  }
  function answer(choice: string, text = "") {
    const request = dialog();
    setDialog(undefined);
    request?.resolve({ choice, text });
  }
  function get(threadId: string) {
    const existing = models().find((model) => model.threadId === threadId);
    if (existing) return existing;
    const model = createRoot((dispose) => {
      disposers.set(threadId, dispose);
      return createFilesModel(threadId);
    });
    setModels((current) => [...current, model]);
    return model;
  }
  function forget(threadId: string) {
    models()
      .find((model) => model.threadId === threadId)
      ?.dispose();
    disposers.get(threadId)?.();
    disposers.delete(threadId);
    setModels((current) =>
      current.filter((model) => model.threadId !== threadId),
    );
  }
  async function guard(threadId?: string) {
    if (checking) return false;
    const affected = () =>
      models().filter(
        (model) =>
          (!threadId || model.threadId === threadId) && model.pending().length,
      );
    if (!affected().length) return true;
    checking = true;
    try {
      const decision = await ask({
        title: t("files.unsavedTitle"),
        message: affected()
          .flatMap((model) => model.pending().map((draft) => draft.path))
          .join("\n"),
        choices: [
          { id: "save", label: t("files.saveAll") },
          { id: "discard", label: t("files.discard") },
          { id: "cancel", label: t("files.cancel") },
        ],
      });
      if (decision.choice === "discard") {
        for (const model of affected()) model.discard();
        return true;
      }
      if (decision.choice !== "save") return false;
      for (const model of affected()) {
        if (!(await model.saveAll())) {
          await ask({
            title: t("files.saveFailed"),
            message: t("files.saveFailedDescription"),
            choices: [{ id: "cancel", label: t("files.cancel") }],
          });
          return false;
        }
      }
      return !affected().length;
    } finally {
      checking = false;
    }
  }
  createEffect(() => {
    const dirty = models().some((model) => model.pending().length > 0);
    if (isTauri()) void invoke("set_files_dirty", { dirty });
  });
  onMount(() => {
    if (!isTauri()) return;
    let dead = false;
    const listener = listen("files-quit-requested", async () => {
      const proceed = await guard();
      await invoke("resolve_quit", { proceed });
    });
    void listener.then((unlisten) => {
      if (dead) unlisten();
    });
    onCleanup(() => {
      dead = true;
      void listener.then((unlisten) => unlisten());
    });
  });
  onCleanup(() => {
    answer("cancel");
    for (const model of models()) model.dispose();
    for (const dispose of disposers.values()) dispose();
  });
  return { get, forget, guard, ask, answer, dialog };
}
export type FilesManager = ReturnType<typeof createFilesManager>;
