export interface Authentication {
  connected: boolean;
  authenticated: boolean;
  required: boolean;
  methods: {
    id: string;
    name: string;
    description: string | null;
    terminal: boolean;
  }[];
}

export interface ManagedAgent {
  id: string;
  name: string;
  installed: boolean;
  installedVersion: string | null;
  artifact: string | null;
  availableVersion: string | null;
  distribution:
    | { kind: "npm"; package: string }
    | { kind: "binary"; archive: string }
    | null;
  authentication: Authentication;
}
