import { useQueryClient } from "@tanstack/solid-query";
import { Download, Plus, RefreshCw, X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ScopeSelector,
  SearchInput,
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "shared/ui";
import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import {
  cancelMcpCheck,
  cancelMcpLogin,
  checkMcp,
  loginMcp,
  logoutMcp,
  removeMcp,
  saveMcp,
  subscribeMcp,
  toggleMcp,
} from "../api/mcps";
import type { CheckResult, Server, Snapshot, Target } from "../model/types";
import { ImportDialog } from "./ImportDialog";
import { ServerDialog } from "./ServerDialog";
import { ToolsList } from "./ToolsList";

const hasOAuth = (server: Server | undefined) =>
  server?.type === "http" && Boolean(server.oauth);
const serverConfiguration = (server: Server) =>
  JSON.stringify({ ...server, enabled: undefined });

type ToolChecks = Record<
  string,
  { server: string; result: CheckResult | undefined; error?: string }
>;
const toolsKey = (target: Target) => ["mcp-tools", target] as const;

export function McpsPage(props: {
  active: boolean;
  projects: { folder: string; name: string }[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  queryClient.setQueryDefaults(["mcp-tools"], { gcTime: Infinity });
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
  const [checking, setChecking] = createSignal<Record<string, string>>({});
  const [checks, setChecks] = createSignal<ToolChecks>({});
  const [signingIn, setSigningIn] = createSignal<Record<string, string>>({});
  const runningConfigurations = new Map<string, string>();
  const interactiveChecks = new Set<string>();
  function storeCheck(
    selected: Target,
    name: string,
    server: Server,
    result: CheckResult | undefined,
    error?: string,
  ) {
    const updated = queryClient.setQueryData<ToolChecks>(
      toolsKey(selected),
      (current) => ({
        ...current,
        [name]: { server: serverConfiguration(server), result, error },
      }),
    );
    setChecks(updated ?? {});
  }
  const checkResult = (name: string, server: Server) => {
    const checked = checks()[name];
    return checked?.server === serverConfiguration(server)
      ? checked.result
      : undefined;
  };
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
    const attempted = new Map<string, string>();
    let unsubscribe: (() => void) | undefined;
    setSnapshot(undefined);
    setChecks({});
    setError(undefined);
    void subscribeMcp(selected, (value) =>
      untrack(() => {
        if (!stopped) {
          const cached =
            queryClient.getQueryData<ToolChecks>(toolsKey(selected)) ?? {};
          const valid = Object.fromEntries(
            Object.entries(cached).filter(
              ([name, checked]) =>
                value.servers[name] &&
                checked.server === serverConfiguration(value.servers[name]),
            ),
          );
          queryClient.setQueryData(toolsKey(selected), valid);
          setChecks(valid);
          setSnapshot(value);
          setError(undefined);
          for (const [name, id] of Object.entries(checking())) {
            const server = value.servers[name];
            if (
              !server ||
              runningConfigurations.get(name) !== serverConfiguration(server)
            ) {
              cancelCheck(selected, name, id);
              runningConfigurations.delete(name);
              setChecking((current) => {
                const next = { ...current };
                delete next[name];
                return next;
              });
            }
          }
          for (const name of attempted.keys()) {
            if (!value.servers[name]) attempted.delete(name);
          }
          if (!value.error) {
            for (const [name, server] of Object.entries(value.servers)) {
              const configuration = serverConfiguration(server);
              const result = valid[name]?.result;
              const cachedTools =
                result?.status === "connected" || result?.status === "noTools";
              if (cachedTools) attempted.set(name, configuration);
              if (
                !cachedTools &&
                !checking()[name] &&
                attempted.get(name) !== configuration
              ) {
                attempted.set(name, configuration);
                void refreshTools(selected, name, server);
              }
            }
          }
        }
      }),
    )
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
      for (const [name, id] of Object.entries(checking())) {
        cancelCheck(selected, name, id);
      }
      setSigningIn({});
      setChecking({});
      runningConfigurations.clear();
      interactiveChecks.clear();
    });
  });
  function cancelCheck(selected: Target, name: string, id: string) {
    interactiveChecks.delete(id);
    void cancelMcpCheck(id).catch(() => {});
    if (signingIn()[name] === id) {
      void cancelMcpLogin(selected, name).catch(() => {});
      setSigningIn((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
  }
  function stopCheck(selected: Target, name: string, server: Server) {
    const id = checking()[name];
    if (!id) return;
    cancelCheck(selected, name, id);
    runningConfigurations.delete(name);
    setChecking((current) => {
      const next = { ...current };
      delete next[name];
      return next;
    });
    storeCheck(selected, name, server, { status: "cancelled", tools: [] });
  }
  async function refreshTools(
    selected: Target,
    name: string,
    server: Server,
    interactive = false,
  ) {
    const previous = checking()[name];
    const configuration = serverConfiguration(server);
    if (previous && runningConfigurations.get(name) === configuration) {
      if (interactive) interactiveChecks.add(previous);
      return;
    }
    if (previous) cancelCheck(selected, name, previous);
    runningConfigurations.set(name, configuration);
    const id = crypto.randomUUID();
    if (interactive) interactiveChecks.add(id);
    setChecking((current) => ({ ...current, [name]: id }));
    storeCheck(selected, name, server, undefined);
    try {
      let result = await checkMcp(selected, name, id);
      if (checking()[name] !== id) return;
      if (
        result.status === "authenticationRequired" &&
        hasOAuth(server) &&
        interactiveChecks.has(id)
      ) {
        setSigningIn((current) => ({ ...current, [name]: id }));
        await loginMcp(selected, name);
        if (checking()[name] !== id) return;
        setSigningIn((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        result = await checkMcp(selected, name, id);
      }
      if (checking()[name] === id) {
        storeCheck(selected, name, server, result);
      }
    } catch (error) {
      if (checking()[name] === id)
        storeCheck(
          selected,
          name,
          server,
          undefined,
          signingIn()[name] === id ? String(error) : t("mcps.checkFailed"),
        );
    } finally {
      interactiveChecks.delete(id);
      if (checking()[name] === id) {
        setSigningIn((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
        runningConfigurations.delete(name);
        setChecking((current) => {
          const next = { ...current };
          delete next[name];
          return next;
        });
      }
    }
  }
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
      setEditor(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="h-full overflow-y-auto px-6 pb-12">
      <div class="@container mx-auto max-w-4xl space-y-6 pt-6">
        <p class="text-sm text-muted-foreground">{t("mcps.description")}</p>
        <div class="flex flex-wrap items-center gap-2">
          <ScopeSelector
            projects={props.projects}
            folder={folder()}
            disabled={busy() || Boolean(editor())}
            onChange={(value) => {
              setFolder(value);
              setRemoving(undefined);
            }}
          />
          <div class="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImporting(true)}
            >
              <Download aria-hidden="true" class="size-4" />
              {t("mcps.importTitle")}
            </Button>
            <Button
              size="sm"
              disabled={!snapshot() || Boolean(snapshot()?.error) || busy()}
              onClick={() => setEditor({ target: target() })}
            >
              <Plus aria-hidden="true" class="size-4" />
              {t("mcps.add")}
            </Button>
          </div>
        </div>
        <SearchInput
          label={t("mcps.search")}
          value={search()}
          onInput={setSearch}
        />
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
        <ul class="grid grid-cols-1 gap-4">
          <For each={entries()}>
            {([name, server]) => (
              <li class="relative min-w-0 rounded-2xl border border-line bg-input-surface p-5 transition-colors hover:bg-panel">
                <button
                  type="button"
                  aria-label={name}
                  disabled={busy()}
                  class="absolute inset-0 rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
                  onClick={() => setEditor({ name, server, target: target() })}
                />
                <div class="pointer-events-none relative space-y-3">
                  <div class="flex items-center justify-between gap-3">
                    <h2 class="min-w-0 break-words text-lg font-semibold">
                      {name}
                    </h2>
                    <div class="pointer-events-auto flex shrink-0 items-center gap-2">
                      <Button
                        size="icon"
                        variant="ghost"
                        class="size-7 text-muted-foreground hover:text-foreground"
                        aria-label={`${checking()[name] ? t("mcps.cancelCheck") : t("mcps.check")} ${name}`}
                        title={
                          checking()[name]
                            ? t("mcps.cancelCheck")
                            : t("mcps.check")
                        }
                        disabled={busy() || Boolean(snapshot()?.error)}
                        onClick={() =>
                          checking()[name]
                            ? stopCheck(target(), name, server)
                            : void refreshTools(target(), name, server, true)
                        }
                      >
                        <Show
                          when={checking()[name]}
                          fallback={
                            <RefreshCw aria-hidden="true" class="size-4" />
                          }
                        >
                          <X aria-hidden="true" class="size-4" />
                        </Show>
                      </Button>
                      <Switch
                        class="flex items-center"
                        checked={server.enabled}
                        disabled={busy() || Boolean(snapshot()?.error)}
                        onChange={(value) => void toggle(name, value)}
                      >
                        <SwitchLabel class="sr-only">
                          {t("mcps.enable")} {name}
                        </SwitchLabel>
                        <SwitchControl class="h-5 w-9 data-[checked]:bg-switch-on">
                          <SwitchThumb class="size-4 bg-white data-[checked]:translate-x-4" />
                        </SwitchControl>
                      </Switch>
                    </div>
                  </div>
                  <ToolsList
                    result={checkResult(name, server)}
                    checking={Boolean(checking()[name])}
                    signingIn={Boolean(signingIn()[name])}
                    error={checks()[name]?.error}
                  />
                  <p class="break-all font-mono text-xs text-muted-foreground">
                    {server.type === "stdio"
                      ? [server.command, ...server.args].join(" ")
                      : server.url}
                  </p>
                </div>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.active && importing()}>
          <ImportDialog target={target()} onClose={() => setImporting(false)} />
        </Show>
        <Show when={props.active ? editor() : undefined} keyed>
          {(selected) => (
            <ServerDialog
              {...selected}
              onClose={() => {
                if (!removing()) setEditor(undefined);
              }}
              onRemove={
                selected.name ? () => setRemoving(selected.name) : undefined
              }
              onSave={async (name, server, secrets) => {
                await saveMcp(
                  selected.target,
                  name,
                  server,
                  secrets,
                  !selected.name,
                );
                if (
                  props.active &&
                  JSON.stringify(selected.target) === JSON.stringify(target())
                ) {
                  void refreshTools(
                    selected.target,
                    name,
                    snapshot()?.servers[name] ?? server,
                    true,
                  );
                }
              }}
              onSignOut={
                selected.name &&
                hasOAuth(
                  snapshot()?.servers[selected.name] ?? selected.server,
                ) &&
                ["authorized", "reauthorizationRequired"].includes(
                  snapshot()?.authentication?.[selected.name] ?? "required",
                )
                  ? async () => {
                      const name = selected.name;
                      if (!name) return;
                      const server =
                        snapshot()?.servers[name] ?? selected.server;
                      if (!server) return;
                      const id = checking()[name];
                      if (id) stopCheck(selected.target, name, server);
                      await logoutMcp(selected.target, name);
                      storeCheck(selected.target, name, server, {
                        status: "authenticationRequired",
                        tools: [],
                      });
                    }
                  : undefined
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
              <Show when={error()}>
                {(value) => (
                  <p role="alert" class="text-sm text-danger">
                    {value()}
                  </p>
                )}
              </Show>
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
