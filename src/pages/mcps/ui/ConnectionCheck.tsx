import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { cancelMcpCheck, checkMcp } from "../api/mcps";
import type { CheckResult, Server, Target } from "../model/types";

export function ConnectionCheck(props: {
  target: Target;
  name: string;
  server: Server;
  active: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [running, setRunning] = createSignal<string>();
  const [result, setResult] = createSignal<CheckResult>();
  const [error, setError] = createSignal(false);
  createEffect(() => {
    JSON.stringify(props.target);
    JSON.stringify(props.server);
    props.active;
    setResult(undefined);
    setError(false);
    onCleanup(() => {
      const id = running();
      setRunning(undefined);
      if (id) void cancelMcpCheck(id).catch(() => {});
    });
  });
  async function check() {
    const id = crypto.randomUUID();
    setRunning(id);
    setResult(undefined);
    setError(false);
    try {
      const result = await checkMcp(props.target, props.name, id);
      if (running() === id) setResult(result);
    } catch {
      if (running() === id) setError(true);
    } finally {
      if (running() === id) setRunning(undefined);
    }
  }
  return (
    <div class="space-y-2">
      <Show
        when={running()}
        fallback={
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled}
            onClick={() => void check()}
          >
            {t("mcps.check")}
          </Button>
        }
      >
        {(id) => (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void cancelMcpCheck(id()).catch(() => setError(true))
            }
          >
            {t("mcps.cancelCheck")}
          </Button>
        )}
      </Show>
      <Show when={result()}>
        {(result) => (
          <div role="status" class="text-xs text-muted-foreground">
            <p>{t(`mcps.checkStatus.${result().status}`)}</p>
            <ul class="max-h-32 overflow-auto">
              <For each={result().tools}>{(tool) => <li>{tool}</li>}</For>
            </ul>
          </div>
        )}
      </Show>
      <Show when={error()}>
        <p role="alert" class="text-xs text-danger">
          {t("mcps.checkFailed")}
        </p>
      </Show>
    </div>
  );
}
