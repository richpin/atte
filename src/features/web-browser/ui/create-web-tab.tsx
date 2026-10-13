import { Globe } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createSignal, Show } from "solid-js";
import { WebBrowser } from "./WebBrowser";

export function createWebTab(
  threadId: string,
  options: { url?: string; title?: () => string } = {},
) {
  const { t } = useI18n();
  const id = crypto.randomUUID();
  const [web, setWeb] = createSignal(Boolean(options.url));
  const [title, setTitle] = createSignal(
    options.url ? new URL(options.url).host : "",
  );
  return {
    id,
    title: () =>
      web()
        ? title() || t("webBrowser.title")
        : (options.title?.() ?? t("webBrowser.title")),
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
        />
      </Show>
    ),
  };
}
