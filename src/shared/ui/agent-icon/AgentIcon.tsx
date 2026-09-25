import { Image } from "@kobalte/core/image";
import { SquareTerminal } from "lucide-solid";
import { agentIconSource } from "./agent-icon-source";

export function AgentIcon(props: {
  id: string;
  src: string | null;
  compact?: boolean;
}) {
  return (
    <Image
      aria-hidden="true"
      class={
        props.compact
          ? "inline-flex size-4 shrink-0 items-center justify-center text-muted"
          : "inline-flex size-8 shrink-0 items-center justify-center text-muted"
      }
    >
      <Image.Img
        src={agentIconSource(props.id, props.src)}
        alt=""
        referrerPolicy="no-referrer"
        class={
          props.compact ? "size-4 object-contain" : "size-6 object-contain"
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
