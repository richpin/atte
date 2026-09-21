Status: ready-for-agent

# ACP 에이전트 인증 흐름

## Problem Statement

Atte의 백엔드는 ACP 에이전트가 광고한 인증 방법을 조회하고 로그인을 실행할 수 있지만, 사용자가 이를 실행할 프런트엔드 흐름이 없다. 인증이 필요한 스레드는 입력창이 비활성화된 실패 상태로 남고, 사용자는 어디서 어떻게 로그인해야 하는지 바로 알 수 없다.

에이전트 관리 페이지는 설치와 삭제만 제공하며, 이미 로그인된 계정의 정보를 확인하거나 로그아웃할 수도 없다. ACP는 capability를 통해 로그아웃 지원 여부를 제공하지만 실행 중인 작업의 종료를 보장하지 않고, 표준 ACP는 이메일과 요금제를 제공하지 않는다. 따라서 인증을 에이전트 단위의 공유 상태로 다루고, 에이전트가 실제로 광고한 능력만 노출하는 흐름이 필요하다.

## Solution

스레드가 실제 `authenticationRequired` 응답을 받으면 `ThreadComposer`의 프롬프트 입력을 에이전트가 ACP로 제공한 로그인 방법 버튼으로 교체한다. 인증 방법은 즉시 조회하고, 조회 중·실패·로그인 중·취소 상태를 Composer 안에서 처리한다. 인증 상태와 작업은 스레드가 아닌 에이전트 단위로 공유하여, 같은 에이전트를 쓰는 여러 스레드가 중복 로그인을 시작하지 않게 한다.

로그인이 완료될 때 시작한 스레드를 아직 보고 있으면 즉시 자동 재연결한다. 다른 스레드로 이동했다면 아무 스레드도 백그라운드에서 재연결하지 않고, 사용자가 해당 에이전트의 인증 실패 스레드를 다시 선택할 때 한 번 자동 재연결한다. 작성 중이던 초안과 대기 메시지는 보존하되 자동 전송하지 않는다.

에이전트 관리 페이지는 로그인 수단을 제공하지 않는다. 현재 앱 실행 중 로그인이 확인된 에이전트에 한해, 확장을 통해 제공된 계정 이메일과 요금제를 보여주고 ACP logout capability가 있으면 확인 대화상자를 거쳐 로그아웃한다. 로그아웃은 ACP에 위임하며 Atte가 기존 스레드나 실행 중인 작업을 강제로 종료하지 않는다.

## User Stories

