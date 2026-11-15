import { Search } from "lucide-solid";

export function SearchInput(props: {
  label: string;
  value: string;
  onInput: (value: string) => void;
}) {
  return (
    <label class="relative block">
      <Search
        aria-hidden="true"
        class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <span class="sr-only">{props.label}</span>
      <input
        class="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        placeholder={props.label}
      />
    </label>
  );
}
