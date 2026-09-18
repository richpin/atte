# Atte 첫 버전 구현 명세

Status: ready-for-agent

## Problem Statement

코딩 에이전트마다 설치, 인증, 대화 화면과 실행 상태가 달라 사용자는 여러 도구를 오가며 작업해야 한다. 대화 기록과 실제 에이전트 상태도 서로 분리되어 있어 앱을 닫았다 다시 열거나 여러 작업을 동시에 진행할 때 작업의 연속성을 잃기 쉽다.

Atte의 첫 버전은 macOS에서 공식 ACP Registry의 지원 배포 형식을 사용하는 에이전트를 같은 사용 방식으로 다루고, 작업 폴더별 대화를 만들고 이어가며, 여러 대화의 실행과 승인 요청을 독립적으로 관리할 수 있어야 한다. 단순히 과거 메시지를 다시 보여주는 것만으로는 부족하다. 에이전트가 지원할 때 기존 맥락을 실제로 이어가는 대화 재개가 필요하다.

## Solution

Atte는 ACP Registry에서 지원 에이전트를 설치·관리하는 별도 화면과, 작업 폴더별 대화를 탐색하고 실행하는 통합 대화 화면을 제공한다. 사용자는 작업 폴더와 설치된 에이전트를 골라 대화를 시작하며, 선택한 에이전트는 해당 대화에 고정된다.

Rust Core가 에이전트 프로세스, ACP 연결, 대화 실행 상태, 승인 요청, 취소, 대기 메시지, 영속 데이터와 앱 수명주기를 소유한다. SolidJS UI는 Rust가 제공하는 현재 대화 상태과 순서가 보장된 변경 스트림을 표시하고 사용자 의도를 좁은 Tauri 인터페이스로 전달한다.

대화 본문과 맥락의 영구 원본은 에이전트가 소유한다. Atte는 목록과 재연결에 필요한 대화 메타데이터·원격 세션 참조를 저장하고, 앱 재실행 시 목록을 즉시 표시한다. 사용자가 대화를 선택하면 에이전트 capability에 따라 load로 본문과 맥락을 복원하거나, resume으로 본문 없이 맥락만 재개한다. 본문 복원에는 에이전트 연결이 필요하며 설치·인증 상태에 따라 실패할 수 있다. 메시지·도구 출력·승인 이력 전체를 앱 DB에 복제하지 않으며, 복원만으로 새 prompt를 보내거나 중단된 작업·승인 결정을 재실행하지 않는다.

## User Stories

1. As an Atte user, I want guidance to agent management when a conversation needs an unavailable agent, so that I can prepare it without losing access to the conversation list.
2. As an Atte user, I want to discover agents from the ACP Registry in one catalog with platform compatibility shown, so that new agents can become available without an Atte code change.
3. As an Atte user, I want agents to be obtained from the ACP Registry, so that installation uses the protocol ecosystem's official distribution metadata.
4. As an Atte user, I want installation state, connection state, authentication state, and conversation readiness shown separately, so that one successful step is not mistaken for another.
5. As an Atte user, I want to install and authenticate an agent from a dedicated management screen, so that setup does not clutter conversations.
6. As an Atte user, I want authentication guidance to reflect the selected agent's advertised methods, so that I can complete the correct login flow.
7. As an Atte user, I want my conversation list to remain accessible when an agent is missing or authentication expires, with a clear recovery path when its content cannot be loaded.
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
38. As an Atte user, I want the conversation list restored when the app launches and content loaded from the agent when I open a conversation, so that Atte does not duplicate every transcript on disk.
39. As an Atte user, I want an existing conversation to resume the agent's real prior context when supported, so that continuing work is more than replaying visible history.
40. As an Atte user, I want a clear error when an agent cannot resume a conversation and a notice when it can resume without showing prior messages, so that I understand what was restored.
41. As an Atte user, I want authentication requested only when loading or continuing a conversation requires it, so that the conversation list remains immediately available.
42. As an Atte user, I want connection failure and agent-process exit reflected in every affected conversation, so that stale running indicators do not mislead me.
43. As an Atte user, I want an explicit retry after a connection failure, so that Atte does not repeatedly restart agents without my awareness.
44. As an Atte user, I want closing the last window to leave active work running, so that ordinary macOS window management does not cancel tasks.
45. As an Atte user, I want quitting the app with active work to request confirmation, so that process termination is deliberate.
46. As an Atte user, I want confirmed app quit to stop active turns and clean up child processes, so that no agent processes are orphaned.
47. As an Atte user, I want app relaunch not to auto-run interrupted work, so that potentially mutating instructions are never replayed silently.
48. As an Atte user, I want conversation titles and project grouping restored across launches, so that navigation remains stable.
49. As an Atte user, I want the first version verified with my authenticated Codex setup, so that the implemented end-to-end path has real protocol evidence.
50. As an Atte user, I want Registry agents, including Claude and Antigravity, to use common distribution and ACP behavior, so that adding an agent does not require provider-specific product code.