1. As an Atte user, I want a thread that requires authentication to show login actions where I normally write a prompt, so that I can recover without leaving the thread.
2. As an Atte user, I want the prompt input replaced only after the agent actually reports that authentication is required, so that an unknown status does not block a usable thread.
3. As an Atte user, I want Atte to load login methods automatically, so that I do not need an extra discovery action.
4. As an Atte user, I want to see a loading state while login methods are being discovered, so that I understand why the composer is temporarily unavailable.
5. As an Atte user, I want a discovery failure explained inside the composer, so that it is not confused with a new thread failure.
6. As an Atte user, I want to retry login-method discovery after a temporary failure, so that I can recover in place.
7. As an Atte user, I want every supported login method advertised by the agent to appear as a button, so that I can choose among the methods the agent supports.
8. As an Atte user, I want login methods to retain the order supplied by the agent, so that Atte does not invent a preferred provider flow.
9. As an Atte user, I want each login button to use the agent-provided method name, so that the action matches the provider's terminology.
10. As an Atte user, I want an agent-provided method description shown as supporting text, so that I can distinguish unfamiliar login choices.
11. As an Atte user, I want all login choices replaced by one progress state after selecting a method, so that I cannot accidentally start a second login.
12. As an Atte user, I want the active authentication method named in the progress state, so that I know which flow is running.
13. As an Atte user, I want to cancel a long-running login, so that a Terminal or browser flow does not leave Atte blocked for its full timeout.
14. As an Atte user, I want cancelling login to restore the available login buttons, so that I can retry or select another method.
15. As an Atte user, I want a late result from a cancelled login ignored, so that cancelled work cannot unexpectedly reconnect a thread.
16. As an Atte user, I want to navigate to another thread while login continues, so that authentication does not lock the rest of the app.
17. As an Atte user, I want login state shared by every thread using the same agent, so that I do not start duplicate authentication for one account.
18. As an Atte user, I want another authentication-required thread for the same agent to show the shared progress and cancel action, so that the UI reflects the single agent-level operation.
19. As an Atte user, I want cancelling the shared authentication from any affected thread to cancel the same agent-level wait, so that multiple composers cannot disagree about its state.
20. As an Atte user, I want the originating thread reconnected automatically when it is still selected at login completion, so that I can continue without pressing another reconnect button.
21. As an Atte user, I want no background thread reconnected when I have navigated elsewhere, so that authentication does not consume resources by reopening unused work.
22. As an Atte user, I want an authentication-failed thread to reconnect once when I select it after a successful shared login, so that recovery remains automatic but lazy.
23. As an Atte user, I want a repeated authentication-required result to restore the login UI, so that expired or unsuccessful credentials remain recoverable.
24. As an Atte user, I want a non-authentication reconnection failure to use the ordinary connection failure UI, so that unrelated failures are not presented as login problems.
25. As an Atte user, I want my draft preserved while the composer shows authentication, so that login does not erase work I had not sent.
26. As an Atte user, I want queued messages to remain visible while authentication is required, so that I can see work waiting behind the failure.
27. As an Atte user, I want neither my restored draft nor queued messages sent automatically after login, so that authentication cannot trigger unintended agent work.
28. As an Atte user, I want the timeline to retain the authentication failure explanation, so that I understand why the composer changed.
29. As an Atte user, I want duplicate login-navigation and reconnect actions removed from the timeline, so that authentication has one clear interaction point.
30. As an Atte user, I want an unauthenticated or unverified agent card to omit authentication controls, so that the management page stays focused and uncluttered.
31. As an Atte user, I want a confirmed logged-in agent card to show its account email when the agent provides it, so that I can identify the active account.
32. As an Atte user, I want a confirmed logged-in agent card to show its plan when the agent provides it, so that I can understand the active service tier.
33. As an Atte user, I want missing email or plan data omitted without a warning, so that optional metadata does not create a false error.
34. As an Atte user, I want logout offered only when the agent advertises ACP logout support, so that Atte never invokes an unsupported operation.
35. As an Atte user, I want a logout button even when no account metadata is available, so that missing optional identity data does not prevent logout.
36. As an Atte user, I want logout confirmed using the agent name, so that I understand which agent account is affected without relying on optional email data.
37. As an Atte user, I want the logout action disabled while its request is pending, so that I cannot send duplicate logout requests.
38. As an Atte user, I want account information removed only after logout succeeds, so that the UI does not claim a failed logout took effect.
39. As an Atte user, I want account information retained with an inline error when logout fails, so that I can retry without losing the known state.
40. As an Atte user, I want existing threads left intact after logout, so that Atte does not assume how the agent treats active ACP sessions.
41. As an Atte user, I want a later authentication-required response after logout to switch that thread's composer to login, so that the UI follows actual agent behavior.
42. As an Atte user, I want Atte to avoid launching every installed agent at app startup merely to discover login state, so that startup remains lightweight.
43. As an Atte user, I want account information to appear after login or a successful authenticated connection supplies evidence, so that management reflects what Atte has actually observed.
44. As an agent author, I want Atte to treat authentication as an agent-level concern, so that all threads using my agent share one coherent login state.
45. As an agent author, I want Atte to use advertised ACP authentication and logout capabilities, so that provider-specific assumptions do not govern the standard flow.
46. As an agent author, I want unknown authentication kinds rejected rather than interpreted as a known login flow, so that future protocol extensions remain safe.
47. As an agent author, I want optional account metadata consumed only from an explicitly supported extension, so that non-standard data is never assumed to be universal ACP behavior.

