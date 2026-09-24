const localAgentIcons = import.meta.glob<string>("./assets/*.svg", {
  eager: true,
  import: "default",
  query: "?url",
});

export function agentIconSource(
  id: string,
  registrySource: string | null,
): string | undefined {
  return localAgentIcons[`./assets/${id}.svg`] ?? registrySource ?? undefined;
}
