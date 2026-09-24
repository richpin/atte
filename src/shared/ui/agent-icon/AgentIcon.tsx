import { Image } from "@kobalte/core/image";
import { SquareTerminal } from "lucide-solid";
import { agentIconSource } from "./agent-icon-source";

export function AgentIcon(props: { id: string; src: string | null }) {
  return (
    <Image
      aria-hidden="true"
      class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted"
    >
      <Image.Img
        src={agentIconSource(props.id, props.src)}
        alt=""
        referrerPolicy="no-referrer"
        class="size-6 object-contain"
      />
      <Image.Fallback>
        <SquareTerminal aria-hidden="true" class="size-6" />
      </Image.Fallback>
    </Image>
  );
}
