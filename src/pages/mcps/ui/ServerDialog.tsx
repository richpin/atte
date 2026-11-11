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

const inputClass =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function ServerDialog(props: {
  name?: string;
  server?: Server;
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
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {props.name ? t("mcps.edit") : t("mcps.add")}
          </DialogTitle>
          <DialogDescription>{t("mcps.secretHelp")}</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <label class="block space-y-1 text-sm">
            {t("mcps.name")}
            <input
              class={inputClass}
              value={name()}
              disabled={busy() || Boolean(props.name)}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label class="block space-y-1 text-sm">
            {t("mcps.transport")}
            <select
              class={inputClass}
              value={type()}
              disabled={busy()}
              onChange={(event) => {
                setType(event.currentTarget.value as "stdio" | "http");
                setEndpoint("");
                setForm("rows", []);
              }}
            >
              <option value="stdio">stdio</option>
              <option value="http">Streamable HTTP</option>
            </select>
          </label>
          <label class="block space-y-1 text-sm">
            {type() === "stdio" ? t("mcps.command") : t("mcps.url")}
            <input
              class={inputClass}
              value={endpoint()}
              disabled={busy()}
              onInput={(event) => setEndpoint(event.currentTarget.value)}
            />
          </label>
          <Show when={type() === "http"}>
            <label class="block space-y-1 text-sm">
              {t("mcps.authentication")}
              <select
                class={inputClass}
                value={oauth() ? "oauth" : "headers"}
                disabled={busy()}
                onChange={(event) =>
                  setOauth(event.currentTarget.value === "oauth")
                }
              >
                <option value="headers">
                  {t("mcps.headerAuthentication")}
                </option>
                <option value="oauth">OAuth</option>
              </select>
            </label>
            <Show when={oauth()}>
              <label class="block space-y-1 text-sm">
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
            <label class="block space-y-1 text-sm">
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
            <legend class="text-sm font-medium">
              {type() === "stdio" ? t("mcps.env") : t("mcps.headers")}
            </legend>
            <For each={form.rows}>
              {(row, index) => (
                <div class="space-y-2 rounded-lg border border-line p-3">
                  <div class="flex gap-2">
                    <label class="min-w-0 flex-1 text-sm">
                      {t("mcps.name")}
                      <input
                        class={inputClass}
                        value={row.name}
                        onInput={(event) =>
                          updateRow(index(), {
                            name: event.currentTarget.value,
                          })
                        }
                      />
                    </label>
                    <label class="text-sm">
                      {t("mcps.valueType")}
                      <select
                        class={inputClass}
                        value={row.source.kind}
                        onChange={(event) =>
                          updateRow(index(), {
                            source: {
                              kind: event.currentTarget
                                .value as ValueRow["source"]["kind"],
                              value: "",
                            },
                            replacement:
                              event.currentTarget.value === "secret"
                                ? ""
                                : undefined,
                          })
                        }
                      >
                        <option value="literal">{t("mcps.literal")}</option>
                        <option value="environment">
                          {t("mcps.environment")}
                        </option>
                        <option value="secret">{t("mcps.secret")}</option>
                      </select>
                    </label>
                  </div>
                  <label class="block text-sm">
                    {row.source.kind === "secret"
                      ? t("mcps.secretValue")
                      : row.source.kind === "environment"
                        ? t("mcps.environmentName")
                        : t("mcps.value")}
                    <input
                      class={inputClass}
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
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm("rows", (rows) =>
                        rows.filter((_, position) => position !== index()),
                      )
                    }
                  >
                    {t("common.delete")}
                  </Button>
                </div>
              )}
            </For>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setForm("rows", (rows) => [
                  ...rows,
                  { name: "", source: { kind: "literal", value: "" } },
                ])
              }
            >
              {t("mcps.addValue")}
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
        <DialogFooter>
          <Button variant="outline" disabled={busy()} onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={busy() || !name().trim() || !endpoint().trim()}
            onClick={() => void save()}
          >
            {t("mcps.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
