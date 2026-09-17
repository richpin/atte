export type ConnectionFailure =
  | "executableNotFound"
  | "launchFailed"
  | "initializationFailed"
  | "sessionCreationFailed"
  | "authenticationRequired"
  | "processExited"
  | "connectionClosed"
  | "timedOut"
  | "promptFailed";

export interface Conversation {
  id: string;
  workingFolder: string;
  agentId: string;
  status: "disconnected" | "connecting" | "sessionReady" | "running" | "failed";
  remoteSessionId: string | null;
  authentication: "unknown" | "required";
  failure: ConnectionFailure | null;
  revision: number;
  turns: Turn[];
  notice: string | null;
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
