import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "shared/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { createStore } from "solid-js/store";
import {
  clearMcpImports,
  discoverMcps,
  importMcps,
  previewMcpImport,
  selectMcpImport,
  subscribeMcp,
} from "../api/mcps";
import type { ImportFormat, ImportSource, Target } from "../model/types";

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2";

export function ImportDialog(props: {
  target: Target;
  projects: { folder: string; name: string }[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [folder, setFolder] = createSignal(
    props.target.scope === "project" ? props.target.folder : "",
  );
  const [sources, setSources] = createSignal<ImportSource[]>([]);
  const [format, setFormat] = createSignal<ImportFormat>("json");
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [done, setDone] = createSignal(false);
  const [choices, setChoices] = createStore<
    Record<string, { selected: boolean; name: string; overwrite: boolean }>
  >({});
  const [names, setNames] = createSignal<string[]>([]);
  const [scopeError, setScopeError] = createSignal(false);
  createEffect(() => {
    const target: Target = folder()
      ? { scope: "project", folder: folder() }
      : { scope: "global" };
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    setNames([]);
    setScopeError(true);
    void subscribeMcp(target, (snapshot) => {
      if (!stopped) {
        setNames([
          ...Object.keys(snapshot.servers),
          ...snapshot.issues.map((issue) => issue.name),
        ]);
        setScopeError(Boolean(snapshot.error));
      }
    })
      .then((stop) => {
        if (stopped) stop();
        else unsubscribe = stop;
      })
      .catch(() => {
        if (!stopped) setScopeError(true);
      });
    onCleanup(() => {
      stopped = true;
      unsubscribe?.();
    });
  });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    void clearMcpImports().catch(() => {});
  });
  async function review(load: () => Promise<ImportSource[]>) {
    setBusy(true);
    setError(undefined);
    setDone(false);
    try {
      await clearMcpImports();
      const values = await load();
      if (disposed) {
        await clearMcpImports();
        return;
      }
      setSources(values);
      for (const source of values)
        for (const candidate of source.candidates)
          if (candidate.id)
            setChoices(candidate.id, {
              selected: false,
              name: candidate.name,
              overwrite: false,
            });
    } catch {
      if (!disposed) setError(t("mcps.reviewFailed"));
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  const selected = () =>
    sources()
      .flatMap((source) => source.candidates)
      .flatMap((candidate) =>
        candidate.id && choices[candidate.id]?.selected
          ? [
              {
                id: candidate.id,
                name: choices[candidate.id].name,
                overwrite: choices[candidate.id].overwrite,
              },
            ]
          : [],
      );
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await importMcps(
        folder() ? { scope: "project", folder: folder() } : { scope: "global" },
        selected(),
      );
      if (disposed) return;
      const succeeded = new Set(
        result.filter((entry) => !entry.error).map((entry) => entry.id),
      );
      setSources((sources) =>
        sources.map((source) => ({
          ...source,
          candidates: source.candidates.filter(
            (candidate) => !candidate.id || !succeeded.has(candidate.id),
          ),
        })),
      );
      const failures = result.filter((entry) => entry.error);
      if (failures.length)
        setError(
          failures.map((entry) => `${entry.name}: ${entry.error}`).join("\n"),
        );
      else {
        setDone(true);
        setSources([]);
      }
    } catch {
      if (!disposed) setError(t("mcps.importFailed"));
    } finally {
      if (!disposed) setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.onClose();
      }}
    >
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("mcps.importTitle")}</DialogTitle>
          <DialogDescription>{t("mcps.importHelp")}</DialogDescription>
        </DialogHeader>
        <div class="max-h-[65vh] space-y-4 overflow-y-auto p-1">
          <label class="block space-y-1 text-sm">
            {t("skills.scope")}
            <select
              class={inputClass}
              value={folder()}
              disabled={busy()}
              onChange={(event) => setFolder(event.currentTarget.value)}
            >
              <option value="">{t("skills.global")}</option>
              <For each={props.projects}>
                {(project) => (
                  <option value={project.folder}>
                    {project.name} · {project.folder}
                  </option>
                )}
              </For>
            </select>
          </label>
          <Button
            variant="outline"
            disabled={busy()}
            onClick={() => void review(discoverMcps)}
          >
            {t("mcps.discover")}
          </Button>
          <label class="block space-y-1 text-sm">
            {t("mcps.importFormat")}
            <select
              class={inputClass}
              value={format()}
              disabled={busy()}
              onChange={(event) =>
                setFormat(event.currentTarget.value as ImportFormat)
              }
            >
              <option value="json">mcpServers JSON</option>
              <option value="jsonc">mcpServers JSONC</option>
              <option value="codex">Codex TOML</option>
              <option value="zed">Zed JSONC</option>
            </select>
          </label>
          <Button
            variant="outline"
            disabled={busy()}
            onClick={() =>
              void review(async () => {
                const value = await selectMcpImport(format());
                return value ? [value] : [];
              })
            }
          >
            {t("mcps.selectFile")}
          </Button>
          <label class="block space-y-1 text-sm">
            {t("mcps.pasteJson")}
            <textarea
              class={inputClass}
              autocomplete="off"
              spellcheck={false}
              value={text()}
              disabled={busy()}
              onInput={(event) => setText(event.currentTarget.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy() || !text().trim()}
            onClick={() => {
              const value = text();
              setText("");
              void review(async () => [
                await previewMcpImport(value, format()),
              ]);
            }}
          >
            {t("mcps.review")}
          </Button>
          <For each={sources()}>
            {(source) => (
              <section class="space-y-2 rounded-lg border border-line p-3">
                <h3 class="font-medium">{source.tool}</h3>
                <p class="break-all text-xs text-muted-foreground">
                  {source.path}
                </p>
                <Show when={source.error}>
                  <p class="text-sm text-muted-foreground">{source.error}</p>
                </Show>
                <Show
                  when={
                    source.status === "ready" && source.candidates.length === 0
                  }
                >
                  <p class="text-sm text-muted-foreground">
                    {t("mcps.noDiscovered")}
                  </p>
                </Show>
                <For each={source.candidates}>
                  {(candidate) => (
                    <div class="space-y-2 border-t border-line pt-2">
                      <label class="flex gap-2 text-sm">
                        <input
                          type="checkbox"
                          disabled={busy() || !candidate.id}
                          checked={
                            candidate.id
                              ? choices[candidate.id]?.selected
                              : false
                          }
                          onChange={(event) => {
                            if (candidate.id)
                              setChoices(
                                candidate.id,
                                "selected",
                                event.currentTarget.checked,
                              );
                          }}
                        />
                        {candidate.name} ·{" "}
                        {candidate.transport ?? t("mcps.unsupported")}
                      </label>
                      <Show when={candidate.reason}>
                        <p class="text-sm text-danger">{candidate.reason}</p>
                      </Show>
                      <Show
                        when={candidate.id && choices[candidate.id]?.selected}
                      >
                        <label class="block space-y-1 text-sm">
                          {t("mcps.importName")}
                          <input
                            class={inputClass}
                            value={
                              candidate.id ? choices[candidate.id]?.name : ""
                            }
                            disabled={busy()}
                            onInput={(event) => {
                              if (candidate.id)
                                setChoices(
                                  candidate.id,
                                  "name",
                                  event.currentTarget.value,
                                );
                            }}
                          />
                        </label>
                        <Show
                          when={
                            candidate.id &&
                            names().includes(choices[candidate.id]?.name)
                          }
                        >
                          <p class="text-sm text-danger">
                            {t("mcps.conflict")}
                          </p>
                        </Show>
                        <label class="flex gap-2 text-sm">
                          <input
                            type="checkbox"
                            disabled={busy()}
                            checked={
                              candidate.id
                                ? choices[candidate.id]?.overwrite
                                : false
                            }
                            onChange={(event) => {
                              if (candidate.id)
                                setChoices(
                                  candidate.id,
                                  "overwrite",
                                  event.currentTarget.checked,
                                );
                            }}
                          />
                          {t("mcps.overwrite")}
                        </label>
                      </Show>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
          <Show when={done()}>
            <p role="status" class="text-sm">
              {t("mcps.importDone")}
            </p>
          </Show>
          <Show when={error()}>
            <p role="alert" class="whitespace-pre-wrap text-sm text-danger">
              {error()}
            </p>
          </Show>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={
              busy() ||
              scopeError() ||
              selected().length === 0 ||
              selected().some(
                (choice) =>
                  !choice.name.trim() ||
                  (names().includes(choice.name) && !choice.overwrite),
              )
            }
            onClick={() => void save()}
          >
            {t("mcps.importSelected")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
