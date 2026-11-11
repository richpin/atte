export type Target = { scope: "global" } | { scope: "project"; folder: string };
export type ValueSource = {
  kind: "literal" | "environment" | "secret";
  value: string;
};
export type Server = { enabled: boolean } & (
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, ValueSource>;
    }
  | {
      type: "http";
      url: string;
      headers: Record<string, ValueSource>;
      oauth?: { clientId?: string };
    }
);
export type Snapshot = {
  servers: Record<string, Server>;
  issues: { name: string; reason: string }[];
  error: string | null;
  path: string;
  authentication?: Record<
    string,
    "required" | "signingIn" | "authorized" | "reauthorizationRequired"
  >;
};
export type ValueRow = {
  name: string;
  source: ValueSource;
  replacement?: string;
};

export type ImportFormat = "json" | "jsonc" | "codex" | "zed";
export type ImportSource = {
  tool: string;
  path: string;
  status: "ready" | "missing" | "error";
  error: string | null;
  candidates: {
    id: string | null;
    name: string;
    transport: string | null;
    reason: string | null;
  }[];
};
export type ImportSelection = { id: string; name: string; overwrite: boolean };
export type CheckStatus =
  | "connected"
  | "noTools"
  | "authenticationRequired"
  | "networkError"
  | "executionFailed"
  | "timeout"
  | "cancelled"
  | "invalidConfiguration"
  | "protocolError";
export type CheckResult = { status: CheckStatus; tools: string[] };