## Implementation Decisions

- The composer sends with Enter and inserts a newline with Shift+Enter. Enter used to confirm IME composition does not send a message. Keyboard submission uses the same readiness and duplicate-send guards as the send button.
- The first version is a multi-slice build. The first tracer bullet ends at working folder selection, Codex-backed conversation creation, message send, and streamed response display. It is not the first-version completion boundary; persistence, actual resumption, independent concurrent conversations, queueing, approval, cancellation, lifecycle behavior, and agent management remain required.
- The Rust Core owns OS access, child processes, ACP connections, authentication coordination, durable data, conversation execution state, and shutdown. The SolidJS frontend owns presentation state such as the selected conversation, expanded project groups, sidebar visibility, composer text, and temporary visual disclosure.
- A deep conversation application module is the primary seam for both Tauri and integration tests. Its interface exposes user-level operations: inspect current state, create/open a conversation, send or queue a message, delete a queued message, cancel the active turn, answer an approval request, retry a failed connection, and subscribe to ordered changes. Callers do not construct ACP requests or manage processes.
- Tauri commands are narrow adapters over the conversation application interface. Long-running ordered output uses a channel; small application notifications may use events. Subscription begins with a consistent full conversation state and then ordered changes carrying a monotonic revision so reopening a screen cannot miss a transition between the initial state and subsequent updates.
- The product uses the official Rust ACP SDK's stable protocol surface over stdio. Draft protocol-v2 and other unstable features are excluded unless a later ticket establishes a requirement. The earlier TypeScript probe remains validation evidence, not product code.
- Registry agents share one ACP client implementation. Registry metadata determines identity, launch commands, arguments, environment, and distribution. Generic distribution installers produce the existing execution definition. Authentication follows advertised methods and capabilities; unsupported behavior is reported instead of adding provider-name branches. Conversation execution does not hardcode provider mode IDs, permission option IDs, or response shapes beyond the ACP contract.
- Atte consumes agent-advertised capabilities and values. It checks session load/resume support before attempting real conversation resumption, uses the modes returned by the session, and returns the exact permission option identifier selected by the user.
- Creating a new conversation automatically starts its ACP connection and session preparation. No initial connect button is shown. A reconnect action is shown only after failure, and recovery remains user-triggered.
- Installation, connection, authentication, and conversation readiness are distinct states. A process that initialized or a session that was created does not imply authentication is complete.
- Agent management follows the Zed Registry architecture documented in docs/research/zed-registry-installation.md: a dynamic cached catalog, current-platform binary selection before npx, generic archive/package installation, and a shared managed Node runtime when needed. Binary formats include ZIP, tar.gz/tgz, tar.bz2/tbz2, and raw executables. Unsupported platforms and distribution types remain visible with reasons. No fixed provider allowlist or provider-specific download URLs are maintained.
- Agent installation is managed from a separate screen using ACP Registry metadata. Installed artifacts, Registry identities, and resolved versions are tracked locally and survive Registry refresh failures or removal of an entry. A machine without Node/npm must support npx installation through an app-managed runtime. If no usable agent is installed, conversation creation routes to agent management.
- A conversation has an Atte-owned stable identifier separate from the agent-issued session identifier. It records one working folder and one fixed agent. Persisted session references are scoped by durable agent identity, not by a transient connection generation, so they survive process restarts and equal strings from different agents cannot collide.
- Runtime status distinguishes at least idle, running, waiting for approval, connection failure, authentication required, cancelled, and unavailable. Status transitions belong to Rust; the frontend renders them without independently reconstructing protocol state.
- One turn may run per conversation. Messages submitted during a non-idle turn become ordered queued messages. The next queued message is submitted only after the prior turn ends successfully; cancellation, failure, authentication loss, and unresolved approval do not silently drain the queue.
- Queued messages remain visible after cancellation without automatic sending. They appear above the composer in FIFO order, oldest first, with a trash button at the far right of each compact row. Long content supports truncation and expand/collapse. Messages are not editable in the first version; there is no separate queue heading or sending guidance. Replacing the composer with approval UI preserves the queue.
- Persist only messages remaining in the queue, with their IDs and order. Before dispatch, remove the first item from the persisted queue; only attempt the ACP send after this write succeeds. Serialize removal for dispatch with user deletion. Do not persist dispatch attempts or uncertain-delivery states, and do not automatically reinsert or retry a removed item after a send failure. Report failures through the existing error UI. A crash between removal and sending can lose that item; lossless delivery across this boundary is not guaranteed. Remaining queue items survive restart without automatic sending. Queue payloads are not retained as local transcript history.
- Turn cancellation, conversation closure, record deletion, connection termination, and application quit are separate operations. Cancelling sends a session-scoped ACP cancellation and does not kill a shared connection or alter another conversation.
- Each turn and connection generation is identified internally. Late output from a cancelled turn or replaced connection cannot mutate the current conversation state.
- Connection ownership is hidden behind the agent runtime module. Connections may be reused for conversations with the same agent, working scope, and execution configuration when supported, while the module may isolate agents that require separate processes. The frontend and stored conversation model do not depend on a fixed one-process-per-conversation or one-process-per-app policy.
- A connection failure updates every conversation using that connection. Recovery is user-triggered. Resumption re-establishes subscriptions before loading a session so early replay events cannot be lost, and duplicate concurrent load attempts for the same conversation are coalesced.
- External conversation storage follows the [Zed source investigation](../../docs/research/zed-session-history.md): agents own durable transcripts and context; Atte stores lightweight list/reconnection metadata. Opening a known conversation connects to its agent and prefers `session/load` to reconstruct the in-memory transcript. If only `session/resume` is supported, context resumes with an explicit notice that previous messages are unavailable. If neither is supported or restoration fails, show the reason and do not substitute a new session.
- The saved list is available without agents or authentication. Content availability depends on the agent's load capability and successful connection; offline full-transcript access is not guaranteed. Listing conversations at startup does not connect every agent or load every transcript. `session/list` is independent of load/resume and is not required to restore Atte's known session references. Importing externally created sessions remains out of scope.
- Durable storage includes installed-agent metadata, working folders, conversation IDs/titles/fixed agents, remote session references, timestamps, last interruption/error metadata, and Atte-owned unsent queued messages. It excludes transcript bodies, tool outputs, and approval history; no persistent transcript cache is introduced. Extend the Rust-owned SQLite/rusqlite store from ticket 04 with versioned migrations preserving installation records.
- Streaming content and replay build an in-memory transcript and are emitted as ordered updates. Reuse an already open conversation; on reconnection rebuild from replay rather than append it to old content, and do not present a failed partial replay as complete. The UI may coalesce rendering updates but cannot discard protocol order. Avoiding disk duplication does not eliminate the memory/rendering cost of a large loaded conversation.
- Approval requests belong to their conversation. The composer is replaced by a compact approval surface showing request context and agent-supplied choices. The working-folder label and actions share one footer row. A conversation-list indicator exposes approval waiting outside the selected conversation.
- Atte never synthesizes or automatically chooses a permission option. If a turn is cancelled while permission is pending, the pending request is resolved as cancelled according to ACP and the requested action must not execute.
- Closing a window is distinct from quitting the application. Rust-owned work remains active with no visible window. A full quit with active turns requires confirmation; confirmed quit cancels turns, resolves pending approvals, persists terminal-state metadata, and reaps managed child processes. Relaunch restores the list and unsent queued messages, marks previously active work as interrupted, and never resubmits prompts or approval decisions. Opening a conversation restores agent context/content without executing a new prompt or draining its queue.
- The production frontend follows Feature-Sliced Design and Solid's fine-grained reactivity rules. The selected A/Workspace prototype is rewritten as production code rather than merged wholesale. Its durable decisions are project-grouped navigation, collapsible project rows with project-level creation, collapsible sidebar, compact header, right-aligned user bubbles, full-width unlabeled agent responses, compact queue rows, and composer-position approval.
- The first version targets macOS. Capabilities and command scopes follow least privilege: working-folder inputs are validated again in Rust, agent processes receive only intentional arguments and environment, and the frontend is not given general shell or filesystem primitives.
- First-version support claims distinguish implementation from verification. Codex is the real end-to-end validation target in the current authenticated environment. Other Registry agents, including Claude and Antigravity, use the same common paths, but catalog presence and successful installation do not imply verified authenticated compatibility.

