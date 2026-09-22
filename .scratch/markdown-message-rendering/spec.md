Status: ready-for-agent

# 스레드 메시지 본문의 안전한 Markdown 렌더링

## Problem Statement

Atte는 현재 사용자의 메시지와 에이전트 응답을 모두 plain text로만 표시한다. ACP 에이전트와 모델은 제목, 목록, 표, 링크, 인라인 코드와 fenced code block을 포함한 Markdown을 일반적인 응답 형식으로 사용하므로, 현재 화면에서는 Markdown 기호가 그대로 노출되고 응답의 정보 구조와 코드 가독성이 사라진다. 특히 에이전트 응답은 작은 text delta로 스트리밍되기 때문에 완성된 문자열만 렌더링하는 접근으로는 진행 중인 응답을 자연스럽게 보여줄 수 없다.

메시지 본문은 신뢰할 수 없는 입력이기도 하다. 모델이 읽은 저장소 문서와 도구 출력이 응답에 영향을 줄 수 있으므로 raw HTML, 위험한 URL scheme, 원격 이미지와 실행 가능한 code block을 그대로 허용하면 WebView와 로컬 앱의 보안 경계를 침범할 수 있다. 반대로 매 delta마다 현재 DOM 전체를 교체하면 선택 영역과 상호작용 상태를 잃고 불필요한 DOM 변경이 발생한다. Atte에는 스레드 화면과 충돌하지 않는 스타일, 안전한 렌더링 정책, 스트리밍 중 DOM 보존을 함께 만족하는 공용 메시지 본문 렌더러가 필요하다.

## Solution

Atte는 사용자 메시지와 에이전트 응답에 공용 Markdown 렌더러를 사용한다. 입력창과 에이전트에 전달되는 원문은 변경하지 않고, 스레드 타임라인의 표시 계층에서만 CommonMark와 선택한 GFM 확장을 렌더링한다. 사용자 메시지는 기존 dark bubble을 유지하고 에이전트 응답은 기존 flat body를 유지하되, parser, 보안 정책, 링크 동작과 code block 동작은 공유한다.

렌더러는 누적된 메시지 source를 Marked로 파싱하고, raw HTML을 실행하지 않고 문자 그대로 표시하며, 결과를 엄격한 DOMPurify allowlist로 정화한다. 정화한 detached DOM만 morphdom에 전달해 현재 메시지 본문 내부를 조정한다. Solid는 메시지 본문 wrapper만 소유하고 morphdom이 관리하는 하위 DOM을 동시에 렌더링하지 않는다. 스트리밍 중에는 animation frame당 최대 한 번 현재 메시지 전체를 다시 파싱하며, 완료 신호에서는 최신 source를 즉시 최종 반영한다. 이전 메시지와 바깥 스레드 DOM은 이 갱신 경로를 타지 않는다.

첫 범위는 문단, 메시지형 줄바꿈, 제목, 강조, 목록, blockquote, 인라인 코드, GFM 표·취소선·읽기 전용 task list, 안전한 hyperlink와 code block에 집중한다. Code block에는 언어 표시, 지연 로드되는 구문 강조, 원문 복사와 내부 가로 스크롤을 제공한다. 수식, Mermaid, preview, 실행과 Apply 같은 확장 기능은 독립된 후속 기능으로 남긴다.

## User Stories

