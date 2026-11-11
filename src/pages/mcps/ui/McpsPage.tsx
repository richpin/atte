import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "shared/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { removeMcp, saveMcp, subscribeMcp, toggleMcp } from "../api/mcps";
import type { Server, Snapshot, Target } from "../model/types";
import { ConnectionCheck } from "./ConnectionCheck";
import { ImportDialog } from "./ImportDialog";
import { ServerDialog } from "./ServerDialog";

export function McpsPage(props: {
  active: boolean;
  projects: { folder: string; name: string }[];
}) {
  const { t } = useI18n();
  const [folder, setFolder] = createSignal("");
  const [search, setSearch] = createSignal("");
  const [snapshot, setSnapshot] = createSignal<Snapshot>();
  const [error, setError] = createSignal<string>();
  const [revision, setRevision] = createSignal(0);
  const [editor, setEditor] = createSignal<{
    name?: string;
    server?: Server;
    target: Target;
  }>();
  const [removing, setRemoving] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const target = (): Target =>
    folder() ? { scope: "project", folder: folder() } : { scope: "global" };
  createEffect(() => {
    if (
      folder() &&
      !props.projects.some((project) => project.folder === folder())
    )
      setFolder("");
  });
  createEffect(() => {
    revision();
    const selected = target();
    if (!props.active) return;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    setSnapshot(undefined);
    setError(undefined);
    void subscribeMcp(selected, (value) => {
      if (!stopped) {
        setSnapshot(value);
        setError(undefined);
      }
    })
      .then((stop) => {
        if (stopped) stop();
        else unsubscribe = stop;
      })
      .catch((error) => {
        if (!stopped) setError(String(error));
      });
    onCleanup(() => {
      stopped = true;
      unsubscribe?.();
    });
  });
  const entries = () =>
    Object.entries(snapshot()?.servers ?? {}).filter(([name]) =>
      name.toLocaleLowerCase().includes(search().trim().toLocaleLowerCase()),
    );
  async function toggle(name: string, enabled: boolean) {
    setBusy(true);
    try {
      await toggleMcp(target(), name, enabled);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const name = removing();
    if (!name || busy()) return;
    setBusy(true);
    try {
      await removeMcp(target(), name);
      setRemoving(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="h-full overflow-y-auto px-6 pb-12">
      <div class="@container mx-auto max-w-4xl space-y-6 pt-6">
        <div class="flex items-start justify-between gap-4">
          <p class="text-sm text-muted-foreground">{t("mcps.description")}</p>
          <Button variant="outline" onClick={() => setImporting(true)}>
            {t("mcps.importTitle")}
          </Button>
          <Button
            disabled={!snapshot() || Boolean(snapshot()?.error) || busy()}
            onClick={() => setEditor({ target: target() })}
          >
            {t("mcps.add")}
          </Button>
        </div>
        <label class="block space-y-1 text-sm">
          {t("skills.scope")}
          <select
            class="rounded-md border border-input bg-background px-3 py-2"
            value={folder()}
            disabled={busy() || Boolean(editor())}
            onChange={(event) => {
              setFolder(event.currentTarget.value);
              setRemoving(undefined);
            }}
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
        <Show when={snapshot()?.path}>
          {(path) => (
            <p class="break-all font-mono text-xs text-muted-foreground">
              {path()}
            </p>
          )}
        </Show>
        <label class="block space-y-1 text-sm">
          {t("mcps.search")}
          <input
            class="w-full rounded-md border border-input bg-background px-3 py-2"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
          />
        </label>
        <Show when={error() || snapshot()?.error}>
          {(value) => (
            <div role="alert" class="space-y-2 text-sm text-danger">
              <p>{value()}</p>
              <Button
                variant="outline"
                onClick={() => setRevision((value) => value + 1)}
              >
                {t("common.retry")}
              </Button>
            </div>
          )}
        </Show>
        <For each={snapshot()?.issues}>
          {(issue) => (
            <p role="alert" class="text-sm text-danger">
              {issue.name}: {issue.reason}
            </p>
          )}
        </For>
        <Show when={snapshot() && entries().length === 0}>
          <p class="text-sm text-muted-foreground">{t("mcps.empty")}</p>
        </Show>
        <ul class="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2">
          <For each={entries()}>
            {([name, server]) => (
              <li class="space-y-3 rounded-xl border border-line p-4">
                <div class="flex items-center justify-between gap-3">
                  <h2 class="truncate font-medium">{name}</h2>
                  <Switch
                    checked={server.enabled}
                    disabled={busy() || Boolean(snapshot()?.error)}
                    onChange={(value) => void toggle(name, value)}
                  >
                    <SwitchLabel class="sr-only">
                      {t("mcps.enable")} {name}
                    </SwitchLabel>
                    <SwitchControl>
                      <SwitchThumb />
                    </SwitchControl>
                  </Switch>
                </div>
                <p class="break-all font-mono text-xs text-muted-foreground">
                  {server.type === "stdio" ? server.command : server.url}
                </p>
                <p class="text-xs text-muted-foreground">
                  {server.type === "stdio" ? "stdio" : "Streamable HTTP"} ·{" "}
                  {t("mcps.registered")}
                </p>
                <div class="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy()}
                    onClick={() =>
                      setEditor({ name, server, target: target() })
                    }
                  >
                    {t("mcps.details")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy()}
                    onClick={() => setRemoving(name)}
                  >
                    {t("common.delete")}
                  </Button>
                </div>
                <ConnectionCheck
                  target={target()}
                  name={name}
                  server={server}
                  active={props.active}
                  disabled={busy() || Boolean(snapshot()?.error)}
                />
              </li>
            )}
          </For>
        </ul>
        <p class="text-sm text-muted-foreground">{t("mcps.forwardingHelp")}</p>
        <Show when={props.active && importing()}>
          <ImportDialog
            target={target()}
            projects={props.projects}
            onClose={() => setImporting(false)}
          />
        </Show>
        <Show when={props.active ? editor() : undefined} keyed>
          {(selected) => (
            <ServerDialog
              {...selected}
              onClose={() => setEditor(undefined)}
              onSave={(name, server, secrets) =>
                saveMcp(selected.target, name, server, secrets, !selected.name)
              }
            />
          )}
        </Show>
        <Dialog
          open={props.active && Boolean(removing())}
          onOpenChange={(open) => {
            if (!open && !busy()) setRemoving(undefined);
          }}
        >
          <DialogContent role="alertdialog">
            <DialogHeader>
              <DialogTitle>{t("mcps.deleteTitle")}</DialogTitle>
              <DialogDescription>{removing()}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy()}
                onClick={() => setRemoving(undefined)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy()}
                onClick={() => void remove()}
              >
                {t("common.delete")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
