export type ConnectionFailure =
  | "executableNotFound"
  | "launchFailed"
  | "initializationFailed"
  | "sessionCreationFailed"
  | "authenticationRequired"
  | "processExited"
  | "connectionClosed"
  | "timedOut"
  | "agentRemoved"
  | "resumptionUnsupported"
  | "sessionRestorationFailed"
  | "promptFailed";

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPromptAt: number;
  interrupted: boolean;
  storageError: string | null;
  workingFolder: string;
  agentId: string;
  status:
    | "disconnected"
    | "connecting"
    | "sessionReady"
    | "running"
    | "waitingForApproval"
    | "cancelling"
    | "failed";
  sessionId: string | null;
  authentication: "unknown" | "required" | "authenticated";
  failure: ConnectionFailure | null;
  turns: Turn[];
  notice: string | null;
  permissions: PermissionRequest[];
  queuedMessages: QueuedMessage[];
  configuration: ThreadConfiguration[];
}

export type ThreadConfigurationValue =
  | { type: "select"; value: string }
  | { type: "boolean"; value: boolean };

export interface ThreadConfigurationChoice {
  value: string;
  name: string;
  description: string | null;
}

export type ThreadConfigurationSelectOptions =
  | { type: "flat"; options: ThreadConfigurationChoice[] }
  | {
      type: "grouped";
      groups: {
        id: string;
        name: string;
        options: ThreadConfigurationChoice[];
      }[];
    };

interface ThreadConfigurationBase {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
}

export type ThreadConfiguration = ThreadConfigurationBase &
  (
    | {
        type: "select";
        currentValue: string;
        options: ThreadConfigurationSelectOptions;
      }
    | { type: "boolean"; currentValue: boolean }
  );

export interface QueuedMessage {
  id: string;
  text: string;
}

export type ThreadMetadata = Pick<
  Thread,
  | "id"
  | "title"
  | "workingFolder"
  | "agentId"
  | "status"
  | "sessionId"
  | "createdAt"
  | "updatedAt"
  | "lastPromptAt"
  | "failure"
  | "interrupted"
>;

export interface PermissionRequest {
  id: string;
  title: string;
  details: string;
  options: { id: string; name: string }[];
}

export interface Turn {
  id: string;
  message: string;
  response: string;
  stopReason: string | null;
}

export interface PreparedAgent {
  id: string;
  name: string;
}

export type ThreadUpdate =
  | { kind: "thread"; thread: Thread }
  | {
      kind: "textDelta";
      threadId: string;
      turnId: string;
      text: string;
    };