## Implementation Decisions

- Authentication is an agent-level domain concern. A single shared authentication state and at most one active authentication operation exist per agent, even when several threads use that agent.
- A composer enters authentication UI only when its thread has an authoritative authentication-required failure. The internal `unknown` authentication evidence is never presented as logged out and does not replace an otherwise usable prompt input.
- On an authentication-required failure, the frontend automatically requests the agent's advertised login methods. Discovery is represented as a shared agent-level loading, success, or error state rather than duplicated component-local state.
- The existing setup ACP connection remains separate from thread runtimes. Authentication discovery and login do not reuse, replace, or implicitly reconnect a thread runtime.
- The existing authentication command contract continues to accept an agent ID and an optional method ID. A discovery request omits the method, while a login request supplies the exact opaque method ID advertised by the agent.
- Only authentication kinds that Atte explicitly supports are actionable. Unknown discriminators remain preserved as unsupported and are never interpreted as an agent login.
- Supported methods are rendered in agent-provided order with their names and optional descriptions. Atte does not infer a recommended or default method.
- The product assumes all shipped supported agents expose at least one authentication method usable by Atte. A dedicated empty-method recovery action is not added in this scope.
- Starting login replaces the method buttons with one shared progress presentation containing the chosen method name and a cancel action. Repeated starts for the same agent are rejected or joined rather than creating concurrent operations.
- Authentication cancellation is agent-scoped. It releases Atte's wait and setup resources, re-enables login choices for all affected composers, and invalidates the operation generation so that late completion cannot mutate visible state.
- For a Terminal authentication method, cancellation does not close Terminal or guarantee termination of a provider command that Terminal already started. A provider login may complete externally after Atte has stopped waiting; its cancelled result is ignored.
- Navigating between threads does not cancel authentication. The operation owner records the originating thread without binding completion to whichever thread happens to be selected later.
- When login succeeds, the backend records authenticated evidence for the agent. Existing failed thread snapshots are not fabricated into ready state; each thread still reconnects through the normal connection path.
- If the originating thread is still selected when login completes, the frontend immediately requests its reconnection once. If another thread is selected, no thread reconnects at completion.
- Selecting an authentication-failed thread whose agent has subsequently obtained authenticated evidence triggers one lazy automatic reconnect. This applies to the origin and to other threads using the same agent.
- Automatic reconnection clears neither drafts nor queued messages and does not submit them. Draft state remains local UI state in accordance with ADR 0001, while visible thread state continues to come from the thread subscription.
- If automatic reconnection again reports authentication required, the composer returns to method discovery and login. Other connection failures retain the existing general failure and manual reconnect flow.
- The timeline keeps the explanatory authentication failure alert. Its management-navigation and authentication-state reconnect buttons are removed so the composer is the only login action surface.
- Queued messages remain visible above the composer authentication UI. The prompt input and its ordinary ready footer are replaced for the duration of the authentication-required flow.
- Frontend authentication orchestration is shared above individual composer instances and keyed by agent ID. Composer components receive derived display state and user actions; they do not own independent authentication processes.
- Backend authentication orchestration owns per-agent mutual exclusion, cancellation, capability data, account evidence, and stale-result protection. Frontend promise completion alone is not authoritative for a cancelled or superseded operation.
- Agent management exposes no login controls and no logged-out placeholder. Its authentication area is absent unless the current app run has positive authenticated evidence.
- App startup does not execute every installed agent to discover credentials. A successful login or authenticated thread interaction establishes evidence; an app restart may therefore hide a valid external login until an agent connection confirms it.
- The agent authentication view model adds logout capability and optional account email and plan. Account label is not displayed. Email and plan are independent optional values and missing fields are omitted without fallback warnings.
- ACP v1 logout is capability-gated. Atte calls logout only when the agent advertises `agentCapabilities.auth.logout`; the pinned ACP dependency already contains the standard logout request and response types.
- Standard ACP does not define account identity. Email and plan are consumed only from an explicitly recognized, capability-negotiated agent extension such as Codex ACP auth status metadata and notification updates. Other agents remain fully usable without account metadata.
- Account metadata received from an agent is untrusted display data and is rendered as text. It is not used as an identifier, authorization decision, or capability signal.
- Logout confirmation always names the agent rather than the optional email. The logout button is disabled while the request is pending.
- A successful logout immediately clears cached account presentation and positive authenticated evidence for management, but does not force thread snapshots into authentication failure, cancel turns, terminate runtimes, reconnect sessions, or remove drafts and queued messages.
- The fate of active ACP sessions and running work after logout is delegated to the agent. Atte guarantees the logout request and its UI result, not immediate task termination.
- A logout failure preserves the last confirmed account information and logout action and exposes an inline management error. Only a successful response removes the area.
- Thread-visible status changes continue to arrive through thread subscriptions. Authentication and logout commands do not return replacement thread snapshots, preserving ADR 0001's single-source rule.
- No authentication state or account metadata is persisted to the database. No schema change or migration is required.
- Frontend code follows Feature-Sliced Design: ACP authentication transport is exposed through a reusable domain/API boundary, agent-level orchestration is not owned by an individual page component, and the thread and management UIs consume that shared boundary.
- SolidJS derives composer and management presentation from shared reactive authentication state and thread snapshots. It does not mirror derived authentication state into independent component signals.

