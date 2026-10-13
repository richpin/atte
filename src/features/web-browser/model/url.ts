export function normalizeWebAddress(value: string): string | undefined {
  const input = value.trim();
  if (!input || /\s/.test(input)) return;
  const local =
    /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(input);
  const hostWithPort = /^[^:/]+\.[^:/]+:\d+(?:\/|$)/.test(input);
  const explicit = /^[a-z][a-z\d+.-]*:/i.test(input) && !local && !hostWithPort;
  try {
    const url = new URL(
      explicit ? input : `${local ? "http" : "https"}://${input}`,
    );
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return;
    return url.href;
  } catch {
    return;
  }
}