1. As an Atte user, I want Markdown in agent responses to render as structured content, so that I can understand the response without reading formatting symbols.
2. As an Atte user, I want Markdown in my sent messages to render the same way, so that the conversation uses one consistent content language.
3. As an Atte user, I want my composer to remain a plain text editor, so that I can see and edit the exact Markdown source before sending it.
4. As an Atte user, I want the exact source I typed to be sent to the agent, so that display formatting never changes my prompt.
5. As an Atte user, I want ordinary plain text to continue looking natural through the Markdown renderer, so that messages do not require Markdown syntax.
6. As an Atte user, I want paragraphs and single newlines to render naturally in chat, so that model output keeps its intended conversational layout.
7. As an Atte user, I want headings, emphasis, ordered and unordered lists, and blockquotes to be visually distinct, so that long explanations remain scannable.
8. As an Atte user, I want inline code to be visually distinct from prose, so that identifiers and commands are easy to recognize.
9. As an Atte user, I want GFM tables to render as tables, so that comparisons remain understandable.
10. As an Atte user, I want wide tables to scroll inside the message body, so that they do not widen or break the thread layout.
11. As an Atte user, I want GFM strikethrough to render correctly, so that revisions and deprecated alternatives retain their meaning.
12. As an Atte user, I want task lists to render as disabled checkboxes, so that their status is legible without implying that the response is editable.
13. As an Atte user, I want user messages to retain the existing dark bubble, so that participants remain visually distinguishable.
14. As an Atte user, I want agent responses to retain the existing flat presentation, so that Markdown support does not redesign the thread.
15. As an Atte user, I want Markdown typography to remain inside each message body, so that headings, lists, tables, and code cannot alter the surrounding thread screen.
16. As an Atte user, I want Markdown headings to use message-local visual and semantic hierarchy, so that a response does not compete with the page heading or thread structure.
17. As an Atte user, I want long user messages to remain collapsed at approximately 20 rendered lines, so that Markdown does not remove the existing compact conversation behavior.
18. As an Atte user, I want long-message folding to respond to width and rendered-height changes, so that wrapping and Markdown layout determine whether expansion is offered.
19. As an Atte user, I want responses to become formatted while they stream, so that I do not have to wait for the turn to finish.
20. As an Atte user, I want incomplete Markdown to remain readable while streaming, so that a temporarily open construct does not blank or break the response.
21. As an Atte user, I want an open fenced code block to appear immediately as plain code, so that source remains visible before the closing fence arrives.
22. As an Atte user, I want a completed fenced code block to gain syntax highlighting, so that code is easier to read after its language and boundaries are known.
23. As an Atte user, I want the renderer to coalesce tiny stream deltas to the display frame rate, so that frequent chunks do not cause unnecessary visible work.
24. As an Atte user, I want the final stream update to render immediately, so that completion never leaves the display one frame or chunk behind.
25. As an Atte user, I want unchanged parts of a streaming response to retain their DOM nodes, so that selection and local interaction state remain stable.
26. As an Atte user, I want previous messages to remain untouched while the current response streams, so that a growing response does not re-render the whole thread.
27. As an Atte user reading earlier content, I want streaming height changes not to pull me to the bottom, so that I keep my reading position.
28. As an Atte user already at the latest position, I want streaming height changes to remain followed, so that I can watch the response continue naturally.
29. As an Atte user, I want each fenced code block to show its language when known, so that I can identify the syntax context.
30. As an Atte user, I want unknown code languages to fall back to plain text, so that unsupported labels never hide or corrupt the code.
31. As an Atte user, I want syntax languages loaded only when encountered, so that Markdown support does not front-load every highlighter grammar.
32. As an Atte user, I want source code to appear before the highlighter finishes loading, so that highlighting latency never blocks reading.
33. As an Atte user, I want long code lines to scroll within the code block, so that code does not widen the message or thread.
34. As an Atte user, I want to copy the original code from a code block, so that highlighting markup never changes the copied source.
35. As an Atte user, I want successful code copying acknowledged for about two seconds, so that I know the action completed.
36. As a screen reader user, I want copy success announced accessibly, so that the feedback is not limited to a visual icon.
37. As an Atte user, I want a failed copy action to show a brief local error without showing success, so that feedback remains truthful and non-disruptive.
38. As an Atte user, I want HTTP and HTTPS Markdown links to appear as hyperlinks, so that I can follow cited web resources.
39. As an Atte user, I want web links to open in my system browser, so that clicking one does not navigate the Atte WebView away from the thread.
40. As an Atte user, I want links to open without an extra confirmation or tooltip, so that ordinary web navigation remains lightweight.
41. As an Atte user, I want JavaScript, data, file, command, and custom-scheme links blocked, so that message content cannot execute commands or escape the approved URL boundary.
42. As an Atte user, I want blocked links to remain readable without a security banner, so that unsafe behavior is removed without cluttering the conversation.
43. As an Atte user, I want Markdown images represented as hyperlinks instead of loaded media, so that arbitrary remote servers cannot learn that I viewed a message.
44. As an Atte user, I want raw HTML to appear as literal text, so that I can read generated markup without allowing it to execute.
45. As an Atte user, I want scripts, event handlers, iframes, styles, forms, and unapproved attributes removed even if parsing behavior changes, so that the renderer has a defense-in-depth security boundary.
46. As an Atte user, I want rendering failures to fall back to safe plain text, so that malformed content never removes the message.
47. As an Atte user, I want extremely large messages to remain complete as plain text when formatted rendering is unsafe, so that Atte never silently truncates my conversation.
48. As an Atte user, I want fallback to happen without an explanatory banner, so that the original content remains the focus.
49. As an Atte user, I want loaded ACP history to use the same Markdown renderer as live turns, so that restored and streaming messages look consistent.
50. As an Atte user, I want message rendering to remain independent of local conversation persistence, so that the feature does not change what Atte stores.
51. As a keyboard user, I want hyperlinks, copy controls, and message expansion controls to remain keyboard operable, so that Markdown content is accessible without a pointer.
52. As a screen reader user, I want semantic lists, tables, blockquotes, links, code, and headings, so that formatted content has meaningful structure.
53. As an Atte user, I want rendering and highlighting cleanup when a message component is removed, so that navigating among threads does not leave timers, frames, or asynchronous updates behind.
54. As an Atte user, I want the final rendered message to match a clean render of the complete source, so that incremental updates never accumulate an incorrect DOM.

