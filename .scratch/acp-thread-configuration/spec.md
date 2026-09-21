Status: ready-for-agent

# ACP v1 스레드 설정 지원

## Problem Statement

Atte는 ACP 에이전트가 세션마다 제공하는 모델, 추론 수준, 동작 모드 등의 설정을 읽거나 변경할 수 없다. 사용자는 에이전트가 지원하는 모델이나 effort를 선택할 수 없고, Codex의 Ask for approval·Approve for me 같은 동작 모드도 Atte 안에서 바꿀 수 없다. 에이전트마다 설정의 종류와 선택지가 달라지거나 서로 의존할 수 있으므로, Atte가 특정 에이전트의 필드와 값을 하드코딩하는 방식으로는 일관된 사용자 경험을 제공할 수 없다.

## Solution

Atte는 에이전트가 ACP v1 `configOptions`로 광고한 스레드 설정을 범용적으로 지원한다. 에이전트가 제공한 이름, 설명, 순서, category, 선택지와 `currentValue`를 그대로 받아 입력창 하단에 표시한다. `model`, `thought_level`, `mode` category의 자주 쓰는 설정은 입력창 하단에서 바로 선택할 수 있게 하고, 그 밖의 설정은 스레드 설정 popover에서 제공한다.

사용자가 값을 선택하면 화면에는 별도의 pending 상태나 잠금을 표시하지 않고 선택값을 즉시 반영한다. 변경은 프롬프트 전송과 독립적으로 처리하며, 다른 설정과 메시지 입력도 계속 사용할 수 있다. 백엔드는 같은 스레드의 설정 요청을 순서대로 처리하고 아직 전송하지 않은 동일 설정의 선택은 마지막 값으로 합친다. 에이전트가 반환한 전체 option snapshot으로 확인 상태를 갱신하고, 뒤따르는 선택이 새 snapshot에서도 유효한지 다시 검사한다. 실패한 설정 변경만 마지막으로 확인된 값으로 되돌리고 스레드와 현재 작업은 계속 유지한다.

## User Stories

1. As an Atte user, I want to see the model offered by the current agent, so that I know which model the thread is using.
2. As an Atte user, I want to change the model from the message composer, so that I can choose the model appropriate for my next task.
3. As an Atte user, I want to see the reasoning effort offered for the selected model, so that I can balance speed and reasoning depth.
4. As an Atte user, I want to change reasoning effort from the message composer, so that I do not need to leave the thread.
5. As an Atte user, I want to see and change agent-provided operating modes, so that I can choose modes such as Ask for approval or Approve for me when the agent supports them.
6. As an Atte user, I want Atte to display the option names supplied by the agent, so that agent-specific terminology remains accurate.
7. As an Atte user, I want descriptions supplied by the agent to be available with each setting, so that I can understand unfamiliar choices before selecting them.
8. As an Atte user, I want commonly used model, reasoning, and mode controls directly below the input, so that changing them takes minimal interaction.
9. As an Atte user, I want less common settings in a compact popover, so that the composer does not become crowded.
10. As an Atte user, I want all supported select settings to work regardless of their ACP category, so that settings from different agents remain usable.
11. As an Atte user, I want grouped select choices to preserve the groups supplied by the agent, so that a large option catalogue remains understandable.
12. As an Atte user, I want boolean settings to appear as toggles, so that their state is clear and easy to change.
13. As an Atte user, I want the agent's option order preserved, so that related settings appear in the intended order.
14. As an Atte user, I want unknown categories to remain usable as ordinary settings, so that a new agent category does not hide an otherwise supported option.
15. As an Atte user, I want no settings UI when the agent advertises no config options, so that the composer remains uncluttered.
16. As an Atte user, I want a newly connected thread to show the agent's `currentValue`, so that the UI agrees with the actual ACP session.
17. As an Atte user, I want a resumed or loaded thread to show the values returned by the agent, so that Atte does not overwrite restored session state.
18. As an Atte user, I want a selection to appear immediately without a pending badge or loading lock, so that the interface feels responsive.
19. As an Atte user, I want to continue changing other settings while one change is being processed, so that slow agents do not block the composer.
20. As an Atte user, I want to continue writing and sending messages while a setting change is being processed, so that configuration latency does not interrupt my work.
21. As an Atte user, I want repeated selection of the value already displayed to make no request, so that redundant work is avoided.
22. As an Atte user, I want rapid repeated choices for the same setting to settle on my latest choice, so that intermediate clicks do not determine the final state.
23. As an Atte user, I want model-dependent settings to refresh after a model change, so that only valid effort and model configuration choices remain visible.
24. As an Atte user, I want an invalidated follow-up choice to fall back to the value supplied by the agent, so that the UI never claims an unsupported configuration.
25. As an Atte user, I want agent-initiated configuration changes to appear whether the thread is idle or running, so that the displayed settings remain accurate.
26. As an Atte user, I want a failed setting change to revert only that configuration display, so that the entire thread does not fail.
27. As an Atte user, I want a non-blocking explanation when a setting change fails, so that I understand why my selection was not retained.
28. As an Atte user, I want my current turn and queued messages to continue after a setting failure, so that configuration errors do not lose work.
29. As an Atte user, I want settings hidden or represented by a loading placeholder while the ACP session is connecting, so that stale values are not presented as current.
30. As an Atte user, I want settings to reappear from the new session snapshot after reconnection, so that reconnecting restores an authoritative view.
31. As an Atte user, I want thread mutations disabled when the frontend subscription is unavailable, so that the existing subscription safety rule also protects setting changes.
32. As a keyboard user, I want to open and operate every setting control without a pointer, so that the feature is fully accessible.
33. As a screen reader user, I want controls to expose the setting name, current displayed value, type, and disabled state, so that I can configure the thread confidently.
34. As an Atte user, I want each thread to retain only the state reported by its own ACP session, so that settings do not leak between concurrent threads.
35. As an Atte user, I want a new thread to use the agent's own defaults, so that Atte does not silently carry values over from another thread.
36. As an Atte user, I want permission prompts to remain distinct from thread settings, so that a tool-specific approval is not confused with an operating mode.
37. As an agent author, I want Atte to advertise boolean config option support, so that my agent can send native boolean settings instead of select fallbacks.
38. As an agent author, I want opaque config and value identifiers returned unchanged, so that Atte does not infer protocol semantics from labels or IDs.
39. As an agent author, I want every successful set response treated as a complete config snapshot, so that dependent options can change atomically from the client's perspective.
40. As an agent author, I want `config_option_update` notifications treated as complete snapshots, so that agent-initiated fallback or mode changes remain consistent.

