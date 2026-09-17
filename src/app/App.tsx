import { AgentManagementPage } from "pages/agent-management";
import { ConversationPage } from "pages/conversation";
import { createSignal } from "solid-js";
import "./styles.css";

export default function App() {
  const [management, setManagement] = createSignal(false);
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  return (
    <>
      <div hidden={management()}>
        <ConversationPage
          agentsRevision={agentsRevision()}
          onManage={() => setManagement(true)}
        />
      </div>
      <div hidden={!management()}>
        <AgentManagementPage
          active={management()}
          onBack={() => setManagement(false)}
          onInstalled={() => setAgentsRevision((value) => value + 1)}
        />
      </div>
    </>
  );
}
