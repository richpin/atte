import { Toast, toaster } from "@kobalte/core/toast";
import { X } from "lucide-solid";
import { onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { useI18n } from "../i18n";

export function showErrorToast(message: string, description?: string) {
  toaster.show((props) => (
    <Toast
      toastId={props.toastId}
      priority="high"
      role="alert"
      class="pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-menu p-4 text-sm text-ink shadow-lg"
    >
      <div class="min-w-0 flex-1">
        <Toast.Title class="break-words">{message}</Toast.Title>
        {description?.trim() && (
          <Toast.Description class="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-muted">
            {description}
          </Toast.Description>
        )}
      </div>
      <ErrorToastCloseButton />
    </Toast>
  ));
}

function ErrorToastCloseButton() {
  const { t } = useI18n();
  return (
    <Toast.CloseButton
      aria-label={t("notifications.close")}
      class="shrink-0 rounded text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <X aria-hidden="true" class="size-4" />
    </Toast.CloseButton>
  );
}

export function ToastHost() {
  const { t } = useI18n();
  let region!: HTMLDivElement;
  onMount(() => {
    // A nonmodal native top layer keeps notifications above portal dialogs
    // without adding a competing z-index scale.
    region.showPopover?.();
  });
  onCleanup(() => toaster.clear());
  return (
    <Portal>
      <Toast.Region
        ref={region}
        popover={
          typeof HTMLElement.prototype.showPopover === "function"
            ? "manual"
            : undefined
        }
        topLayer
        duration={5_000}
        limit={3}
        pauseOnInteraction
        pauseOnPageIdle
        aria-label={t("notifications.label")}
        class="pointer-events-none fixed inset-auto top-16 left-1/2 m-0 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 overflow-visible border-0 bg-transparent p-0 text-ink"
      >
        <Toast.List class="flex flex-col gap-2 outline-none" />
      </Toast.Region>
    </Portal>
  );
}
