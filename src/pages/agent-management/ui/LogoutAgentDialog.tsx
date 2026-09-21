import { AlertDialog } from "@kobalte/core/alert-dialog";
import { useI18n } from "shared/i18n";

export function LogoutAgentDialog(props: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog>
      <AlertDialog.Trigger
        disabled={props.pending}
        aria-label={t(
          props.pending ? "agents.logoutPendingLabel" : "agents.logoutLabel",
          { name: props.name },
        )}
        class="rounded-lg border border-line px-3 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
      >
        {props.pending ? t("agents.loggingOut") : t("agents.logout")}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay class="fixed inset-0 z-40 bg-black/40" />
        <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-line bg-panel p-6 text-ink shadow-xl">
          <AlertDialog.Title class="font-semibold">
            {t("agents.logoutTitle", { name: props.name })}
          </AlertDialog.Title>
          <AlertDialog.Description class="text-sm text-muted">
            {t("agents.logoutDescription")}
          </AlertDialog.Description>
          <div class="flex justify-end gap-3 text-sm">
            <AlertDialog.CloseButton
              aria-label={t("common.cancel")}
              class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              {t("common.cancel")}
            </AlertDialog.CloseButton>
            <AlertDialog.CloseButton
              aria-label={t("agents.confirmLogout")}
              class="rounded-lg bg-accent px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              onClick={props.onConfirm}
            >
              {t("agents.confirmLogout")}
            </AlertDialog.CloseButton>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
