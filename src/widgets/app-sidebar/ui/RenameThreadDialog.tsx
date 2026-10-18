import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  showErrorToast,
  TextField,
  TextFieldInput,
} from "shared/ui";
import { createSignal } from "solid-js";

export function RenameThreadDialog(props: {
  thread: { id: string; title: string };
  onRename: (id: string, title: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t, message } = useI18n();
  const [title, setTitle] = createSignal(props.thread.title);
  const [saving, setSaving] = createSignal(false);
  let input: HTMLInputElement | undefined;

  async function save() {
    const value = title().trim();
    if (!value || saving()) return;
    setSaving(true);
    try {
      await props.onRename(props.thread.id, value);
      props.onClose();
    } catch (cause) {
      showErrorToast(message(cause, "sidebar.renameFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving()) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          input?.focus();
          input?.select();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("sidebar.renameTitle")}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <TextField value={title()} onChange={setTitle} disabled={saving()}>
            <TextFieldInput
              ref={input}
              aria-label={t("sidebar.threadTitle")}
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.isComposing)
                  event.preventDefault();
              }}
            />
          </TextField>
          <DialogFooter class="mt-4">
            <Button
              type="button"
              variant="outline"
              disabled={saving()}
              onClick={props.onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={saving() || !title().trim()}>
              {saving() ? t("sidebar.renaming") : t("sidebar.saveTitle")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
