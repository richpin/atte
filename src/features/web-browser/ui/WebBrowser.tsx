import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  RotateCw,
} from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button, Tailspin, TextField, TextFieldInput } from "shared/ui";
import { mergeProps, Show } from "solid-js";
import {
  createWebBrowserModel,
  type WebBrowserOptions,
} from "../model/browser";

export function WebBrowser(props: WebBrowserOptions) {
  const { t } = useI18n();
  let input!: HTMLInputElement;
  let surface!: HTMLDivElement;
  const {
    address,
    setAddress,
    state,
    error,
    invalid,
    setInvalid,
    ready,
    creating,
    navigate,
    action,
    openExternal,
    restoreAddress,
    retry,
  } = createWebBrowserModel(
    mergeProps(props, {
      input: () => input,
      surface: () => surface,
    }),
  );

  return (
    <div class="flex h-full min-h-0 flex-col">
      <form
        class="shrink-0 border-b border-line bg-panel p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate();
        }}
      >
        <div class="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label={t("webBrowser.back")}
            disabled={!state().canGoBack}
            onClick={() => void action("back")}
          >
            <ArrowLeft class="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label={t("webBrowser.forward")}
            disabled={!state().canGoForward}
            onClick={() => void action("forward")}
          >
            <ArrowRight class="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label={t("webBrowser.reload")}
            disabled={!ready()}
            onClick={() => void action("reload")}
          >
            <Show
              when={state().loading || creating()}
              fallback={<RotateCw class="size-4" />}
            >
              <Tailspin class="inline-flex size-4" />
            </Show>
          </Button>
          <TextField
            class="min-w-0 flex-1"
            disabled={creating()}
            value={address()}
            onChange={(value) => {
              setAddress(value);
              setInvalid(false);
            }}
            validationState={invalid() ? "invalid" : "valid"}
          >
            <TextFieldInput
              ref={input}
              aria-label={t("webBrowser.address")}
              aria-invalid={invalid()}
              class="h-8 min-w-0 flex-1 text-xs"
              placeholder={t("webBrowser.addressPlaceholder")}
              onBlur={restoreAddress}
            />
          </TextField>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="size-7"
            aria-label={t("webBrowser.external")}
            disabled={!state().url}
            onClick={() => void openExternal()}
          >
            <ExternalLink class="size-4" />
          </Button>
        </div>
        <Show when={invalid()}>
          <p role="alert" class="mt-2 text-xs text-danger">
            {t("webBrowser.invalidAddress")}
          </p>
        </Show>
      </form>
      <div ref={surface} class="relative min-h-0 flex-1 overflow-hidden">
        <Show
          when={error()}
          fallback={
            <Show when={!ready()}>
              <div class="grid h-full place-content-center gap-3 p-6 text-center text-sm text-muted">
                <Globe class="mx-auto size-7" />
                <p>
                  {creating() ? t("webBrowser.loading") : t("webBrowser.empty")}
                </p>
              </div>
            </Show>
          }
        >
          <div class="grid h-full place-content-center gap-3 p-6 text-center text-sm text-muted">
            <p role="alert">{t("webBrowser.error")}</p>
            <Button variant="outline" onClick={retry}>
              {t("webBrowser.retry")}
            </Button>
          </div>
        </Show>
      </div>
    </div>
  );
}