## Implementation Decisions

- `메시지 본문 (Message body)` is the domain term for either a user's message or an agent response shown in the thread timeline. It does not mean only one participant's content.
- Markdown remains a presentation concern. The existing thread subscription, turn source strings, text-delta accumulation, queued-message behavior, ACP load behavior, and outbound message contract remain authoritative and unchanged.
- Atte does not introduce local turn persistence for this feature. No database schema change or migration is required.
- A reusable shared Markdown UI module is introduced and consumed by both user and agent message presentation. The module owns parsing, sanitization, DOM reconciliation, link handling, code-block behavior and scoped Markdown styling.
- The public Markdown module accepts the source string and the minimal presentation context needed to distinguish user and agent variants and streaming from completion. Parser configuration, sanitizer configuration, highlighter state and DOM reconciliation details remain private.
- The input composer remains plain text. Rendering starts only in the sent message timeline, and outbound source is never normalized or rewritten.
- User and agent messages share dialect, sanitization, URL policy, image policy, task-list policy and code-block behavior. Their existing outer visual treatments remain distinct.
- CommonMark is the baseline dialect. GFM tables, strikethrough and task lists are enabled, and chat-style single newline breaks are enabled explicitly.
- Task-list controls are rendered disabled and cannot mutate the source or any thread state.
- A module-scoped Marked instance is configured once rather than mutating global Marked configuration during component updates.
- Marked's raw-HTML renderer escapes the original HTML token as text. Raw HTML is not merely dropped because users may need to read generated markup.
- Every parser result passes through a strict DOMPurify allowlist before entering a live DOM. Scriptable elements, forms, embedded browsing contexts, event attributes, arbitrary styles and other unapproved elements or attributes are denied.
- Sanitization always precedes DOM reconciliation. No decoration or plugin may append unsanitized HTML after this boundary.
- Markdown images never produce an image element or external resource request in the first version. They produce readable alt text and, when the destination passes the web URL policy, a hyperlink.
- Only absolute `http` and `https` destinations become active hyperlinks. JavaScript, data, file, command, relative and custom schemes do not receive navigation behavior; their readable label remains.
- Hyperlink activation prevents WebView navigation and uses Tauri's opener capability to open the destination in the system browser. Opener initialization and permissions are restricted to the approved web URL schemes.
- Hyperlinks do not require an extra confirmation step or a custom tooltip.
- Parsed and sanitized HTML is materialized in a detached message-body wrapper. morphdom reconciles that wrapper with the current live message-body wrapper and minimizes mutations.
- Solid owns the outer Markdown wrapper and its lifecycle but does not simultaneously declaratively render morphdom-managed children. This ownership boundary prevents Solid's reconciler and morphdom from competing over the same DOM.
- Link and code-copy interactions use delegation from the stable wrapper rather than attaching replacement-prone listeners to every generated descendant.
- morphdom is an implementation for DOM mutation minimization, not an incremental Markdown parser. During the first version, each scheduled update reparses the current message's complete accumulated source.
- Only the actively changing message schedules streaming renders. Completed previous messages and the surrounding thread are not reparsed because a later message receives a delta.
- Streaming source updates are coalesced to at most one parse, sanitize and morph cycle per `requestAnimationFrame`. Completion flushes the latest source immediately, including cancellation or another terminal stop reason.
- Non-append changes and syntax that reinterprets earlier content are allowed. Reconciliation must converge to the same safe DOM as a clean render of the latest complete source rather than relying exclusively on append-only assumptions.
- Pending frames, timers, observers, event handlers and obsolete asynchronous highlighting results are cancelled or ignored when the component is disposed or a newer generation supersedes them.
- Shiki provides syntax highlighting. It is initialized lazily and loads only languages encountered in code fences. Unsupported languages use plain text.
- Open or incomplete code fences render synchronously as plain code. A closed fence or completed turn may be highlighted asynchronously without withholding the source text.
- Highlight results are keyed by language and exact source identity so an older asynchronous result cannot overwrite newer code. Completed code highlights may be cached without changing the source of truth.
- A fenced code block contains a normalized language label when available, a copy control and a horizontally scrollable code body. Apply, run, preview and wrapping controls are not introduced.
- Code copy uses the exact parsed code source rather than highlighted DOM text. Success changes the accessible label and visual state to “Copied” for approximately two seconds and announces it. Failure produces a brief local error and never enters the success state.
- Markdown styling uses Tailwind and centralized semantic variants or utilities. Descendant styling is scoped beneath the Markdown wrapper rather than using unscoped element selectors.
- Markdown headings are normalized to a message-local visual and semantic hierarchy so they cannot become competing page-level headings. Relative heading distinctions remain visible inside the message.
- Tables and code blocks constrain overflow inside themselves. No Markdown construct may increase the width of the containing message or thread.
- Existing user-message folding remains based on measured rendered height at approximately 20 lines. It continues to use resize observation so Markdown reflow, table layout, code layout and container-width changes update collapsibility.
- Existing latest-position behavior remains authoritative: height changes are followed only while the user is already at the latest position, and never force a user reading earlier content to the bottom.
- The renderer applies a measured safety threshold for content that would make synchronous formatted rendering unsafe. Above that threshold it displays the entire source as safe plain text; it never truncates and does not add a fallback notice.
- Parsing, sanitization, morphing or highlighting failure also falls back to the complete safe plain-text source without an explanatory banner. A highlighting failure alone leaves the code as plain code rather than degrading the whole message.
- The first version deliberately stops at full-source parsing plus DOM reconciliation. Stable-block parsing, live-tail projection, parser workers, streaming Shiki token diff and bounded cross-message render caches require measured evidence before introduction.
- The renderer does not rely on `solid-markdown`. Its reconcile mode still reparses the full source, lacks the required built-in security and code policies, and has insufficient upstream test assurance for this core display path.
- The chosen underlying product pattern is the established `marked` + DOMPurify + morphdom combination used in a current SolidJS coding-agent interface, while retaining a smaller first implementation than that product's block projection and worker pipeline.

