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
  lastPromptAt: number | null;
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
  completedTurnId: string | null;
  requestFailure: ConnectionFailure | null;
  turns: Turn[];
  notice: string | null;
  permissions: PermissionRequest[];
  queuedMessages: QueuedMessage[];
  configuration: ThreadConfiguration[];
  promptCapabilities?: { image: boolean; audio: boolean };
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
  attachments: Attachment[];
  status: "pending" | "failed";
}

export interface Attachment {
  id: string;
  name: string;
  kind?: AttachmentKind;
  uri?: string;
  mimeType?: string;
}

export interface UserInput {
  text: string;
  attachments: Attachment[];
}

export interface FileSelection {
  attachments: Attachment[];
  errors: { name: string }[];
}

export type AttachmentKind = "file" | "image" | "audio";
export type MediaKind = Exclude<AttachmentKind, "file">;

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
  | "completedTurnId"
  | "requestFailure"
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
  attachments?: Attachment[];
  response: string;
  stopReason: string | null;
}

export type ThreadPatch = Omit<Thread, "turns">;

export type TurnUpdate =
  | { kind: "added"; turn: Turn }
  | { kind: "completed"; turnId: string; stopReason: string | null }
  | { kind: "replaced"; turns: Turn[] };

export interface PreparedAgent {
  id: string;
  name: string;
}

export type ThreadUpdate =
  | { kind: "thread"; thread: Thread }
  | {
      kind: "patch";
      thread: ThreadPatch;
      turnUpdates: TurnUpdate[];
      errors?: {
        id: string;
        failure?: ConnectionFailure | null;
        message?: string | null;
      }[];
    }
  | {
      kind: "textDelta";
      threadId: string;
      turnId: string;
      text: string;
    };
