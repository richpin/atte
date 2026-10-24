import { createQuery } from "@tanstack/solid-query";
import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";
import { readWorkingChanges } from "../api/git-working";
import { rememberRoot, rootForThread, workingQueryKey } from "./git-working";

export function useGitWorking(threadId: string, visible: Accessor<boolean>) {
  const [focused, setFocused] = createSignal(document.hasFocus());
  const onFocus = () => setFocused(true);
  const onBlur = () => setFocused(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  onCleanup(() => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  });
  const query = createQuery(() => ({
    queryKey: workingQueryKey(rootForThread(threadId) ?? threadId),
    queryFn: () => readWorkingChanges(threadId),
    enabled: visible(),
    refetchInterval: visible() && focused() ? 2000 : false,
    refetchOnWindowFocus: true,
    retry: false,
  }));
  createEffect(() => {
    const root = query.data?.root;
    if (root) rememberRoot(threadId, root);
  });
  return query;
}
