import { invoke } from "@tauri-apps/api/core";
import type {
  InstallResult,
  SkillDocument,
  SkillEntry,
  SkillTarget,
} from "../model/types";

export function listSkills(target: SkillTarget) {
  return invoke<SkillEntry[]>("list_skills", { target });
}

export function readSkillDocument(target: SkillTarget, path: string) {
  return invoke<SkillDocument>("read_skill_document", { target, path });
}

export function installSkill(
  target: SkillTarget,
  source: string,
  name: string,
) {
  return invoke<InstallResult[]>("install_skill", { target, source, name });
}

export function removeSkill(target: SkillTarget, name: string) {
  return invoke<void>("remove_skill", { target, name });
}
