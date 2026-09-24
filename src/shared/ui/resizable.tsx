import type { DynamicProps, HandleProps, RootProps } from "@corvu/resizable";
import ResizablePrimitive from "@corvu/resizable";
import { GripVertical } from "lucide-solid";
import type { ValidComponent } from "solid-js";
import { Show, splitProps } from "solid-js";

import { cn } from "./cn";

type ResizableProps<T extends ValidComponent = "div"> = RootProps<T> & {
  class?: string;
};

const Resizable = <T extends ValidComponent = "div">(
  props: DynamicProps<T, ResizableProps<T>>,
) => {
  const [, rest] = splitProps(props as ResizableProps, ["class"]);
  return (
    <ResizablePrimitive
      class={cn(
        "flex size-full data-[orientation=vertical]:flex-col",
        props.class,
      )}
      {...rest}
    />
  );
};

const ResizablePanel = ResizablePrimitive.Panel;
const useResizable = ResizablePrimitive.useContext;

type ResizableHandleProps<T extends ValidComponent = "button"> =
  HandleProps<T> & {
    class?: string;
    withHandle?: boolean;
  };

const ResizableHandle = <T extends ValidComponent = "button">(
  props: DynamicProps<T, ResizableHandleProps<T>>,
) => {
  const [, rest] = splitProps(props as ResizableHandleProps, [
    "class",
    "withHandle",
  ]);
  return (
    <ResizablePrimitive.Handle
      class={cn(
        "relative flex shrink-0 items-center justify-center bg-border after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1 data-[orientation=vertical]:h-[0.5px] data-[orientation=vertical]:w-full data-[orientation=vertical]:after:left-0 data-[orientation=vertical]:after:h-1 data-[orientation=vertical]:after:w-full data-[orientation=vertical]:after:-translate-y-1/2 data-[orientation=vertical]:after:translate-x-0 [&[data-orientation=vertical]>div]:rotate-90",
        props.class,
      )}
      {...rest}
    >
      <Show when={props.withHandle}>
        <div class="flex h-4 w-3 items-center justify-center rounded-sm border bg-border">
          <GripVertical aria-hidden="true" class="size-2.5" strokeWidth={1.5} />
        </div>
      </Show>
    </ResizablePrimitive.Handle>
  );
};

export { Resizable, ResizableHandle, ResizablePanel, useResizable };
