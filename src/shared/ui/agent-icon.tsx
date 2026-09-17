import { Image } from "@kobalte/core/image";

export function AgentIcon(props: { src: string | null }) {
  return (
    <Image
      aria-hidden="true"
      class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted"
    >
      <Image.Img
        src={props.src ?? undefined}
        alt=""
        referrerPolicy="no-referrer"
        class="size-6 object-contain"
      />
      <Image.Fallback>
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          aria-hidden="true"
        >
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="m7 9 3 3-3 3m6 0h4" />
        </svg>
      </Image.Fallback>
    </Image>
  );
}