## Testing Decisions

- A good test crosses a public interface and asserts user-observable state, emitted output, persisted recovery, or external protocol behavior. Tests do not assert private helper calls, lock layout, task counts, or FSD file placement.
- The primary automated seam is the Rust conversation application interface. A controllable fake ACP agent executable drives complete scenarios without a Tauri window: creation, streaming, completion, cancellation, approval, connection exit, authentication errors, session loading, multiple conversations, queued messages, and late events.
- The fake agent speaks actual ACP framing over stdio. It can pause at deterministic protocol points, emit interleaved output for multiple session identifiers, request permission with arbitrary option identifiers, exit unexpectedly, replay updates before a load response, and send stale output after cancellation. This verifies the integration contract rather than mocking every Rust function.
- Conversation application tests assert conversation states and ordered revisions. Re-subscribing during a running turn must produce one coherent current conversation state followed by every later transition with no gap or duplicate application.
- Concurrency tests verify that two conversations can run through one supported connection, output never crosses conversation identifiers, cancelling one does not cancel the other, and an approval wait in one does not prevent progress in another.
- Queue tests verify FIFO submission after successful completion, deletion before submission, persistence across application reconstruction, and non-draining after cancellation, connection failure, or authentication failure.
- Permission tests use option identifiers invented by the fake agent to prove common code does not rely on Codex-specific IDs. They verify allow, reject when supplied, cancellation, composer restoration state, and non-execution after cancellation.
- Persistence tests reconstruct the Rust application over a temporary store and assert immediate list visibility with preserved session references, without persisted transcript/tool/approval bodies. Content appears through agent replay after load; resume-only and unsupported agents have distinct UI outcomes. Tests cover missing agents, expired authentication, reinstall/retry, list-unsupported but load-capable agents, early/partial replay, duplicate loads, and stale output. Migration tests preserve installation records from the oldest committed schema fixture supported by the first version.
- Lifecycle tests exercise window-close versus application-quit decisions through the Rust application interface and a thin Tauri adapter test where needed. They verify that window closure preserves work, quit reports active work, confirmed quit cancels and reaps processes, and restart never resubmits interrupted prompts.
- SolidJS tests use the existing Testing Library and Vitest style. The Tauri adapter is replaced at the frontend seam, and tests operate through accessible controls to verify routing to agent management, folder/agent creation flow, project collapse and plus creation, sidebar toggle, message alignment structure, queue expansion/deletion, status indicators, approval replacement, and composer restoration.
- UI tests assert roles, labels, visible content, enabled state, and dispatched user intentions rather than CSS implementation details. A small number of browser checks validate the chosen layout and responsive behavior because visual hierarchy cannot be proven through DOM assertions alone.
- Existing Rust unit-test and Solid component-test patterns are retained as prior art, but the new highest-value coverage moves to the conversation application seam rather than adding tests around the starter greeting functions.
- Real-agent acceptance testing runs only against the authenticated Codex environment initially. It covers initialize, create, prompt/stream, cancel, concurrent conversations, permission allow, permission-pending cancellation, process restart, session load, and context continuation. It records adapter version, steps, observed result, and unsupported or unverified claims.
- Registry acceptance tests add previously unknown agent IDs and arbitrary authentication method IDs through fixtures without product-code changes. They cover distribution selection, runtime preparation without system Node, cache failures, unsupported entries, installation migration, and preservation of existing conversations. Other agents’ authenticated acceptance remains “unverified” unless actually exercised; it is never inferred from capability advertisement or Codex success.
- Each implementation ticket adds the smallest red test at the highest available seam, makes it pass, and preserves all earlier tracer-bullet behavior. The complete repository validation includes frontend checks, type checking, frontend tests, Rust formatting/linting, Rust tests, and a production Tauri build appropriate to the ticket.

