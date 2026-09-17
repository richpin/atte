# Atte 첫 버전 구현 명세

Status: ready-for-agent

## Problem Statement

코딩 에이전트마다 설치, 인증, 대화 화면과 실행 상태가 달라 사용자는 여러 도구를 오가며 작업해야 한다. 대화 기록과 실제 에이전트 상태도 서로 분리되어 있어 앱을 닫았다 다시 열거나 여러 작업을 동시에 진행할 때 작업의 연속성을 잃기 쉽다.

Atte의 첫 버전은 macOS에서 Claude, Codex, Antigravity를 같은 사용 방식으로 다루고, 작업 폴더별 대화를 만들고 이어가며, 여러 대화의 실행과 승인 요청을 독립적으로 관리할 수 있어야 한다. 단순히 과거 메시지를 다시 보여주는 것만으로는 부족하다. 에이전트가 지원할 때 기존 맥락을 실제로 이어가는 대화 재개가 필요하다.

## Solution

Atte는 ACP Registry에서 지원 에이전트를 설치·관리하는 별도 화면과, 작업 폴더별 대화를 탐색하고 실행하는 통합 대화 화면을 제공한다. 사용자는 작업 폴더와 설치된 에이전트를 골라 대화를 시작하며, 선택한 에이전트는 해당 대화에 고정된다.

Rust Core가 에이전트 프로세스, ACP 연결, 대화 실행 상태, 승인 요청, 취소, 대기 메시지, 영속 데이터와 앱 수명주기를 소유한다. SolidJS UI는 Rust가 제공하는 대화 snapshot과 순서가 보장된 변경 스트림을 표시하고 사용자 의도를 좁은 Tauri 인터페이스로 전달한다.

Atte는 표시용 대화 기록과 에이전트의 원격 세션 식별자를 함께 보관한다. 앱 재실행 시 기록을 즉시 열람할 수 있고, 사용자가 다음 메시지를 보낼 때 에이전트 capability와 인증 상태를 확인하여 실제 대화를 재개한다. 중단된 작업을 임의로 다시 실행하거나 승인 요청을 자동 허용하지 않는다.

## User Stories

