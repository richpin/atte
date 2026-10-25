import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "shared/ui";
import { Show } from "solid-js";
import { draftFor, setDraft } from "../../model/git-working";

export function CommitDialog(props: {
  open: boolean;
  root: string;
  disabled: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onCommit: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent closeLabel={t("common.cancel")}>
        <DialogHeader>
          <DialogTitle>{t("git.commit")}</DialogTitle>
          <DialogDescription>{t("git.commitDescription")}</DialogDescription>
        </DialogHeader>
        <input
          class="h-9 w-full rounded border border-line bg-canvas px-2 text-sm"
          aria-label={t("git.commitTitle")}
          placeholder={t("git.commitTitle")}
          value={draftFor(props.root).title}
          onInput={(event) =>
            setDraft(props.root, "title", event.currentTarget.value)
          }
        />
        <textarea
          class="min-h-24 w-full resize-y rounded border border-line bg-canvas px-2 py-1 text-sm"
          aria-label={t("git.commitBody")}
          placeholder={t("git.commitBody")}
          value={draftFor(props.root).body}
          onInput={(event) =>
            setDraft(props.root, "body", event.currentTarget.value)
          }
        />
        <Show when={props.error}>
          <p role="alert" class="text-xs text-danger">
            {props.error}
          </p>
        </Show>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={props.disabled || !draftFor(props.root).title.trim()}
            onClick={props.onCommit}
          >
            {t("git.commitStaged")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
