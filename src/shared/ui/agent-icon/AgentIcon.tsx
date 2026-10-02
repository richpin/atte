import { Image } from "@kobalte/core/image";
import { SquareTerminal } from "lucide-solid";
import { agentIconSource } from "./agent-icon-source";

export function AgentIcon(props: {
  id: string;
  src: string | null;
  compact?: boolean;
  waiting?: boolean;
}) {
  return (
    <Image
      aria-hidden="true"
      class={
        props.compact
          ? "inline-flex size-4 shrink-0 items-center justify-center text-muted"
          : props.waiting
            ? "inline-flex size-6 shrink-0 items-center justify-center text-muted"
            : "inline-flex size-8 shrink-0 items-center justify-center text-muted"
      }
    >
      <Image.Img
        src={agentIconSource(props.id, props.src)}
        alt=""
        referrerPolicy="no-referrer"
        class={
          props.compact
            ? "size-4 object-contain dark:brightness-0 dark:invert"
            : "size-6 object-contain dark:brightness-0 dark:invert"
        }
      />
      <Image.Fallback>
        <SquareTerminal
          aria-hidden="true"
          class={props.compact ? "size-4" : "size-6"}
        />
      </Image.Fallback>
    </Image>
  );
}
