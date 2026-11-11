import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createSignal, Show } from "solid-js";
import { cancelMcpLogin, loginMcp, logoutMcp } from "../api/mcps";
import type { Target } from "../model/types";

export function Authentication(props: {
  target: Target;
  name: string;
  status: "required" | "signingIn" | "authorized" | "reauthorizationRequired";
  disabled: boolean;
}) {
  const { t } = useI18n();
  const [error, setError] = createSignal<string>();
  const [starting, setStarting] = createSignal(false);
  const [stopping, setStopping] = createSignal(false);
  const signingIn = () => starting() || props.status === "signingIn";
  async function login() {
    if (signingIn()) return;
    setStarting(true);
    setError(undefined);
    try {
      await loginMcp(props.target, props.name);
    } catch (error) {
      setError(String(error));
    } finally {
      setStarting(false);
    }
  }
  async function stop() {
    setStopping(true);
    setError(undefined);
    try {
      if (signingIn()) await cancelMcpLogin(props.target, props.name);
      else await logoutMcp(props.target, props.name);
    } catch (error) {
      setError(String(error));
    } finally {
      setStopping(false);
    }
  }
  return (
    <div class="space-y-2">
      <p role="status" class="text-xs text-muted-foreground">
        {t(`mcps.auth.${props.status}`)}
      </p>
      <div class="flex gap-2">
        <Show when={!signingIn() && props.status !== "authorized"}>
          <Button
            size="sm"
            variant="outline"
            disabled={props.disabled || stopping()}
            onClick={() => void login()}
          >
            {t("mcps.login")}
          </Button>
        </Show>
        <Show
          when={
            signingIn() ||
            props.status === "authorized" ||
            props.status === "reauthorizationRequired"
          }
        >
          <Button
            size="sm"
            variant="ghost"
            disabled={stopping()}
            onClick={() => void stop()}
          >
            {signingIn() ? t("common.cancel") : t("mcps.logout")}
          </Button>
        </Show>
      </div>
      <Show when={error()}>
        {(message) => (
          <p role="alert" class="text-sm text-danger">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
