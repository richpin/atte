import { AlertDialog } from "@kobalte/core/alert-dialog";
import { useI18n } from "shared/i18n";

export function UninstallAgentDialog(props: {
  name: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  return (
    <AlertDialog>
      <AlertDialog.Trigger
        disabled={props.disabled}
        aria-label={t("agents.uninstallLabel", { name: props.name })}
        class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
      >
        {t("agents.uninstall")}
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay class="fixed inset-0 bg-black/40" />
        <AlertDialog.Content class="fixed left-1/2 top-1/2 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-line bg-panel p-6 text-ink shadow-xl">
          <AlertDialog.Title class="font-semibold">
            {t("agents.uninstallTitle", { name: props.name })}
          </AlertDialog.Title>
          <AlertDialog.Description class="text-sm text-muted">
            {t("agents.uninstallDescription")}
          </AlertDialog.Description>
          <div class="flex justify-end gap-3 text-sm">
            <AlertDialog.CloseButton
              aria-label={t("common.cancel")}
              class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              {t("common.cancel")}
            </AlertDialog.CloseButton>
            <AlertDialog.CloseButton
              aria-label={t("agents.confirmUninstall")}
              class="rounded-lg bg-primary px-4 py-2 text-primary-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              onClick={props.onConfirm}
            >
              {t("agents.confirmUninstall")}
            </AlertDialog.CloseButton>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
