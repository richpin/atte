import { describe, expect, it } from "vitest";
import { agentIconSource } from "./agent-icon-source";

describe("agentIconSource", () => {
  it("prefers a bundled registry icon", () => {
    expect(
      agentIconSource(
        "codex-acp",
        "https://cdn.agentclientprotocol.com/registry/v1/latest/codex-acp.svg",
      ),
    ).toMatch(/^data:image\/svg\+xml/);
  });

  it("keeps the registry URL as a fallback for future agents", () => {
    const source = "https://example.com/future-agent.svg";

    expect(agentIconSource("future-agent", source)).toBe(source);
  });

  it("returns no source when neither a bundled nor registry icon exists", () => {
    expect(agentIconSource("missing-agent", null)).toBeUndefined();
  });
});
