import { Image } from "@kobalte/core/image";
import { AppWindow, Ellipsis, FolderOpen } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  showErrorToast,
} from "shared/ui";
import { createResource, createSignal, For, Show } from "solid-js";
import {
  listWorkingFolderApps,
  openWorkingFolder,
  openWorkingFolderWithAppPicker,
} from "../api/apps";

export function OpenWorkingFolderMenu(props: { threadId: string | undefined }) {
  const { t } = useI18n();
  const [opened, setOpened] = createSignal(false);
  const [apps, { refetch }] = createResource(
    () => opened() && props.threadId,
    listWorkingFolderApps,
  );
  const [opening, setOpening] = createSignal(false);

  async function open(target?: string) {
    const id = props.threadId;
    if (!id || opening()) return;
    setOpening(true);
    try {
      if (target === undefined) {
        await openWorkingFolderWithAppPicker(
          id,
          t("thread.openIn.chooseApplication"),
        );
      } else {
        await openWorkingFolder(id, target);
      }
    } catch (error) {
      const key =
        error === "folderMissing"
          ? "folderMissing"
          : error === "appMissing"
            ? "appMissing"
            : error === "threadUnavailable"
              ? "threadUnavailable"
              : error === "invalidApplication"
                ? "invalidApplication"
                : "openFailed";
      showErrorToast(t(`thread.openIn.${key}`));
    } finally {
      setOpening(false);
    }
  }

  return (
    <Show when={/Mac/i.test(navigator.platform)}>
      <DropdownMenuSub open={opened()} onOpenChange={setOpened}>
        <DropdownMenuSubTrigger class="gap-2" disabled={!props.threadId}>
          <FolderOpen aria-hidden="true" class="size-4" />
          {t("thread.openIn.label")}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <Show
            when={!apps.loading}
            fallback={
              <DropdownMenuItem disabled>
                {t("thread.openIn.loading")}
              </DropdownMenuItem>
            }
          >
            <Show
              when={!apps.error}
              fallback={
                <DropdownMenuItem
                  closeOnSelect={false}
                  onSelect={() => void refetch()}
                >
                  {t("thread.openIn.retry")}
                </DropdownMenuItem>
              }
            >
              <Show
                when={apps()?.length}
                fallback={
                  <DropdownMenuItem disabled>
                    {t("thread.openIn.empty")}
                  </DropdownMenuItem>
                }
              >
                <For each={apps()}>
                  {(app) => (
                    <DropdownMenuItem
                      disabled={opening()}
                      onSelect={() => void open(app.id)}
                    >
                      <Image
                        aria-hidden="true"
                        class="inline-flex size-4 shrink-0 items-center justify-center text-muted"
                      >
                        <Image.Img
                          src={app.icon ?? undefined}
                          alt=""
                          class="size-4 object-contain"
                        />
                        <Image.Fallback>
                          <AppWindow class="size-4" />
                        </Image.Fallback>
                      </Image>
                      {app.name}
                    </DropdownMenuItem>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
          <DropdownMenuItem
            disabled={opening() || !props.threadId}
            onSelect={() => void open()}
          >
            <Ellipsis aria-hidden="true" class="size-4" />
            {t("thread.openIn.otherApplication")}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </Show>
  );
}
