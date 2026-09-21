import { invoke } from "@tauri-apps/api/core";

export interface LoginMethod {
  id: string;
  name: string;
  description: string | null;
  terminal: boolean;
  supported: boolean;
}

export interface AuthenticationResult {
  connected: boolean;
  authenticated: boolean;
  required: boolean;
  methods: LoginMethod[];
}

export function inspectAuthentication(agentId: string) {
  return invoke<AuthenticationResult>("authenticate_agent", {
    id: agentId,
    method: null,
  });
}

export function authenticate(agentId: string, method: string) {
  return invoke<AuthenticationResult>("authenticate_agent", {
    id: agentId,
    method,
  });
}

export function cancelAuthentication(agentId: string) {
  return invoke<void>("cancel_agent_authentication", { id: agentId });
}