1. As an Atte user, I want to see the agent management screen when no agent is installed, so that I know what must be prepared before starting a conversation.
2. As an Atte user, I want to see Claude, Codex, and Antigravity in one agent catalog, so that I can manage the initially supported agents consistently.
3. As an Atte user, I want agents to be obtained from the ACP Registry, so that installation uses the protocol ecosystem's official distribution metadata.
4. As an Atte user, I want installation state, connection state, authentication state, and conversation readiness shown separately, so that one successful step is not mistaken for another.
5. As an Atte user, I want to install and authenticate an agent from a dedicated management screen, so that setup does not clutter conversations.
6. As an Atte user, I want authentication guidance to reflect the selected agent's advertised methods, so that I can complete the correct login flow.
7. As an Atte user, I want my saved history to remain readable when an agent is missing or authentication expires, so that local records are not held hostage by runtime availability.
8. As an Atte user, I want to choose a local working folder before starting a conversation, so that every agent knows the intended project context.
9. As an Atte user, I want to choose one installed agent when creating a conversation, so that the conversation has an explicit executor.
10. As an Atte user, I want the selected agent fixed for the life of a conversation, so that its context and capabilities remain coherent.
11. As an Atte user, I want to create another conversation in the same working folder with a different agent, so that I can use another tool without mutating an existing conversation.
12. As an Atte user, I want a project-level plus button to start a conversation directly in that working folder, so that repeated folder selection is unnecessary.
13. As an Atte user, I want project headings to expand and collapse with a visible indicator, so that I can manage a long conversation list.
14. As an Atte user, I want to collapse and reopen the sidebar from its top-right control, so that I can prioritize conversation space without losing navigation.
15. As an Atte user, I want to send a message and see the agent response stream as it arrives, so that long-running work gives immediate feedback.
16. As an Atte user, I want my messages right-aligned in rounded bubbles and agent responses to use the conversation width, so that the two roles are easy to scan.
17. As an Atte user, I want agent responses shown without repetitive agent-name headers, so that the transcript remains focused on content.
18. As an Atte user, I want a compact one-line conversation header, so that title and status are available without consuming working space.
19. As an Atte user, I want to switch to another conversation while work continues, so that one long-running task does not block the rest of the app.
20. As an Atte user, I want conversation-list status indicators for running and approval-waiting work, so that attention requests remain discoverable from elsewhere.
21. As an Atte user, I want multiple conversations to run independently, including conversations in the same working folder, so that unrelated work can proceed concurrently.
22. As an Atte user, I want output routed only to its originating conversation, so that simultaneous agent responses never mix.
23. As an Atte user, I want cancelling one conversation's current work to leave other conversations running, so that cancellation has a precise scope.
24. As an Atte user, I want to stop the current turn without deleting the conversation or its history, so that I can redirect work safely.
25. As an Atte user, I want a message sent during active work to become a queued message, so that I can leave the next instruction without interrupting the current turn.
26. As an Atte user, I want a queued message sent automatically after the current turn completes, so that sequential work continues without repeated attention.
27. As an Atte user, I want to delete a queued message before it is sent, so that I can retract an obsolete instruction.
28. As an Atte user, I want queued messages shown as a compact content-and-delete row, so that they remain visible without dominating the composer.
29. As an Atte user, I want long queued messages truncated with an option to expand them, so that compact display does not hide their full meaning.
30. As an Atte user, I want an agent's approval request to replace the composer temporarily, so that the decision appears at the point where my next action belongs.
31. As an Atte user, I want the approval request to show the requested action, working folder, and agent-provided choices, so that I can make an informed decision.
32. As an Atte user, I want approval choices displayed in the order and wording supplied by the agent, so that Atte does not invent unsafe protocol semantics.
33. As an Atte user, I want approval actions aligned with the selected working-folder line, so that the approval surface stays compact.
34. As an Atte user, I want the normal composer restored after approval or rejection, so that the conversation can continue naturally.
35. As an Atte user, I want Atte never to auto-approve a request, so that tool execution always follows an explicit user or agent policy decision.
36. As an Atte user, I want to cancel a turn while approval is pending, so that a blocked request does not trap the conversation.
37. As an Atte user, I want an approval request in one conversation not to block another conversation, so that independent work remains usable.
38. As an Atte user, I want conversations and display history restored when the app launches, so that I can orient myself before reconnecting an agent.
39. As an Atte user, I want an existing conversation to resume the agent's real prior context when supported, so that continuing work is more than replaying visible history.
40. As an Atte user, I want a clear error when an agent cannot resume a conversation, so that local history is not presented as proof of restored agent context.
41. As an Atte user, I want authentication requested only when reconnection or continuation requires it, so that offline history remains immediately available.
42. As an Atte user, I want connection failure and agent-process exit reflected in every affected conversation, so that stale running indicators do not mislead me.
43. As an Atte user, I want an explicit retry after a connection failure, so that Atte does not repeatedly restart agents without my awareness.
44. As an Atte user, I want closing the last window to leave active work running, so that ordinary macOS window management does not cancel tasks.
45. As an Atte user, I want quitting the app with active work to request confirmation, so that process termination is deliberate.
46. As an Atte user, I want confirmed app quit to stop active turns and clean up child processes, so that no agent processes are orphaned.
47. As an Atte user, I want app relaunch not to auto-run interrupted work, so that potentially mutating instructions are never replayed silently.
48. As an Atte user, I want conversation titles and project grouping restored across launches, so that navigation remains stable.
49. As an Atte user, I want the first version verified with my authenticated Codex setup, so that the implemented end-to-end path has real protocol evidence.
50. As an Atte user, I want Claude and Antigravity represented through the same ACP behavior rather than Codex-specific assumptions, so that I can validate them later without redesigning the product.