## Implementation Decisions

- `Thread configuration` is the domain term and `ThreadConfiguration` is the unabridged code-level type name. `ThreadConfig`, session settings, and agent settings are not used as synonyms.
- ACP v1 `configOptions` is the only protocol surface in scope. Deprecated `modes` and `session/set_mode` are not adapted or displayed in this implementation.
- The ACP client advertises support for boolean session config options during initialization. The existing stable ACP v1 types in the pinned dependency are used; no protocol dependency upgrade is required for this feature.
- New, loaded, and resumed ACP session responses are all inspected for their full initial configuration. Missing configuration is represented as no available thread settings, not as an error.
- The thread snapshot carries the configuration needed to render supported options. The public representation preserves opaque IDs, display names, optional descriptions, optional categories, option order, flat or grouped select values, boolean values, and the value currently confirmed by the agent.
- The backend retains enough internal state to distinguish the last agent-confirmed snapshot from the user's most recent desired display value. This distinction is not presented as a pending state in the UI.
- The user's most recent desired value is published through the existing thread subscription immediately and rendered as the ordinary selected value. The frontend does not maintain an independent optimistic copy of thread configuration.
- The command that selects a config option returns only success or failure and never returns a thread snapshot. All visible state continues to arrive through the thread subscription, in accordance with ADR 0001.
- Selecting the value already displayed is a successful no-op and does not emit an ACP request.
- Configuration changes are independent of prompt submission. Atte never delays a change until the next prompt and never attempts to combine configuration with a prompt request.
- Configuration controls remain interactive while a set request is in flight. A setting request does not disable other configuration controls, message composition, message sending, turn cancellation, or permission responses.
- Each ACP session processes config mutations serially. There is at most one set request in flight per thread, preventing response-order inversion from replacing newer state with an older complete snapshot.
- Multiple not-yet-sent choices for the same config ID are coalesced to the latest desired value. Coalescing never changes the already in-flight request.
- After every successful set response, the returned complete `configOptions` list replaces the confirmed snapshot. Remaining desired selections are overlaid for display only while they await processing.
- Before sending the next desired selection, the backend revalidates that its config ID, value type, and value remain present in the latest confirmed snapshot. Invalidated selections are discarded and the new agent-provided value becomes visible.
- Agent-originated `config_option_update` notifications also replace the complete confirmed snapshot. They are processed for both idle and active turns and are reconciled with any still-valid desired selections.
- A set failure clears the failed desired selection, republishes the last confirmed configuration, and exposes a non-blocking configuration error. It does not change the thread to `Failed`, stop the active turn, remove queued messages, or close the ACP session.
- A later successful selection clears the relevant configuration error. Exact visual placement of the non-blocking error follows the existing product error language and does not require a modal.
- Results from an obsolete runtime generation or a disconnected session are ignored using the existing generation safety mechanism.
- While the ACP session is disconnected or connecting, settings from an earlier connection are not displayed as current. Controls appear only after the new/load/resume result establishes the current snapshot; a layout-compatible loading placeholder may be used while connecting.
- Loss of the frontend thread subscription follows ADR 0001: the last snapshot may remain visible, but all mutation controls, including thread configuration, are disabled until subscription recovery.
- ACP categories are presentation hints only. `model`, `thought_level`, and `mode` options are promoted to compact composer controls; other supported options are placed in the thread configuration popover. Unknown or absent categories remain accessible in the popover.
- Agent-provided ordering is preserved within each surface. The UI does not sort by opaque IDs or infer importance from display names.
- Flat select and grouped select are both rendered from the protocol data. Boolean values use a native switch or toggle interaction.
- Unknown future option kinds do not fail connection or the thread. Atte omits only the unsupported control and records diagnostics; known sibling options remain available.
- Settings are available while a thread is ready, running, waiting for approval, or cancelling as long as the ACP session and frontend subscription permit mutations.
- Permission requests remain a separate domain and protocol flow. A `mode` option never causes Atte to automatically answer an incoming permission request.
- No thread configuration is stored as an Atte default. Creating a new thread does not copy values from another thread, and loading or resuming does not reapply locally remembered values.
- No database schema change is required. Persisted ACP session identity continues to let the agent restore its own configuration on load or resume.
- The composer uses the existing feature-sliced thread domain, API, model, and UI boundaries. Protocol translation and mutation ordering stay in the Rust runtime/thread boundary; SolidJS renders subscription state and sends user intent.