## Testing Decisions

- Tests assert externally observable rendering, accessibility, interaction, security and DOM-stability behavior. They do not assert private parser tokens, Marked renderer callbacks, sanitizer implementation details, internal signals, frame flags or morphdom callback order.
- The primary and intentionally broad test seam is the public shared Markdown UI module rendered in the existing SolidJS testing environment. This one seam receives source and presentation state and exposes the same DOM and user interactions as production.
- Security cases are exercised through the public Markdown module rather than a separate parser-unit seam. Assertions verify that unsafe content cannot create active elements, attributes, resource loads or navigation while its readable text remains available where required.
- Dialect coverage through the public seam includes paragraphs, single-line breaks, headings, emphasis, lists, blockquotes, inline code, fenced code, GFM tables, strikethrough and disabled task lists.
- Streaming coverage updates one mounted Markdown component across token boundaries, including emphasis, links, tables and fences split across deltas. It verifies readable intermediate states and the correct completed state.
- Frame-coalescing coverage uses controlled animation frames to prove that multiple tiny updates schedule at most one render cycle and that completion immediately flushes the newest source.
- DOM reconciliation coverage retains a reference to an unchanged node across a streaming append and verifies object identity after the update. It also verifies that structural and non-append source changes converge to the same DOM as a fresh render.
- Sanitization-before-morph coverage starts with safe live DOM, supplies content containing raw HTML and dangerous elements or attributes, and proves that no unsafe node reaches the live wrapper.
- URL coverage verifies that HTTP and HTTPS links call the opener boundary without navigating the WebView, while JavaScript, data, file, command, relative and custom schemes remain inactive.
- Image coverage verifies that Markdown image syntax creates no image element or network-loading attribute and provides a hyperlink only for an allowed destination.
- Code-block coverage verifies the language label, internal overflow boundary, immediate plain-code fallback, transition after a closing fence, unknown-language behavior and stale-highlight rejection.
- Copy coverage verifies exact source preservation, two-second success feedback, accessible announcement, repeated copy behavior, timer cleanup and truthful failure feedback.
- Fallback coverage injects parsing, sanitizing, morphing and highlighting failures at module boundaries and verifies that the complete source remains readable as safe plain text without a notice.
- Large-content coverage crosses the configured safety threshold and proves that the full source is present, unformatted and untruncated.
- Accessibility coverage verifies semantic headings, lists, tables, blockquotes, links and code; disabled task controls; keyboard-operable links and copy controls; and accessible copy status.
- A thin integration test at the existing Message component seam verifies that both user messages and agent responses consume the public Markdown module while retaining their distinct visual variants.
- The existing Message component folding tests are extended with rendered Markdown whose measured height crosses the 20-line boundary and whose resize later changes that decision. Tests continue to operate through visible expansion controls and measured layout inputs rather than private state.
- Thread-level coverage reuses existing streaming and latest-position tests to verify that only the active message changes and that height changes follow the existing at-latest rule.
- Loaded-history coverage supplies turns reconstructed through the existing thread subscription boundary and verifies the same Markdown result as live content. No persistence-specific test suite is added because this feature stores no turns.
- Existing plain-text messages, message completion text, queued-message behavior, cancellation, permission requests, thread switching and composer submission tests remain passing to demonstrate that the display-only change does not alter thread behavior.
- Visual styling tests assert stable semantic variants and overflow contracts rather than exact generated Tailwind class strings wherever possible. Manual verification covers representative user and agent messages at narrow and wide thread widths.