## Implementation Decisions

- The first version is a multi-slice build. The first tracer bullet ends at working folder selection, Codex-backed conversation creation, message send, and streamed response display. It is not the first-version completion boundary; persistence, actual resumption, independent concurrent conversations, queueing, approval, cancellation, lifecycle behavior, and agent management remain required.
- The Rust Core owns OS access, child processes, ACP connections, authentication coordination, durable data, conversation execution state, and shutdown. The SolidJS frontend owns presentation state such as the selected conversation, expanded project groups, sidebar visibility, composer text, and temporary visual disclosure.
- A deep conversation application module is the primary seam for both Tauri and integration tests. Its interface exposes user-level operations: inspect current state, create/open a conversation, send or queue a message, delete a queued message, cancel the active turn, answer an approval request, retry a failed connection, and subscribe to ordered changes. Callers do not construct ACP requests or manage processes.
- Tauri commands are narrow adapters over the conversation application interface. Long-running ordered output uses a channel; small application notifications may use events. Subscription begins with a consistent snapshot and then ordered changes carrying a monotonic revision so reopening a screen cannot miss a transition between snapshot and stream.
- The product uses the official Rust ACP SDK's stable protocol surface over stdio. Draft protocol-v2 and other unstable features are excluded unless a later ticket establishes a requirement. The earlier TypeScript probe remains validation evidence, not product code.
- Claude, Codex, and Antigravity share one ACP client implementation. Agent-specific launch commands, arguments, environment preparation, Registry distribution handling, and unavoidable compatibility behavior live in agent definitions at the outer adapter. Conversation execution does not hardcode Codex mode IDs, permission option IDs, or response shapes beyond the ACP contract.
- Atte consumes agent-advertised capabilities and values. It checks session load/resume support before attempting real conversation resumption, uses the modes returned by the session, and returns the exact permission option identifier selected by the user.
- Creating a new conversation automatically starts its ACP connection and session preparation. No initial connect button is shown. A reconnect action is shown only after failure, and recovery remains user-triggered.
- Installation, connection, authentication, and conversation readiness are distinct states. A process that initialized or a session that was created does not imply authentication is complete.
- Agent installation is managed from a separate screen using ACP Registry metadata. Installed artifacts and their resolved versions are tracked locally. If no supported agent is installed, conversation creation routes to agent management.
- A conversation has an Atte-owned stable identifier separate from the agent-issued session identifier. It records one working folder and one fixed agent. Remote identifiers are scoped by their connection/agent identity so equal strings from different agents cannot collide.
- Runtime status distinguishes at least idle, running, waiting for approval, connection failure, authentication required, cancelled, and unavailable. Status transitions belong to Rust; the frontend renders them without independently reconstructing protocol state.
- One turn may run per conversation. Messages submitted during a non-idle turn become ordered queued messages. The next queued message is submitted only after the prior turn ends successfully; cancellation, failure, authentication loss, and unresolved approval do not silently drain the queue.
- A queued message is persisted until sent or deleted. It is not editable in the first version. The UI shows one compact row per queued message, truncates long content, supports expand/collapse, and provides only a delete action.
- Turn cancellation, conversation closure, record deletion, connection termination, and application quit are separate operations. Cancelling sends a session-scoped ACP cancellation and does not kill a shared connection or alter another conversation.
- Each turn and connection generation is identified internally. Late output from a cancelled turn or replaced connection cannot mutate the current conversation snapshot.
- Connection ownership is hidden behind the agent runtime module. Connections may be reused for conversations with the same agent, working scope, and execution configuration when supported, while the module may isolate agents that require separate processes. The frontend and stored conversation model do not depend on a fixed one-process-per-conversation or one-process-per-app policy.
- A connection failure updates every conversation using that connection. Recovery is user-triggered. Resumption re-establishes subscriptions before loading a session so early replay events cannot be lost, and duplicate concurrent load attempts for the same conversation are coalesced.
- Display history is stored by Atte independently of agent availability. Actual conversation resumption uses the agent's persisted session and declared capability; replaying Atte's display history is never treated as rebuilding agent context.
- Durable storage includes installed-agent metadata, working folders, conversation metadata, remote session references, display messages and relevant tool/approval records, queued messages, timestamps, and terminal interruption/error state. Storage is Rust-owned, versioned through migrations, and accessed behind a storage interface. The concrete embedded database library is selected in the storage ticket after checking current maintained dependencies.
- Streaming text is stored and emitted as ordered content updates. Persistence commits enough information to rebuild the final display after restart; the UI may coalesce rendering updates but cannot discard protocol order.
- Approval requests belong to their conversation. The composer is replaced by a compact approval surface showing request context and agent-supplied choices. The working-folder label and actions share one footer row. A conversation-list indicator exposes approval waiting outside the selected conversation.
- Atte never synthesizes or automatically chooses a permission option. If a turn is cancelled while permission is pending, the pending request is resolved as cancelled according to ACP and the requested action must not execute.
- Closing a window is distinct from quitting the application. Rust-owned work remains active with no visible window. A full quit with active turns requires confirmation; confirmed quit cancels turns, resolves pending approvals, persists terminal state, and reaps managed child processes. Relaunch restores history and statuses but never replays interrupted prompts.
- The production frontend follows Feature-Sliced Design and Solid's fine-grained reactivity rules. The selected A/Workspace prototype is rewritten as production code rather than merged wholesale. Its durable decisions are project-grouped navigation, collapsible project rows with project-level creation, collapsible sidebar, compact header, right-aligned user bubbles, full-width unlabeled agent responses, compact queue rows, and composer-position approval.
- The first version targets macOS. Capabilities and command scopes follow least privilege: working-folder inputs are validated again in Rust, agent processes receive only intentional arguments and environment, and the frontend is not given general shell or filesystem primitives.
- First-version support claims distinguish implementation from verification. Codex is the real end-to-end validation target in the current authenticated environment. Claude and Antigravity must use the same common ACP paths, but their unverified authenticated behaviors remain explicitly marked until the user validates them.

