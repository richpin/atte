import { AgentManagementPage } from "pages/agent-management";
import { ThreadPage } from "pages/thread";
import { createSignal } from "solid-js";
import "./styles.css";

export default function App() {
  const [management, setManagement] = createSignal(false);
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  return (
    <>
      <div hidden={management()}>
        <ThreadPage
          active={!management()}
          agentsRevision={agentsRevision()}
          onManage={() => setManagement(true)}
        />
      </div>
      <div hidden={!management()}>
        <AgentManagementPage
          active={management()}
          onBack={() => setManagement(false)}
          onAgentsChanged={() => setAgentsRevision((value) => value + 1)}
        />
      </div>
    </>
  );
}