## Testing Decisions

- Tests assert externally observable protocol and user behavior rather than private maps, signal layout, helper calls, component structure, or exact task implementation.
- Two existing high-level seams are used because the Rust ACP boundary and SolidJS application boundary exercise different externally observable contracts. No new desktop end-to-end harness or test-only production seam is introduced.
- The frontend seam is the existing app-level SolidJS test harness with Tauri commands and thread subscription updates replaced at their boundary. It covers complete user flows across the thread page, composer, navigation, and agent management page.
- Frontend coverage verifies that only an authentication-required failure replaces the prompt input; an unknown authentication state does not.
- Frontend coverage verifies automatic method discovery, discovery loading, inline discovery failure, retry, agent-provided order, names, descriptions, and accessible button state.
- Frontend coverage verifies that selecting a method produces one shared progress state, prevents duplicate login starts, names the selected method, and exposes cancellation.
- Frontend coverage verifies that authentication progress is shared between multiple authentication-failed threads using the same agent and that cancellation from either view restores both.
- Frontend coverage verifies that changing the selected thread does not cancel login and that late completion from a cancelled or superseded attempt causes no navigation, connection, or UI mutation.
- Frontend coverage verifies immediate reconnection only when the originating thread remains selected at successful completion.
- Frontend coverage verifies that successful login while another thread is selected performs no background reconnect, and that selecting an affected thread later performs one lazy reconnect.
- Frontend coverage verifies that a repeated authentication-required result restores login actions, while a different connection failure uses the ordinary failure and reconnect presentation.
- Frontend coverage verifies draft preservation, queued-message visibility, and the absence of automatic draft or queued-message submission after login and reconnection.
- Frontend coverage verifies that the timeline retains the authentication explanation but omits duplicate management-navigation and authentication reconnect actions.
- Frontend coverage verifies that unverified and logged-out agent cards have no authentication area.
- Frontend coverage verifies the management combinations of email and plan, email only, plan only, and neither field with a supported logout action.
- Frontend coverage verifies capability-gated logout, agent-name confirmation, pending-button disabling, successful account removal, and failed logout state preservation with an inline error.
- Frontend coverage verifies that logout does not eagerly convert existing thread UI into authentication failure and that a later subscribed authentication-required state activates composer login.
- Frontend accessibility coverage uses roles and accessible names to exercise method selection, progress, cancellation, retry, confirmation, and logout without relying on CSS selectors or implementation-specific markup.
- The backend seam is the existing Rust integration harness that connects thread and agent-management services to the deterministic ACP fixture. It exercises real ACP JSON-RPC initialization, authentication, logout, notifications, cancellation, and shared evidence.
- Backend coverage verifies that discovery preserves advertised IDs, names, descriptions, order, terminal classification, and supported status without provider-name assumptions.
- Backend coverage verifies agent and macOS Terminal authentication success and failure through the supported protocol paths.
- Backend coverage verifies per-agent mutual exclusion or joining so two threads cannot create simultaneous login operations for the same agent.
- Backend coverage verifies cancellation releases the per-agent operation, stops Atte-owned setup resources, and prevents a late result from recording authenticated evidence.
- Backend coverage verifies that successful authentication updates shared agent evidence but does not directly turn failed threads into ready threads or send queued messages.
- Backend coverage verifies that successful thread activity can refresh shared authenticated evidence and that authentication-required failures invalidate it.
- Backend coverage verifies lazy reconnect prerequisites for multiple threads using one agent without starting their runtimes in the background.
- Backend coverage verifies logout is sent only when advertised, uses the standard ACP request, and reports unsupported and failed requests without clearing confirmed account state.
- Backend coverage verifies successful logout clears management authentication evidence without cancelling active turns or fabricating authentication failures for existing threads.
- Backend coverage verifies recognized account-status extension negotiation and updates for email and plan while ignoring unrecognized metadata safely.
- Backend coverage verifies app restart begins without persisted authentication or account evidence and does not launch installed agents solely to inspect credentials.
- Existing tests for prompt submission, permission input, queued messages, subscription recovery, authentication expiry, installation management, and unknown authentication kinds remain passing to demonstrate that the new flow preserves established behavior.