## Testing Decisions

- A good test crosses a public interface and asserts user-observable state, emitted output, persisted recovery, or external protocol behavior. Tests do not assert private helper calls, lock layout, task counts, or FSD file placement.
- The primary automated seam is the Rust conversation application interface. A controllable fake ACP agent executable drives complete scenarios without a Tauri window: creation, streaming, completion, cancellation, approval, connection exit, authentication errors, session loading, multiple conversations, queued messages, and late events.
- The fake agent speaks actual ACP framing over stdio. It can pause at deterministic protocol points, emit interleaved output for multiple session identifiers, request permission with arbitrary option identifiers, exit unexpectedly, replay updates before a load response, and send stale output after cancellation. This verifies the integration contract rather than mocking every Rust function.
- Conversation application tests assert snapshots and ordered revisions. Re-subscribing during a running turn must produce one coherent current snapshot followed by every later transition with no gap or duplicate application.
- Concurrency tests verify that two conversations can run through one supported connection, output never crosses conversation identifiers, cancelling one does not cancel the other, and an approval wait in one does not prevent progress in another.
- Queue tests verify FIFO submission after successful completion, deletion before submission, persistence across application reconstruction, and non-draining after cancellation, connection failure, or authentication failure.
- Permission tests use option identifiers invented by the fake agent to prove common code does not rely on Codex-specific IDs. They verify allow, reject when supplied, cancellation, composer restoration state, and non-execution after cancellation.
- Persistence tests construct the Rust application over a temporary store, create conversations and messages, reconstruct the application, and assert immediate history visibility plus the correct distinction between readable history and resumable agent state. Migration tests open the oldest committed schema fixture supported by the first version.
- Lifecycle tests exercise window-close versus application-quit decisions through the Rust application interface and a thin Tauri adapter test where needed. They verify that window closure preserves work, quit reports active work, confirmed quit cancels and reaps processes, and restart never resubmits interrupted prompts.
- SolidJS tests use the existing Testing Library and Vitest style. The Tauri adapter is replaced at the frontend seam, and tests operate through accessible controls to verify routing to agent management, folder/agent creation flow, project collapse and plus creation, sidebar toggle, message alignment structure, queue expansion/deletion, status indicators, approval replacement, and composer restoration.
- UI tests assert roles, labels, visible content, enabled state, and dispatched user intentions rather than CSS implementation details. A small number of browser checks validate the chosen layout and responsive behavior because visual hierarchy cannot be proven through DOM assertions alone.
- Existing Rust unit-test and Solid component-test patterns are retained as prior art, but the new highest-value coverage moves to the conversation application seam rather than adding tests around the starter greeting functions.
- Real-agent acceptance testing runs only against the authenticated Codex environment initially. It covers initialize, create, prompt/stream, cancel, concurrent conversations, permission allow, permission-pending cancellation, process restart, session load, and context continuation. It records adapter version, steps, observed result, and unsupported or unverified claims.
- Claude and Antigravity acceptance matrices retain “unverified” rather than being inferred from capability advertisement or Codex success. Their authentication and remaining scenarios can be completed by the user later without changing the common automated suite.
- Each implementation ticket adds the smallest red test at the highest available seam, makes it pass, and preserves all earlier tracer-bullet behavior. The complete repository validation includes frontend checks, type checking, frontend tests, Rust formatting/linting, Rust tests, and a production Tauri build appropriate to the ticket.

