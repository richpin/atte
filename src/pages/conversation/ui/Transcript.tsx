import { Index, Show } from "solid-js";
import type { Turn } from "../model/types";

const completionLabels: Record<string, string> = {
  end_turn: "완료",
  max_tokens: "응답 길이 제한에 도달했습니다",
  max_turn_requests: "실행 횟수 제한에 도달했습니다",
  refusal: "요청이 거절되었습니다",
  cancelled: "취소됨",
};

export function Transcript(props: { turns: Turn[] }) {
  return (
    <ol aria-label="대화 내용" class="flex flex-col gap-8">
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
                  {completionLabels[reason()] ?? reason()}
                </p>
              )}
            </Show>
          </li>
        )}
      </Index>
    </ol>
  );
}
