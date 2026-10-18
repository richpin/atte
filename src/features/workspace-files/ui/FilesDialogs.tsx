import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  TextField,
  TextFieldInput,
} from "shared/ui";
import { createSignal, For, Show } from "solid-js";
import type { FileDialog, FilesManager } from "../model/manager";

export function FilesDialogs(props: { manager: FilesManager }) {
  return (
    <Show when={props.manager.dialog()} keyed>
      {(request) => (
        <FileRequest request={request} answer={props.manager.answer} />
      )}
    </Show>
  );
}
function FileRequest(props: {
  request: FileDialog;
  answer: FilesManager["answer"];
}) {
  const [text, setText] = createSignal(props.request.input ?? "");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.answer("cancel");
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{props.request.title}</DialogTitle>
          <DialogDescription class="whitespace-pre-wrap break-all">
            {props.request.message}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            props.answer(props.request.choices[0].id, text());
          }}
        >
          <Show when={props.request.input !== undefined}>
            <TextField value={text()} onChange={setText}>
              <TextFieldInput autofocus aria-label={props.request.title} />
            </TextField>
          </Show>
          <DialogFooter class="mt-4">
            <For each={props.request.choices}>
              {(choice) => (
                <Button
                  type="button"
                  variant={choice.id === "cancel" ? "outline" : "default"}
                  onClick={() => props.answer(choice.id, text())}
                >
                  {choice.label}
                </Button>
              )}
            </For>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
