import { createMediaQuery } from "@solid-primitives/media";
import { tailspin } from "ldrs";
import { type JSX, splitProps } from "solid-js";
import { cn } from "./cn";

tailspin.register();

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      "l-tailspin": JSX.HTMLAttributes<HTMLElement> & {
        size?: number;
        stroke?: number;
        speed?: number;
        color?: string;
      };
    }
  }
}

export function Tailspin(
  props: JSX.HTMLAttributes<HTMLSpanElement> & {
    size?: number;
    active?: boolean;
  },
) {
  const [local, others] = splitProps(props, ["size", "active", "class"]);
  const reducedMotion =
    typeof window.matchMedia === "function"
      ? createMediaQuery("(prefers-reduced-motion: reduce)")
      : () => false;

  return (
    <span
      aria-hidden="true"
      class={cn("inline-flex shrink-0", local.class)}
      {...others}
    >
      <l-tailspin
        size={local.size ?? 16}
        stroke={2}
        speed={local.active === false || reducedMotion() ? 0 : 0.9}
        color="currentColor"
      />
    </span>
  );
}