## Out of Scope

- Automatically creating a Git worktree for every conversation.
- Worktree creation triggered by the first file mutation. This remains a required follow-up design after the core behaviors are verified.
- Importing conversations created in external tools or listing every pre-existing agent session.
- Moving context or a conversation between different agents.
- Changing the agent assigned to an existing conversation.
- Reconstructing an agent's internal context solely from Atte's display history when the agent cannot load the original session.
- Automatically restarting interrupted turns after application relaunch.
- Automatically approving tool execution or inventing permanent approval policies not supplied by the agent.
- Guaranteeing that all providers perform model inference in parallel; Atte guarantees independent requests, routing, and cancellation only.
- Complete authenticated compatibility certification for Claude and Antigravity before the user performs their remaining login-dependent validation.
- Non-macOS product support in the first version.
- Remote projects, remote hosts, cloud synchronization, team collaboration, shared conversations, and external issue-tracker integration.
- A generic non-ACP agent backend abstraction before a second protocol demonstrates a real varying implementation.
- Draft ACP protocol-v2 features, MCP-over-ACP, proxy/conductor chains, and unrelated Registry agents.
- Production promotion of the throwaway prototype source code or its development-only variant switcher and evaluation toolbar.

## Further Notes

- Product terminology comes from the repository domain glossary. In particular, “대화” is the user-facing durable concept; “세션” refers only to the agent protocol object when necessary.
- The ACP validation prototype is preserved on `codex/prototype-acp-validation`. Its key evidence commits are `59d4e437e9193576f6c2a123a77214929a8078d1` and `65023dc16fc7d62e6065082f11e138e4b9f8385d`.
- The UI prototype is preserved on `codex/prototype-ui`; the chosen refinements end at commit `b591a6e`.
- The [official ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) provides the product's protocol types and stable client surface. Dependency versions are pinned by each implementation ticket after checking the current release and compatibility.
- The next step is `/to-tickets`, producing tracer-bullet issue files with explicit blocking edges. Tickets should grow a working product end to end rather than completing the entire backend before beginning the UI.
