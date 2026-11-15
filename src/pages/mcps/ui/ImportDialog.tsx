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
import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import {
  clearMcpImports,
  importMcps,
  previewMcpImport,
  selectMcpImport,
  subscribeMcp,
} from "../api/mcps";
import type { ImportFormat, ImportSelection, Target } from "../model/types";
import { SelectField } from "./SelectField";

export function ImportDialog(props: { target: Target; onClose: () => void }) {
  const { t } = useI18n();
  const configurationId = createUniqueId();
  const errorId = createUniqueId();
  const [format, setFormat] = createSignal<ImportFormat>("json");
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const [names, setNames] = createSignal<string[]>([]);
  const [scopeError, setScopeError] = createSignal(true);
  let pending: ImportSelection[] | undefined;
  let disposed = false;

  createEffect(() => {
    const target = props.target;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    pending = undefined;
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
  onCleanup(() => {
    disposed = true;
    void clearMcpImports().catch(() => {});
  });

  function reset() {
    pending = undefined;
    setError(undefined);
  }

  async function choose() {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const contents = await selectMcpImport();
      if (!disposed && contents !== null) {
        reset();
        setText(contents);
      }
    } catch {
      if (!disposed) setError(t("mcps.fileFailed"));
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function save() {
    if (busy() || scopeError() || !text().trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      if (!pending) {
        await clearMcpImports();
        if (disposed) return;
        const source = await previewMcpImport(text(), format());
        if (disposed) {
          await clearMcpImports();
          return;
        }
        const errors = source.candidates.flatMap((candidate) =>
          candidate.reason || !candidate.id
            ? [
                `${candidate.name}: ${candidate.reason ?? t("mcps.unsupported")}`,
              ]
            : [],
        );
        if (source.status !== "ready" || source.error) {
          setError(source.error ?? t("mcps.reviewFailed"));
          return;
        }
        if (errors.length) {
          setError(errors.join("\n"));
          return;
        }
        if (!source.candidates.length) {
          setError(t("mcps.noDiscovered"));
          return;
        }
        pending = source.candidates.flatMap((candidate) =>
          candidate.id
            ? [{ id: candidate.id, name: candidate.name, overwrite: false }]
            : [],
        );
      }
      const conflicts = pending.filter((entry) => names().includes(entry.name));
      if (conflicts.length) {
        setError(
          conflicts
            .map((entry) => `${entry.name}: ${t("mcps.conflict")}`)
            .join("\n"),
        );
        return;
      }
      const result = await importMcps(props.target, pending);
      if (disposed) return;
      const succeeded = new Set(
        result.filter((entry) => !entry.error).map((entry) => entry.id),
      );
      pending = pending.filter((entry) => !succeeded.has(entry.id));
      if (pending.length) {
        const failures = result.filter((entry) => entry.error);
        setError(
          failures.length
            ? failures
                .map((entry) => `${entry.name}: ${entry.error}`)
                .join("\n")
            : t("mcps.importFailed"),
        );
      } else {
        props.onClose();
      }
    } catch {
      if (!disposed) {
        pending = undefined;
        setError(t("mcps.importFailed"));
      }
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
      <DialogContent class="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl flex-col gap-6 overflow-hidden">
        <DialogHeader class="shrink-0 space-y-3">
          <DialogTitle>{t("mcps.importTitle")}</DialogTitle>
          <DialogDescription>{t("mcps.importHelp")}</DialogDescription>
        </DialogHeader>
        <div class="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-1">
          <SelectField<ImportFormat>
            label={t("mcps.importFormat")}
            options={["json", "jsonc", "codex", "zed"]}
            value={format()}
            disabled={busy()}
            labelFor={(value) =>
              ({
                json: "mcpServers JSON",
                jsonc: "mcpServers JSONC",
                codex: "Codex TOML",
                zed: "Zed JSONC",
              })[value]
            }
            onChange={(value) => {
              reset();
              setFormat(value);
            }}
          />
          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex items-center justify-between gap-3">
              <label for={configurationId} class="text-sm">
                {t("mcps.configuration")}
              </label>
              <Button
                size="sm"
                variant="outline"
                disabled={busy()}
                onClick={() => void choose()}
              >
                {t("mcps.choose")}
              </Button>
            </div>
            <textarea
              id={configurationId}
              class="min-h-48 w-full resize-y rounded-xl border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              autocomplete="off"
              spellcheck={false}
              value={text()}
              disabled={busy()}
              aria-invalid={Boolean(error())}
              aria-describedby={error() ? errorId : undefined}
              onInput={(event) => {
                reset();
                setText(event.currentTarget.value);
              }}
            />
          </div>
          <Show when={error()}>
            <p
              id={errorId}
              role="alert"
              class="whitespace-pre-wrap break-words text-sm text-danger"
            >
              {error()}
            </p>
          </Show>
        </div>
        <DialogFooter class="shrink-0">
          <Button variant="outline" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy() || scopeError() || !text().trim()}
            onClick={() => void save()}
          >
            {t("mcps.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
