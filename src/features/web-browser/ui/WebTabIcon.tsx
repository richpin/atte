import { Image } from "@kobalte/core/image";
import { Globe } from "lucide-solid";

export function WebTabIcon(props: { src: string | null; class?: string }) {
  return (
    <Image class={props.class}>
      <Image.Img
        src={props.src ?? undefined}
        alt=""
        class="size-full object-contain"
        referrerPolicy="no-referrer"
      />
      <Image.Fallback>
        <Globe class="size-full" />
      </Image.Fallback>
    </Image>
  );
}
