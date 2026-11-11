export type EditHistoryAction = "undo" | "redo";

// Dispatched by the macOS menu at the focused element, including shadow roots.
export function bindEditHistory(
  root: HTMLElement,
  run: (action: EditHistoryAction) => void,
) {
  const listener = (event: Event) => {
    if (!(event instanceof CustomEvent) || event.defaultPrevented) return;
    if (event.detail !== "undo" && event.detail !== "redo") return;
    const target = event.composedPath()[0];
    // Search fields inside an editor keep their own native history.
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
      return;
    event.preventDefault();
    run(event.detail);
  };
  root.addEventListener("atte-edit-history", listener);
  return () => root.removeEventListener("atte-edit-history", listener);
}
