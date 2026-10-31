import { Globe } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createSignal, Show } from "solid-js";
import { WebBrowser } from "./WebBrowser";
import { WebTabIcon } from "./WebTabIcon";

export function createWebTab(
  threadId: string,
  options: {
    url?: string;
    title?: () => string;
    fallbackTitle?: string;
    startBlank?: boolean;
    translate?: ReturnType<typeof useI18n>["t"];
  } = {},
) {
  const t = options.translate ?? useI18n().t;
  const id = crypto.randomUUID();
  const [web, setWeb] = createSignal(
    Boolean(options.url || options.startBlank),
  );
  const [title, setTitle] = createSignal(
    options.url ? new URL(options.url).host : "",
  );
  const [favicon, setFavicon] = createSignal<string | null>(null);
  return {
    id,
    icon: (props: { class?: string }) => (
      <WebTabIcon src={favicon()} class={props.class} />
    ),
    title: () =>
      web()
        ? title() || options.fallbackTitle || t("webBrowser.title")
        : (options.title?.() ?? options.fallbackTitle ?? t("webBrowser.title")),
    content: (props: { active: boolean; visible: boolean }) => (
      <Show
        when={web()}
        fallback={
          <div class="grid h-full place-content-center gap-4 p-6 text-center text-sm text-muted">
            <p>{t("threadPanel.newTabDescription")}</p>
            <Button variant="outline" onClick={() => setWeb(true)}>
              <Globe class="size-4" />
              {t("webBrowser.title")}
            </Button>
          </div>
        }
      >
        <WebBrowser
          id={id}
          threadId={threadId}
          initialUrl={options.url}
          visible={props.visible}
          onTitle={setTitle}
          onFavicon={setFavicon}
        />
      </Show>
    ),
  };
}