## Out of Scope

- Automatically creating a Git worktree for every conversation.
- Worktree creation triggered by the first file mutation. This remains a required follow-up design after the core behaviors are verified.
- Importing conversations created in external tools or listing every pre-existing agent session.
- Persisting full external transcripts, tool outputs, or approval history in Atte, adding a disk transcript cache, or directly parsing provider-specific session files. Full content access without an available agent is not guaranteed.
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
- Draft ACP protocol-v2 features, MCP-over-ACP, and proxy/conductor chains.
- Automatic agent updates, custom registries or manual launch definitions, and distribution formats beyond binary/npx in ticket 04.
- Production promotion of the throwaway prototype source code or its development-only variant switcher and evaluation toolbar.

## Further Notes

- 2026-09-18 사용자 결정: [Zed 외부 ACP 조사](../../docs/research/zed-session-history.md)를 근거로 전체 본문 영구 복제를 제외했다. 06은 목록·재연결 메타데이터 저장과 선택 시 load/resume을 담당한다. 에이전트 부재 시 전체 본문 열람 요구는 목록 접근과 복구 안내로 대체하며, 07의 미전송 대기 메시지 저장은 유지한다. 06 구현에서 DB v2에 목록·재연결 메타데이터 저장과 선택 시 load/resume을 추가했다. 07 구현에서 DB v3에 미전송 대기 메시지 저장과 공유 연결의 복수 대화를 추가했다.
- Product terminology comes from the repository domain glossary. In particular, “대화” is the user-facing durable concept; “세션” refers only to the agent protocol object when necessary.
- The ACP validation prototype is preserved on `codex/prototype-acp-validation`. Its key evidence commits are `59d4e437e9193576f6c2a123a77214929a8078d1` and `65023dc16fc7d62e6065082f11e138e4b9f8385d`.
- The UI prototype is preserved on `codex/prototype-ui`; the chosen refinements end at commit `b591a6e`.
- The [official ACP Rust SDK](https://github.com/agentclientprotocol/rust-sdk) provides the product's protocol types and stable client surface. Dependency versions are pinned by each implementation ticket after checking the current release and compatibility.
- Tickets under issues/ have explicit blocking edges. Ticket 04 is complete for Registry-driven management, including uninstall; its earlier three-agent validation remains historical evidence. Its Comments record the expanded scope and verification results. No commits are made without an explicit user request.

## 설치된 ACP 삭제

에이전트 관리 화면에서 설치된 ACP를 확인 후 삭제할 수 있다. 해당 에이전트의 모든 연결과 진행 중인 작업을 종료한 뒤 설치 파일을 즉시 삭제한다. 파일 삭제 성공 후 설치 정보를 비우며 실패하면 설치 정보를 남겨 명시적으로 재시도할 수 있다. 대화 목록 메타데이터·원격 세션 참조, 다른 에이전트의 연결, 공용 Node 런타임, 로그인 정보와 작업 폴더는 유지하며 에이전트 소유 세션 기록을 삭제 대상으로 삼지 않는다. 삭제로 종료된 대화는 이전 실행 정의로 재연결하지 않는다. 06에서 재설치 후 현재 설치 정의로 기존 세션의 명시적 load/resume 재시도를 제공한다. 성공 여부는 에이전트의 capability와 세션 보존 여부에 따르며, 실패를 새 세션 생성으로 대체하지 않는다.

## 에이전트 아이콘

에이전트 관리 화면에서 Registry의 선택적 `icon`을 이름 옆에 표시한다. 아이콘 URL은 Registry 목록과 함께 캐시하며, 아이콘이 없거나 로딩 중이거나 불러오지 못하면 기본 아이콘을 표시한다. 공식 Registry CDN의 이미지만 허용한다.

## 에이전트 저장 구조

SQLite v1에서 도입한 `agents`에서 Registry ID당 한 행으로 Registry 메타데이터와 현재 설치 정보를 함께 관리한다. 전체 Registry 갱신 시각만 `app_metadata`에 저장한다. `installation_source`와 삭제 대기 테이블은 사용하지 않는다. Registry 갱신은 설치 정보를 덮어쓰지 않으며 정상 설치에 대한 중복 설치 요청은 기존 설치를 사용한다. 변경된 배포를 설치하려면 삭제 후 설치한다. v2는 설치 정보를 보존하면서 대화 메타데이터용 `conversations`를 추가한다. v3에서 추가했던 별도 큐 테이블은 v4에서 기존 `conversations` 행의 `queued_messages` JSON 배열 컬럼으로 통합한다. 상세 컬럼·마이그레이션·실패 처리는 [DB 구조](../../docs/database.md)를 따른다.
