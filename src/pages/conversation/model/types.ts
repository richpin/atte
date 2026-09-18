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

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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
  remoteSessionId: string | null;
  authentication: "unknown" | "required" | "authenticated";
  failure: ConnectionFailure | null;
  revision: number;
  turns: Turn[];
  notice: string | null;
  permissions: PermissionRequest[];
}

export type ConversationSummary = Pick<
  Conversation,
  | "id"
  | "title"
  | "workingFolder"
  | "agentId"
  | "status"
  | "remoteSessionId"
  | "createdAt"
  | "updatedAt"
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

export const statusLabels: Record<Conversation["status"], string> = {
  disconnected: "연결 전",
  connecting: "연결 중…",
  sessionReady: "세션 준비 완료",
  failed: "실패",
  running: "응답 중…",
  waitingForApproval: "승인 대기",
  cancelling: "중단 중…",
};

export const failureMessages: Record<ConnectionFailure, string> = {
  executableNotFound:
    "에이전트 실행 파일을 찾을 수 없습니다. 설치와 실행 경로를 확인해주세요.",
  launchFailed:
    "에이전트를 실행할 수 없습니다. 실행 권한과 작업 폴더를 확인해주세요.",
  initializationFailed: "에이전트 초기화에 실패했습니다.",
  sessionCreationFailed: "대화 세션을 만들 수 없습니다.",
  authenticationRequired:
    "에이전트 로그인이 필요합니다. 로그인 후 다시 연결해주세요.",
  processExited: "에이전트 프로세스가 종료되었습니다.",
  connectionClosed: "에이전트와의 연결이 끊어졌습니다.",
  promptFailed: "메시지 실행에 실패했습니다. 다시 연결해주세요.",
  timedOut: "에이전트 연결 시간이 초과되었습니다.",
  agentRemoved: "에이전트를 설치한 뒤 이 대화에서 다시 시도해주세요.",
  resumptionUnsupported: "이 에이전트는 기존 대화 재개를 지원하지 않습니다.",
  sessionRestorationFailed:
    "기존 대화를 복원할 수 없습니다. 세션이 삭제되었거나 사용할 수 없는지 확인해주세요.",
};

export type ConversationUpdate =
  | { kind: "snapshot"; snapshot: Conversation }
  | {
      kind: "textDelta";
      conversationId: string;
      revision: number;
      turnId: string;
      text: string;
    };
