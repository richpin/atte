import { useI18n } from "shared/i18n";
import { ImagePreview } from "shared/ui";
import {
  createEffect,
  createResource,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import { readImage } from "../api/files";
import { imageMime } from "../lib/file-kind";

export function FileImagePreview(props: {
  threadId: string;
  path: string;
  revision: number;
}) {
  const { t } = useI18n();
  const [image] = createResource(
    () => ({ path: props.path, revision: props.revision }),
    async ({ path }) =>
      new Blob([await readImage(props.threadId, path)], {
        type: imageMime(path),
      }),
  );
  const error = () => {
    const cause = image.error;
    switch (cause instanceof Error ? cause.message : cause) {
      case "imageTooLarge":
        return t("files.imageTooLarge");
      case "unsupportedImage":
      case "unsupported":
        return t("files.unsupportedImage");
      case "accessDenied":
        return t("files.accessDenied");
      case "invalidPath":
        return t("files.invalidPath");
      default:
        return t("files.imageReadFailed");
    }
  };
  return (
    <Show
      when={!image.loading}
      fallback={
        <p role="status" class="p-3 text-xs text-muted">
          {t("files.imageLoading")}
        </p>
      }
    >
      <Show
        when={!image.error}
        fallback={
          <p role="alert" class="p-3 text-xs text-muted">
            {error()}
          </p>
        }
      >
        <Show when={image()}>
          {(blob) => (
            <ImagePreview
              blob={blob()}
              alt={props.path}
              loadingLabel={t("files.imageLoading")}
              errorLabel={t("files.imageDecodeFailed")}
            />
          )}
        </Show>
      </Show>
    </Show>
  );
}

export function SvgPreview(props: { text: string; path: string }) {
  const { t } = useI18n();
  const makeBlob = (text: string) =>
    new Blob([text], { type: "image/svg+xml" });
  const [blob, setBlob] = createSignal(makeBlob(props.text));
  createEffect(
    on(
      () => props.text,
      (text) => {
        const timer = setTimeout(() => setBlob(makeBlob(text)), 200);
        onCleanup(() => clearTimeout(timer));
      },
      { defer: true },
    ),
  );
  return (
    <ImagePreview
      blob={blob()}
      alt={props.path}
      loadingLabel={t("files.imageLoading")}
      errorLabel={t("files.imageDecodeFailed")}
    />
  );
}
