import { useI18n } from "shared/i18n";
import { createContext, type ParentProps, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import {
  authenticate,
  cancelAuthentication,
  inspectAuthentication,
  type LoginMethod,
} from "../api/authentication";

export type AgentAuthenticationState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; methods: LoginMethod[] }
  | { status: "authenticating"; method: LoginMethod; methods: LoginMethod[] }
  | { status: "cancelling"; method: LoginMethod; methods: LoginMethod[] }
  | { status: "authenticated"; generation: number };

interface AgentAuthentication {
  state: (agentId: string) => AgentAuthenticationState;
  discover: (
    agentId: string,
    notifyError?: (message: string) => void,
  ) => Promise<void>;
  login: (
    agentId: string,
    methodId: string,
    notifyError?: (message: string) => void,
  ) => Promise<boolean>;
  cancel: (agentId: string) => Promise<void>;
  requireAuthentication: (
    agentId: string,
    notifyError?: (message: string) => void,
  ) => Promise<void>;
}

const idle: AgentAuthenticationState = { status: "idle" };
const AuthenticationContext = createContext<AgentAuthentication>();

export function AgentAuthenticationProvider(props: ParentProps) {
  const { message } = useI18n();
  const [states, setStates] = createStore<
    Record<string, AgentAuthenticationState | undefined>
  >({});
  const attempts = new Map<string, number>();

  async function discover(
    agentId: string,
    notifyError?: (message: string) => void,
  ) {
    const current = states[agentId];
    if (
      current?.status === "loading" ||
      current?.status === "ready" ||
      current?.status === "authenticating" ||
      current?.status === "cancelling" ||
      current?.status === "authenticated"
    )
      return;
    const attempt = (attempts.get(agentId) ?? 0) + 1;
    attempts.set(agentId, attempt);
    setStates(agentId, { status: "loading" });
    try {
      const result = await inspectAuthentication(agentId);
      if (attempts.get(agentId) !== attempt) return;
      setStates(agentId, {
        status: "ready",
        methods: result.methods.filter((method) => method.supported),
      });
    } catch (cause) {
      if (attempts.get(agentId) !== attempt) return;
      const error = message(cause, "thread.authentication.discoveryFailed");
      setStates(agentId, { status: "error", message: error });
      notifyError?.(error);
    }
  }

  async function login(
    agentId: string,
    methodId: string,
    notifyError?: (message: string) => void,
  ) {
    const current = states[agentId];
    if (current?.status !== "ready") return false;
    const method = current.methods.find(
      (candidate) => candidate.id === methodId,
    );
    if (!method?.supported) return false;
    const attempt = (attempts.get(agentId) ?? 0) + 1;
    attempts.set(agentId, attempt);
    setStates(agentId, {
      status: "authenticating",
      method,
      methods: current.methods,
    });
    try {
      await authenticate(agentId, method.id);
      if (attempts.get(agentId) !== attempt) return false;
      setStates(agentId, { status: "authenticated", generation: attempt });
      return true;
    } catch (cause) {
      if (attempts.get(agentId) !== attempt) return false;
      const error = message(cause, "thread.authentication.loginFailed");
      setStates(agentId, { status: "error", message: error });
      notifyError?.(error);
      return false;
    }
  }

  async function cancel(agentId: string) {
    const current = states[agentId];
    if (current?.status !== "authenticating") return;
    const attempt = (attempts.get(agentId) ?? 0) + 1;
    attempts.set(agentId, attempt);
    setStates(agentId, {
      status: "cancelling",
      method: current.method,
      methods: current.methods,
    });
    try {
      await cancelAuthentication(agentId);
    } catch {
      /* A superseded login result remains ignored if cancellation reporting fails. */
    } finally {
      if (attempts.get(agentId) === attempt) {
        setStates(agentId, { status: "ready", methods: current.methods });
      }
    }
  }

  async function requireAuthentication(
    agentId: string,
    notifyError?: (message: string) => void,
  ) {
    const current = states[agentId];
    if (current?.status !== "authenticated") return;
    attempts.set(agentId, (attempts.get(agentId) ?? 0) + 1);
    setStates(agentId, { status: "idle" });
    await discover(agentId, notifyError);
  }

  return (
    <AuthenticationContext.Provider
      value={{
        state: (agentId) => states[agentId] ?? idle,
        discover,
        login,
        cancel,
        requireAuthentication,
      }}
    >
      {props.children}
    </AuthenticationContext.Provider>
  );
}

export function useAgentAuthentication() {
  const authentication = useContext(AuthenticationContext);
  if (!authentication)
    throw new Error("AgentAuthenticationProvider is missing");
  return authentication;
}