## Out of Scope

- WYSIWYG or live Markdown preview inside the message composer
- Rewriting, normalizing or otherwise changing outbound user Markdown source
- Persisting user messages, agent responses, rendered HTML, parsed ASTs or highlight results in Atte's database
- Math or LaTeX rendering
- Mermaid or other diagram rendering
- HTML, React, SVG, Vega or other executable or interactive previews
- Running code blocks, terminal insertion, file creation, Apply actions, edit suggestions or IDE-style code actions
- Loading remote Markdown images inline
- Opening local files, workspace paths, command links, application deep links or arbitrary URL schemes
- Interactive task-list mutation
- Trusted raw HTML or a user-configurable HTML allowlist
- Markdown extensions beyond the selected CommonMark and GFM subset
- A user-facing setting for Markdown dialect, rendering, styling or security policy
- Incremental parsing of only the live tail or completed-block parse caching
- Moving Markdown parsing or syntax highlighting to a worker before performance measurements justify it
- Reproducing OpenCode's block projection, streaming token diff, worker protocol or render cache in the first version
- Code wrapping controls, code execution controls or preview controls
- Custom link confirmation dialogs, hover previews or tooltips
- A fallback or security explanation banner inside the message body
- Hidden truncation of long content
- Changes to ACP message contracts, thread subscription ownership, turn accumulation, queue behavior or database schema
- A new desktop end-to-end test harness solely for Markdown rendering

## Further Notes

- ACP text content may contain Markdown and arrives incrementally. This specification treats the accumulated source string as authoritative and the rendered DOM as disposable presentation state.
- Current VS Code Chat accepts full-source parsing and target replacement on its standard path; its experimental incremental renderer primarily batches and buffers updates. Atte deliberately adds a real DOM reconciliation layer while retaining full-source parsing for the current message.
- `solid-markdown` was evaluated rather than dismissed by name. Its AST reconciliation would reduce DOM replacement but would not eliminate full-source parsing, and Atte would still have to supply its security, URL, image and code-block policies.
- The renderer's wrapper boundary is important for future work. Stable-block parsing or a worker can be added behind the same public Markdown interface without changing Message consumers or the thread state model.
- `ready-for-agent` means the feature is specified well enough to implement; it does not indicate that implementation has started or completed.
