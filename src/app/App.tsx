import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { AgentAuthenticationProvider } from "features/agent-authentication";
import { AgentManagementPage } from "pages/agent-management";
import { ThreadPage } from "pages/thread";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import "./styles.css";

export default function App() {
  const queryClient = new QueryClient();
  const [management, setManagement] = createSignal(false);
  const [agentsRevision, setAgentsRevision] = createSignal(0);
  return (
    <I18nProvider>
      <QueryClientProvider client={queryClient}>
        <AgentAuthenticationProvider>
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
        </AgentAuthenticationProvider>
      </QueryClientProvider>
    </I18nProvider>
  );
}
