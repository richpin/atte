import { Plus, Trash } from "lucide-solid";
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
import { createSignal, For, Show } from "solid-js";
import { createStore } from "solid-js/store";
import type { Server, ValueRow } from "../model/types";
import { SelectField } from "./SelectField";

const inputClass =
  "w-full rounded-xl border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ServerDialog(props: {
  name?: string;
  server?: Server;
  onSignOut?: () => Promise<void>;
  onRemove?: () => void;
  onClose: () => void;
  onSave: (
    name: string,
    server: Server,
    secrets: Record<string, string>,
  ) => Promise<void>;
}) {
  const { t } = useI18n();
  const initial = props.server;
  const [name, setName] = createSignal(props.name ?? "");
  const [type, setType] = createSignal<"stdio" | "http">(
    initial?.type ?? "stdio",
  );
  const [endpoint, setEndpoint] = createSignal(
    initial?.type === "stdio" ? initial.command : (initial?.url ?? ""),
  );
  const [args, setArgs] = createSignal(
    initial?.type === "stdio" ? JSON.stringify(initial.args) : "[]",
  );
  const [form, setForm] = createStore<{ rows: ValueRow[] }>({
    rows: Object.entries(
      initial?.type === "stdio" ? initial.env : (initial?.headers ?? {}),
    ).map(([name, source]) => ({ name, source })),
  });
  const [oauth, setOauth] = createSignal(
    initial?.type === "http" && Boolean(initial.oauth),
  );
  const [clientId, setClientId] = createSignal(
    initial?.type === "http" ? (initial.oauth?.clientId ?? "") : "",
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  function updateRow(index: number, change: Partial<ValueRow>) {
    setForm("rows", index, change);
  }

  async function save() {
    if (busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const argumentsValue: unknown =
        type() === "stdio" ? JSON.parse(args()) : [];
      if (
        !Array.isArray(argumentsValue) ||
        argumentsValue.some((arg) => typeof arg !== "string")
      )
        throw new Error(t("mcps.invalidArgs"));
      const values: Record<string, ValueRow["source"]> = Object.create(null);
      const secrets: Record<string, string> = Object.create(null);
      for (const row of form.rows) {
        if (!row.name.trim() || Object.hasOwn(values, row.name))
          throw new Error(t("mcps.invalidNames"));
        values[row.name] = row.source;
        if (row.source.kind === "secret" && row.replacement !== undefined)
          secrets[row.name] = row.replacement;
      }
      const server: Server =
        type() === "stdio"
          ? {
              type: "stdio",
              enabled: initial?.enabled ?? true,
              command: endpoint().trim(),
              args: argumentsValue,
              env: values,
            }
          : {
              type: "http",
              enabled: initial?.enabled ?? true,
              url: endpoint().trim(),
              headers: values,
              ...(oauth()
                ? {
                    oauth: clientId().trim()
                      ? { clientId: clientId().trim() }
                      : {},
                  }
                : {}),
            };
      await props.onSave(name().trim(), server, secrets);
      props.onClose();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy()) props.onClose();
      }}
    >
      <DialogContent class="flex max-h-[min(47rem,calc(100dvh-2rem))] w-[calc(100%-2rem)] max-w-2xl flex-col gap-6 overflow-hidden">
        <DialogHeader class="space-y-3 shrink-0">
          <DialogTitle>
            {props.name ? t("mcps.edit") : t("mcps.add")}
          </DialogTitle>
          <DialogDescription>{t("mcps.secretHelp")}</DialogDescription>
        </DialogHeader>
        <div class="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto p-1">
          <label class="flex min-w-0 flex-col gap-2 text-sm">
            {t("mcps.name")}
            <input
              class={inputClass}
              value={name()}
              disabled={busy() || Boolean(props.name)}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <SelectField
            label={t("mcps.transport")}
            options={["stdio", "http"]}
            value={type()}
            disabled={busy()}
            labelFor={(value) =>
              value === "stdio" ? "stdio" : "Streamable HTTP"
            }
            onChange={(value) => {
              setType(value);
              setEndpoint("");
              setForm("rows", []);
            }}
          />
          <label class="flex min-w-0 flex-col gap-2 text-sm">
            {type() === "stdio" ? t("mcps.command") : t("mcps.url")}
            <input
              class={inputClass}
              value={endpoint()}
              disabled={busy()}
              onInput={(event) => setEndpoint(event.currentTarget.value)}
            />
          </label>
          <Show when={type() === "http"}>
            <SelectField
              label={t("mcps.authentication")}
              options={["headers", "oauth"]}
              value={oauth() ? "oauth" : "headers"}
              disabled={busy()}
              labelFor={(value) =>
                value === "oauth" ? "OAuth" : t("mcps.headerAuthentication")
              }
              onChange={(value) => setOauth(value === "oauth")}
            />
            <Show when={oauth()}>
              <label class="flex min-w-0 flex-col gap-2 text-sm">
                {t("mcps.clientId")}
                <input
                  class={inputClass}
                  value={clientId()}
                  disabled={busy()}
                  onInput={(event) => setClientId(event.currentTarget.value)}
                />
                <span class="text-xs text-muted-foreground">
                  {t("mcps.clientIdHelp")}
                </span>
              </label>
            </Show>
          </Show>
          <Show when={type() === "stdio"}>
            <label class="flex min-w-0 flex-col gap-2 text-sm">
              {t("mcps.args")}
              <textarea
                class={inputClass}
                value={args()}
                disabled={busy()}
                onInput={(event) => setArgs(event.currentTarget.value)}
              />
            </label>
          </Show>
          <fieldset class="space-y-3" disabled={busy()}>
            <legend class="mb-2 text-sm font-medium">
              {type() === "stdio" ? t("mcps.env") : t("mcps.headers")}
            </legend>
            <For each={form.rows}>
              {(row, index) => (
                <div class="relative space-y-3 rounded-lg border border-line p-3">
                  <Button
                    size="icon"
                    variant="ghost"
                    class="absolute right-2 top-2 size-7 text-muted-foreground hover:text-danger"
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    onClick={() =>
                      setForm("rows", (rows) =>
                        rows.filter((_, position) => position !== index()),
                      )
                    }
                  >
                    <Trash aria-hidden="true" class="size-4" />
                  </Button>
                  <div class="grid grid-cols-1 gap-3 pr-8 sm:grid-cols-2">
                    <label class="flex min-w-0 flex-col gap-2 text-sm">
                      {t("mcps.name")}
                      <input
                        class={`${inputClass} h-11`}
                        value={row.name}
                        onInput={(event) =>
                          updateRow(index(), {
                            name: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <SelectField
                      label={t("mcps.valueType")}
                      options={["literal", "environment", "secret"]}
                      value={row.source.kind}
                      disabled={busy()}
                      labelFor={(value) =>
                        t(
                          value === "literal"
                            ? "mcps.literal"
                            : value === "environment"
                              ? "mcps.environment"
                              : "mcps.secret",
                        )
                      }
                      onChange={(kind) =>
                        updateRow(index(), {
                          source: { kind, value: "" },
                          replacement: kind === "secret" ? "" : undefined,
                        })
                      }
                    />
                  </div>
                  <label class="flex min-w-0 flex-col gap-2 text-sm">
                    {row.source.kind === "secret"
                      ? t("mcps.secretValue")
                      : row.source.kind === "environment"
                        ? t("mcps.environmentName")
                        : t("mcps.value")}
                    <input
                      class={`${inputClass} h-11`}
                      type={row.source.kind === "secret" ? "password" : "text"}
                      autocomplete="off"
                      value={
                        row.source.kind === "secret"
                          ? (row.replacement ?? "")
                          : row.source.value
                      }
                      placeholder={
                        row.source.kind === "secret" && row.source.value
                          ? t("mcps.keepSecret")
                          : ""
                      }
                      onInput={(event) =>
                        row.source.kind === "secret"
                          ? updateRow(index(), {
                              replacement:
                                event.currentTarget.value ||
                                (row.source.value ? undefined : ""),
                            })
                          : updateRow(index(), {
                              source: {
                                ...row.source,
                                value: event.currentTarget.value,
                              },
                            })
                      }
                    />
                  </label>
                </div>
              )}
            </For>
            <Button
              size="icon"
              variant="outline"
              class="size-8"
              aria-label={t("mcps.addValue")}
              title={t("mcps.addValue")}
              onClick={() =>
                setForm("rows", (rows) => [
                  ...rows,
                  { name: "", source: { kind: "literal", value: "" } },
                ])
              }
            >
              <Plus aria-hidden="true" class="size-4" />
            </Button>
          </fieldset>
          <Show when={error()}>
            {(value) => (
              <p role="alert" class="text-sm text-danger">
                {value()}
              </p>
            )}
          </Show>
        </div>
        <DialogFooter class="shrink-0 flex-row flex-wrap items-center gap-2 space-x-0">
          <div class="mr-auto flex items-center gap-2">
            <Show when={props.onRemove}>
              <Button
                variant="ghost"
                disabled={busy()}
                class="bg-danger-soft text-danger hover:bg-danger/15"
                onClick={() => props.onRemove?.()}
              >
                {t("mcps.uninstall")}
              </Button>
            </Show>
            <Show when={props.onSignOut}>
              <Button
                variant="outline"
                disabled={busy()}
                onClick={async () => {
                  setBusy(true);
                  setError(undefined);
                  try {
                    await props.onSignOut?.();
                  } catch (error) {
                    setError(String(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("mcps.logout")}
              </Button>
            </Show>
          </div>
          <div class="ml-auto flex items-center gap-2">
            <Button variant="outline" disabled={busy()} onClick={props.onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={busy() || !name().trim() || !endpoint().trim()}
              onClick={() => void save()}
            >
              {t("mcps.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
