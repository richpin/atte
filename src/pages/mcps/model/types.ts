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
  | { type: "http"; url: string; headers: Record<string, ValueSource> }
);
export type Snapshot = {
  servers: Record<string, Server>;
  issues: { name: string; reason: string }[];
  error: string | null;
  path: string;
};
export type ValueRow = {
  name: string;
  source: ValueSource;
  replacement?: string;
};
