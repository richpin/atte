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
  | "sessionRestorationFailed";

export interface AvailableCommand {
  name: string;
  description: string;
  inputHint: string | null;
}

export interface ContextUsage {
  used: number;
  size: number;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPromptAt: number | null;
  interrupted: boolean;
  storageError: string | null;
  workingFolder: string;
  worktree: { sourceFolder: string; root: string } | null;
  agentId: string;
  status:
    | "disconnected"
    | "connecting"
    | "sessionReady"
    | "running"
    | "waitingForInput"
    | "cancelling"
    | "failed";
  sessionId: string | null;
  authentication: "unknown" | "required" | "authenticated";
  failure: ConnectionFailure | null;
  completedTurnId: string | null;
  turns: Turn[];
  notice: string | null;
  pendingInteractions: PendingInteraction[];
  queuedMessages: QueuedMessage[];
  configuration: ThreadConfiguration[];
  contextUsage: ContextUsage | null;
  availableCommands: AvailableCommand[];
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
  | "worktree"
  | "agentId"
  | "status"
  | "sessionId"
  | "createdAt"
  | "updatedAt"
  | "lastPromptAt"
  | "failure"
  | "completedTurnId"
  | "interrupted"
>;

export interface PermissionRequest {
  id: string;
  title: string;
  toolCallId: string;
  details: string;
  planReview?: { planId: string; content: string } | null;
  options: { id: string; name: string }[];
}

export type FormValue = string | boolean | string[];
export type FormValues = Record<string, FormValue>;
export interface FormField {
  type: "string" | "integer" | "number" | "boolean" | "array";
  title?: string;
  description?: string;
  default?: string | number | boolean | string[];
  enum?: string[];
  oneOf?: { const: string; title: string }[];
  items?: { enum?: string[]; anyOf?: { const: string; title: string }[] };
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  format?: string;
}
export interface ElicitationRequest {
  kind: "elicitation";
  id: string;
  message: string;
  toolCallId: string | null;
  schema: {
    title?: string;
    description?: string;
    properties: Record<string, FormField>;
    required?: string[];
  };
}
export type PendingInteraction =
  | (PermissionRequest & { kind: "permission" })
  | ElicitationRequest;
export type ElicitationAnswer =
  | {
      action: "accept";
      values: Record<string, string | number | boolean | string[]>;
    }
  | { action: "decline" | "cancel" };

export interface ToolCall {
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string; line?: number | null }[];
  content?: ToolContent[];
}

export interface ResponseContent {
  id?: string;
  type: string;
  name?: string;
  text?: string;
  uri?: string;
  mimeType?: string;
  description?: string;
  size?: number;
  hasData?: boolean;
}

export type ToolContent =
  | {
      type: "content";
      content: ResponseContent;
    }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface Plan {
  entries: {
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
    _meta?: Record<string, unknown> | null;
  }[];
  _meta?: Record<string, unknown> | null;
}

export type PlanContent =
  | { type: "items"; entries: Plan["entries"] }
  | { type: "markdown"; content: string }
  | { type: "file"; uri: string };

export type ResponsePart =
  | { kind: "content"; id: string; content: ResponseContent }
  | { kind: "text"; id: string; text: string }
  | { kind: "thought"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolCall }
  | { kind: "plan"; id: string; plan: Plan }
  | {
      kind: "planContent";
      id: string;
      planId: string;
      content: PlanContent | null;
    };

export interface Turn {
  id: string;
  message: string;
  attachments?: Attachment[];
  responseParts: ResponsePart[];
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
  | {
      kind: "contentUpdate";
      threadId: string;
      turnId: string;
      part: Extract<ResponsePart, { kind: "content" }>;
    }
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
      partId: string;
      text: string;
    }
  | {
      kind: "thoughtDelta";
      threadId: string;
      turnId: string;
      partId: string;
      text: string;
    }
  | {
      kind: "planUpdate";
      threadId: string;
      turnId: string;
      part: Extract<ResponsePart, { kind: "plan" }>;
    }
  | {
      kind: "planContentUpdate";
      threadId: string;
      turnId: string;
      part: Extract<ResponsePart, { kind: "planContent" }>;
    }
  | {
      kind: "toolUpdate";
      threadId: string;
      turnId: string;
      part: Extract<ResponsePart, { kind: "tool" }>;
    };