## Testing Decisions

- Tests assert externally observable behavior rather than private queue fields, task layout, component signals, or exact internal type organization.
- Two existing high-level seams are used because the Rust ACP transport and SolidJS UI are separated by the Tauri boundary. A new end-to-end desktop harness is not introduced solely for this feature.
- The primary backend seam connects `Threads` to the deterministic ACP fixture and observes thread subscriptions plus the fixture's request record. This follows the existing ACP session integration tests and exercises real JSON-RPC serialization, routing, and runtime behavior.
- Backend integration coverage verifies that initialization advertises boolean support and that new, load, and resume results each populate the initial thread configuration.
- Backend integration coverage verifies flat select, grouped select, boolean, unknown category, absent configuration, and agent-preserved ordering.
- Backend integration coverage verifies that a set request uses the exact opaque config ID and typed opaque value supplied by the agent.
- Backend integration coverage verifies that a successful set response replaces the complete snapshot, including dependent effort choices changed by a model selection.
- Backend integration coverage verifies idle and running `config_option_update` notifications and confirms that updates for another ACP session cannot affect the selected thread.
- Backend integration coverage uses deterministic request gates to prove one in-flight set request per thread, preservation of user interaction order across different settings, and latest-value coalescing for repeated not-yet-sent choices of the same setting.
- Backend integration coverage proves that selecting the displayed value emits no set request.
- Backend integration coverage proves that a value invalidated by a preceding response is not sent.
- Backend integration coverage proves that a set error restores the confirmed snapshot while the thread remains usable, the active turn continues, and queued messages remain intact.
- Backend integration coverage proves that stale results from a prior runtime generation cannot overwrite a reconnected thread.
- The primary frontend seam is the existing SolidJS app-level test harness with Tauri commands and thread subscription messages replaced at the boundary. This follows existing tests for connection, composer behavior, streaming updates, and mutation failure.
- Frontend coverage verifies compact model, thought-level, and mode controls in the composer, with remaining options reachable through the settings popover.
- Frontend coverage verifies grouped select semantics, boolean toggle semantics, agent names and descriptions, keyboard operation, accessible roles, and focus behavior.
- Frontend coverage verifies that selecting a value immediately displays it without pending text, spinner, or global control lock and invokes the mutation command once.
- Frontend coverage verifies that other settings and message input remain usable while a previous mutation command has not completed.
- Frontend coverage verifies reconciliation from subscription snapshots: successful confirmation, dependent-option replacement, invalid desired selection fallback, agent-originated updates, and failure rollback.
- Frontend coverage verifies that configuration failure is non-blocking and does not replace the composer or connection state.
- Frontend coverage verifies that controls are absent or represented by a loading placeholder before session readiness, absent when no options exist, and restored from the authoritative snapshot after reconnection.
- Frontend coverage verifies ADR 0001 behavior by disabling configuration mutation during subscription recovery without creating a second local state source.
- Existing message submission, cancellation, permission, queued-message, and composer layout tests remain passing to demonstrate that the added footer controls do not regress established behavior.

## Out of Scope

- Hardcoded model, effort, mode, sandbox, or approval catalogues for individual agents
- Deprecated ACP `modes`, `session/set_mode`, or Gemini-specific unstable model methods
- Saving per-agent, per-folder, or global defaults for new threads
- Reapplying local values after session load or resume
- Inferring risk, sandbox behavior, or approval semantics from option IDs, names, or categories
- Automatically answering permission requests based on a selected mode
- Changing the permission request data model or UI
- Vendor `_meta` extensions such as recommended values or permission storage hints
- Rendering future config option kinds other than ACP v1 select and boolean
- Database migrations or schema changes
- A new desktop end-to-end testing harness
- Legacy compatibility UI when an agent provides only modes and no config options

## Further Notes

- ADR 0001 remains authoritative for frontend state flow: commands express intent, while the thread subscription supplies all visible thread state.
- ADR 0002 records the generic ACP configuration boundary, immediate application policy, optimistic presentation, serialized mutation processing, and excluded compatibility behavior.
- The existing ACP session config options research records the protocol sources, current agent examples, Zed prior art, and the current Atte implementation gaps behind this specification.
- Zed informs the non-blocking interaction goal, but Atte deliberately adds per-thread serialization, coalescing, user-visible failure recovery, and stale-result protection rather than copying Zed's detached concurrent requests.
