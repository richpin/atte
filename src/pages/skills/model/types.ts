export type SkillTarget =
  | { scope: "global" }
  | { scope: "project"; folder: string };

export interface SkillEntry {
  name: string;
  path: string;
  scope: string;
  agents: string[];
  source: string | null;
  sourceUrl: string | null;
  sourceType: string | null;
  description: string | null;
}

export interface SkillDocument {
  description: string | null;
  markdown: string;
}

export interface InstallResult {
  name: string | null;
  status: string;
  error: string | null;
}
