import { type TranslationKey, useI18n } from "shared/i18n";
import { Index, Show } from "solid-js";
import type { Turn } from "../model/types";

const completionKeys: Record<string, TranslationKey> = {
  end_turn: "thread.completion.end_turn",
  max_tokens: "thread.completion.max_tokens",
  max_turn_requests: "thread.completion.max_turn_requests",
  refusal: "thread.completion.refusal",
  cancelled: "thread.completion.cancelled",
};

export function Transcript(props: { turns: Turn[] }) {
  const { t } = useI18n();
  return (
    <ol aria-label={t("thread.transcript")} class="flex flex-col gap-8">
      <Index each={props.turns}>
        {(turn) => (
          <li class="flex min-w-0 flex-col gap-5">
            <p class="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-user-bubble px-4 py-3 text-sm text-white">
              {turn().message}
            </p>
            <Show when={turn().response}>
              <div class="w-full whitespace-pre-wrap break-words text-left text-sm leading-7">
                {turn().response}
              </div>
            </Show>
            <Show when={turn().stopReason}>
              {(reason) => (
                <p class="text-xs text-muted">
                  {completionKeys[reason()]
                    ? t(completionKeys[reason()])
                    : reason()}
                </p>
              )}
            </Show>
          </li>
        )}
      </Index>
    </ol>
  );
}
