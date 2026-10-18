import { createEffect, createSignal, onCleanup, Show } from "solid-js";

export function ImagePreview(props: {
  blob: Blob;
  alt: string;
  loadingLabel: string;
  errorLabel: string;
}) {
  const [source, setSource] = createSignal<string>();
  const [status, setStatus] = createSignal<"loading" | "ready" | "error">(
    "loading",
  );
  createEffect(() => {
    const url = URL.createObjectURL(props.blob);
    setStatus("loading");
    setSource(url);
    onCleanup(() => URL.revokeObjectURL(url));
  });
  return (
    <div class="image-preview flex h-full min-h-0 flex-col items-center justify-center gap-2 overflow-hidden p-3">
      <Show when={status() !== "ready"}>
        <p
          role={status() === "error" ? "alert" : "status"}
          class="text-xs text-muted"
        >
          {status() === "error" ? props.errorLabel : props.loadingLabel}
        </p>
      </Show>
      <Show when={source()} keyed>
        {(url) => (
          <img
            src={url}
            alt={props.alt}
            class="min-h-0 max-h-full max-w-full shrink object-contain"
            classList={{
              invisible: status() !== "ready",
              hidden: status() === "error",
            }}
            draggable={false}
            onLoad={() => source() === url && setStatus("ready")}
            onError={() => source() === url && setStatus("error")}
          />
        )}
      </Show>
    </div>
  );
}