## Out of Scope

- Login controls or logged-out status text on the agent management page
- Treating an unknown authentication state as logged out
- Launching every installed agent at startup to discover external login state
- Persisting authentication evidence, credentials, email, plan, or ACP account metadata
- Displaying an agent-provided account label, organization, or other profile fields
- Assuming email or plan are part of standard ACP
- Provider-specific login buttons or hardcoded authentication method order
- A recovery flow for a shipped agent with no Atte-supported authentication methods
- Automatically sending a preserved draft or queued message after authentication
- Reconnecting every thread for an agent immediately after login
- Navigating back to the originating thread when login completes elsewhere
- Guaranteeing that cancellation terminates an external Terminal or browser authentication flow
- Guaranteeing that ACP logout terminates an active turn or existing agent session
- Proactively marking every existing thread as authentication-required after logout
- Force-killing an agent runtime as part of logout
- Database schema changes or migrations
- A new desktop end-to-end test framework

## Further Notes

- ACP v1 logout is standard but capability-gated. Its success does not define what happens to sessions that were already active, so Atte deliberately observes later agent behavior rather than inventing a universal session policy.
- ACP v1 initialize, authenticate, and logout do not provide standard email or plan fields. Current Codex ACP versions provide account status through an extension; support for that extension must remain optional and capability-driven.
- A two-state presentation does not erase the backend's evidence distinction. `unknown`, authentication-required, and authenticated may remain distinct internally even though users see either an ordinary composer or an authentication composer.
- ADR 0001 remains authoritative: thread commands express intent, while thread subscriptions provide visible thread state. Agent-level authentication orchestration is shared separately and must not create a second source for thread snapshots.
- The confirmed test strategy uses the existing app-level SolidJS boundary for user flows and the existing Rust ACP fixture boundary for protocol behavior. These are the highest existing seams on either side of the Tauri boundary.
