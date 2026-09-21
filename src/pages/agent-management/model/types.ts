export interface Authentication {
  connected: boolean;
  authenticated: boolean;
  required: boolean;
  logoutSupported: boolean;
  email: string | null;
  plan: string | null;
  methods: {
    id: string;
    name: string;
    description: string | null;
    terminal: boolean;
    supported: boolean;
  }[];
}

export interface ManagedAgent {
  id: string;
  name: string;
  icon: string | null;
  installed: boolean;
  description: string;
  unavailableReason: string | null;
  installedVersion: string | null;
  artifact: string | null;
  availableVersion: string | null;
  distribution:
    | { kind: "npm"; package: string }
    | { kind: "binary"; archive: string }
    | null;
  authentication: Authentication;
}
