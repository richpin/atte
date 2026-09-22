# 스트리밍 Markdown 렌더러 구현 패턴

조사일: 2026-09-21, 결정 갱신: 2026-09-22. 공식 제품 문서, 공식 공개 저장소, 라이브러리 공식 문서만 사용했다. 이 문서는 구현 전 설계 조사이며 코드는 변경하지 않는다.

## 결론

Atte의 첫 구현은 **`marked` + `DOMPurify` + `morphdom` + Atte 전용 Solid 컴포넌트**가 가장 단순하면서도 충분히 견고하다.

- `marked`는 GFM, lexer, custom renderer를 한 패키지에서 제공하고 VS Code와 OpenCode가 실제 채팅 렌더러에 사용한다.
- `marked` 출력은 안전하지 않으므로 raw HTML 비활성화와 별개로 반드시 `DOMPurify`를 통과시킨다.
- 현재 `textDelta` 누적 상태는 그대로 둔다. Markdown은 상태 모델이 아니라 표시 계층에서 처리한다.
- 첫 버전은 현재 스트리밍 중인 메시지의 누적 원문 전체를 animation frame당 최대 한 번 파싱하고, 정화한 새 DOM을 기존 메시지 본문과 `morphdom`으로 조정한다. 이전 메시지와 바깥 스레드 DOM은 건드리지 않는다.
- Shiki 구문 강조는 닫힌 code fence에만 적용한다. 완료된 block 고정, live tail 재파싱, worker, streaming Shiki는 실제 병목이 확인된 뒤 추가한다.

`solid-markdown`은 지금 선택하지 않는다. `reconcile` 전략도 source 변경마다 누적 Markdown 전체를 unified로 다시 파싱한 뒤 새 AST를 Solid store와 조정하는 방식이므로 DOM 교체는 줄여도 전체 재파싱을 피하지 못한다. 공식 README에는 테스트 포팅이 아직 TODO이고, Atte가 요구하는 sanitizer, URL·이미지 정책, raw HTML 문자 표시, Shiki 통합도 별도로 구성해야 한다. 새 대체 포트도 현재 RC이므로 핵심 표시 경로의 기반으로 삼기에는 이르다. [`solid-markdown` 구현](https://github.com/andi23rosca/solid-markdown/blob/66c00a5df5632b2a6b2cc3ec30fd2129b1a80ba3/src/index.tsx#L61-L104), [`solid-markdown` README](https://github.com/andi23rosca/solid-markdown/blob/66c00a5df5632b2a6b2cc3ec30fd2129b1a80ba3/README.md#L41-L57)

## 제품 구현 비교

| 제품 | 공개 구현 | 스트리밍·성능 | 코드·보안 |
| --- | --- | --- | --- |
| VS Code / Copilot Chat | `marked`, chat에서 `gfm: true`, `breaks: true` | 기본 경로는 전체 source를 다시 파싱하고 target 자식을 교체한다. 기본값이 꺼진 실험적 incremental renderer도 DOM diff가 아니라 append-only 검사, word/paragraph buffering, rAF 배치와 animation 뒤 표준 전체 렌더러를 호출한다. 기존 code block 객체만 일부 재사용한다. | code block은 custom renderer placeholder에 editor를 삽입한다. DOM allowlist sanitizer를 별도로 적용하고 raw HTML은 기본 제거한다. `data:`/`javascript:` 링크를 제거하며 `command:`는 trusted content만 허용한다. |
| Zed | Rust `pulldown-cmark`, GFM/table/task-list 등 option 활성화 | append마다 background parse한다. parse 중 새 delta는 `should_reparse`로 합쳐 완료 후 최신 source를 다시 parse해 UI thread와 중복 작업을 보호한다. | agent code block에 hover copy·wrap 버튼과 syntax theme을 제공한다. `parse_html` 기본값은 false다. |
| OpenCode | SolidJS에서 `marked` + `remend` + Shiki + DOMPurify + `morphdom` | 완료 block / live tail / code로 분할한다. tail만 재처리하고 열린 fence에는 suffix fast path를 쓴다. parse·highlight는 worker에서 실행하며 오래된 요청을 폐기하고 cache/state를 200개로 제한한다. | Shiki streaming token의 stable/unstable 부분만 DOM에 반영한다. code copy 버튼을 별도 장식하며 style/script를 sanitizer에서 금지한다. |
| ChatGPT | 내부 parser와 streaming 구현은 비공개 | 공식 근거로 내부 전략을 확인할 수 없다. | 공식 UX에서 code block의 언어 표시·복사·편집·preview/run을 확인할 수 있다. 실행·preview는 별도 sandbox 기능이다. |

근거:

- VS Code의 chat 설정과 renderer 호출: [chatMarkdownContentPart.ts](https://github.com/microsoft/vscode/blob/472fec888a971ed2d5e31e9a53c3830f6ae8d923/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts#L155-L240), [incremental renderer](https://github.com/microsoft/vscode/blob/472fec888a971ed2d5e31e9a53c3830f6ae8d923/src/vs/workbench/contrib/chat/browser/widget/chatContentParts/chatIncrementalRendering/chatIncrementalRendering.ts#L19-L33)
- VS Code의 incomplete-token 처리, code placeholder, sanitizer·link 정책: [markdownRenderer.ts](https://github.com/microsoft/vscode/blob/aca2ff4f104679ab93524413380bfb72ad115adc/src/vs/base/browser/markdownRenderer.ts#L202-L280), [링크 및 raw HTML 처리](https://github.com/microsoft/vscode/blob/aca2ff4f104679ab93524413380bfb72ad115adc/src/vs/base/browser/markdownRenderer.ts#L405-L488), [media allowlist](https://github.com/microsoft/vscode/blob/aca2ff4f104679ab93524413380bfb72ad115adc/src/vs/base/browser/markdownRenderer.ts#L603-L737)
- Zed의 append/background reparse: [markdown.rs](https://github.com/zed-industries/zed/blob/bcf6582ce3500df93a8a39366640173e6786cea6/crates/markdown/src/markdown.rs#L1114-L1188), [완료 후 재파싱](https://github.com/zed-industries/zed/blob/bcf6582ce3500df93a8a39366640173e6786cea6/crates/markdown/src/markdown.rs#L1260-L1285)
- Zed의 code block copy·wrap UI: [markdown.rs](https://github.com/zed-industries/zed/blob/bcf6582ce3500df93a8a39366640173e6786cea6/crates/markdown/src/markdown.rs#L3258-L3318)
- OpenCode의 block projection: [markdown-stream.ts](https://github.com/anomalyco/opencode/blob/cf494c2029d4334dfe6defc31209341ca97c2e94/packages/session-ui/src/components/markdown-stream.ts#L45-L113)
- OpenCode의 worker·supersede: [markdown-worker.ts](https://github.com/anomalyco/opencode/blob/cf494c2029d4334dfe6defc31209341ca97c2e94/packages/session-ui/src/components/markdown-worker.ts#L27-L101)
- OpenCode의 Solid 렌더링·DOM diff·copy: [markdown.tsx](https://github.com/anomalyco/opencode/blob/cf494c2029d4334dfe6defc31209341ca97c2e94/packages/session-ui/src/components/markdown.tsx#L340-L509), [block update](https://github.com/anomalyco/opencode/blob/cf494c2029d4334dfe6defc31209341ca97c2e94/packages/session-ui/src/components/markdown.tsx#L556-L667)
- OpenCode의 DOMPurify와 bounded cache: [markdown-cache.tsx](https://github.com/anomalyco/opencode/blob/cf494c2029d4334dfe6defc31209341ca97c2e94/packages/session-ui/src/components/markdown-cache.tsx#L1-L49)
- ChatGPT code block UX: [OpenAI Help Center](https://help.openai.com/en/articles/20001246)

제품에서 가져올 핵심 패턴은 “완성된 Markdown이 올 때까지 기다리기”가 아니라 **누적 source를 계속 렌더링하되, 불완전한 tail과 비싼 code block을 별도로 취급하는 것**이다. ChatGPT의 내부 구현은 공개되지 않았으므로 UI 결과 이상을 추정하지 않는다.

## 라이브러리 판단

| 후보 | 장점 | 비용·위험 | 판단 |
| --- | --- | --- | --- |
| `marked` | 작은 API, built-in GFM, lexer와 renderer override, VS Code·OpenCode 선례 | HTML 출력이 안전하지 않아 sanitizer가 필수 | **선택** |
| `markdown-it` | CommonMark 중심, raw HTML 기본 off, plugin과 highlight hook | task list 등 GFM 전체에는 plugin 조합이 필요하고 결과는 여전히 HTML | 좋은 대안이나 Atte에는 이점이 작음 |
| unified/remark/rehype | typed AST 변환, `remark-gfm`, `rehype-sanitize`, 세밀한 element 정책 | 여러 패키지와 pipeline, 공식 Solid renderer 부재 | 수식·custom node가 핵심이 될 때 재검토 |
| micromark | CommonMark 준수, dangerous HTML/protocol 기본 차단, GFM 확장 | low-level이며 공식 stream API는 Node stream 처리이지 browser의 live partial DOM renderer가 아님 | Atte UI에는 과도하게 낮은 수준 |
| `solid-markdown` | Solid component와 streaming용 AST reconcile 전략 | 전체 source 재파싱은 유지되고 sanitizer·제품 정책·highlight 통합과 자체 검증이 필요 | 첫 버전 기반으로 사용하지 않음 |
| `morphdom` | framework와 무관한 검증된 DOM diff, 현재 OpenCode의 Solid renderer 선례 | Markdown parsing은 담당하지 않으며 Solid가 같은 하위 DOM을 동시에 소유하지 않도록 경계 필요 | **정화된 메시지 본문 DOM 조정에 선택** |

`marked` 자체도 공식적으로 HTML을 sanitize하지 않는다고 경고하고 DOMPurify 같은 sanitizer 사용을 요구한다. [Marked README](https://github.com/markedjs/marked/blob/master/README.md#usage) `markdown-it`은 safe-by-default와 CommonMark 준수를 내세우며 custom highlight hook을 제공한다. [markdown-it README](https://github.com/markdown-it/markdown-it/blob/master/README.md), [highlight 예시](https://github.com/markdown-it/markdown-it/blob/master/docs/usage.md#syntax-highlighting) unified는 CommonMark를 기본으로 하고 GFM과 sanitizer를 plugin으로 조합한다. [remark README](https://github.com/remarkjs/remark#example-support-for-gfm-and-frontmatter), [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize#what-is-this) micromark도 안전한 기본값과 입력 크기 제한·worker 사용을 권고한다. [micromark security](https://github.com/micromark/micromark#security)

## Atte에 맞는 구조

현재 backend subscription이 `textDelta`를 마지막 turn의 `response` 문자열에 append하며 해당 dependency만 갱신한다. [thread.ts](../../src/pages/thread/model/thread.ts#L263-L290) `Message.tsx`는 user message와 assistant response를 모두 plain text로 표시한다. [Message.tsx](../../src/pages/thread/ui/Message.tsx#L76-L96)

ADR 0001의 “subscription이 단일 상태 공급원” 결정은 그대로 유지한다. Markdown renderer는 source를 복제하거나 thread state를 소유하지 않는다. [ADR 0001](../adr/0001-use-thread-subscription-as-the-single-state-source.md)

권장 파일 배치는 현재의 FSD와 flat `shared/ui` 관례에 맞춘다.

```text
src/shared/ui/
  markdown.tsx          # Solid wrapper, morphdom lifecycle, link/copy event delegation
  markdown-parser.ts    # configured Marked instance, sanitizer, URL policy
  markdown-parser.test.ts # GFM, incomplete fragment, XSS, URL/image policy
  markdown.test.tsx     # streaming, copy/link interaction, stale-result tests
  index.ts              # public API export

src/pages/thread/ui/
  Message.tsx           # user/assistant 본문을 같은 <Markdown> 모듈에 연결

src/app/styles.css      # .markdown-body typography와 table/pre overflow
src/shared/i18n/locales/{en,ko}.ts # Copy/Copied 접근성 레이블

src-tauri/src/lib.rs
src-tauri/capabilities/default.json # 외부 링크 범위를 넣을 때만 opener 최소 권한 추가
```

`Message.tsx`에서 shared slice는 `shared/ui` public API로 import한다. parser 설정은 UI public API가 아니므로 내부에 둔다. 사용자 메시지와 에이전트 응답은 같은 parser·보안·code block 동작을 사용하되, 사용자 메시지는 기존 dark bubble을 유지하고 에이전트 응답은 flat body 형태를 유지한다. 입력창은 plain text 편집기이고, 사용자가 전송한 Markdown source는 에이전트에 변경 없이 전달한 뒤 타임라인에서만 렌더링한다.

현재 opener 패키지는 frontend와 Rust 의존성에 있지만 Rust builder 초기화와 capability 권한은 연결되지 않았다. 첫 범위에서 `http`/`https` hyperlink를 시스템 브라우저로 열기로 했으므로 `lib.rs`에서 plugin을 초기화하고 `default.json`에는 해당 URL만 여는 최소 scope를 함께 추가해야 한다. Markdown image는 외부 resource를 불러오지 않고 alt text와 안전한 URL의 hyperlink로 표시한다.

## 권장 렌더링 파이프라인

```text
Thread.textDelta
  -> 기존 Turn.response에 누적
  -> <Markdown source={turn.response} streaming={!turn.stopReason}>
  -> Marked(GFM + breaks, raw HTML은 text로 escape)
  -> DOMPurify allowlist
  -> detached DOM 생성
  -> morphdom으로 현재 메시지 본문 내부만 조정
  -> code block 장식/비동기 highlight 및 link/copy event delegation
```

1. module scope에 전용 `Marked` instance를 한 번 만든다. global `marked.use()`를 반복 호출하지 않는다. Marked 공식 문서도 독립 instance를 제공한다. [Marked advanced usage](https://github.com/markedjs/marked/blob/master/docs/USING_ADVANCED.md#marked-instance)
2. `gfm: true`, `breaks: true`로 coding-agent 채팅에 익숙한 dialect를 명시한다. 이 동작은 VS Code Chat과 동일하다.
3. raw HTML renderer는 원문을 escape해 글자로 보이게 한다. HTML 실행을 위해 `rehype-raw`와 같은 경로를 열지 않는다.
4. parser output을 제한된 tag/attribute allowlist의 DOMPurify에 통과시킨 뒤에만 DOM에 넣는다. `style`, event handler, `iframe`, `script`, form control을 허용하지 않는다.
5. image renderer는 첫 버전에서 `<img>`를 만들지 않는다. alt text 또는 안전한 link로 표시한다. ACP structured image와 Markdown URL image는 별도 기능이다.
6. link는 `http:`/`https:`만 시작 범위로 두고 click을 `preventDefault()`한 뒤 Tauri `openUrl`로 시스템 브라우저에 연다. `file:`, `data:`, `javascript:`, `command:`, custom scheme은 거절한다.
7. opener permission도 URL 범위로 제한한다. Tauri opener는 기본적으로 위험한 command를 차단하고 capability scope를 요구한다. [Tauri opener 보안·권한](https://v2.tauri.app/plugin/opener/#permissions)
8. fenced code에는 language label, 가로 스크롤과 독립된 copy 버튼을 제공한다. copy는 highlighted DOM이 아니라 parser가 보관한 원문 code를 사용한다.
9. Shiki highlighter는 한 번 lazy initialize하고 필요한 language만 load한다. 알 수 없는 language는 `text`로 처리한다. Shiki도 이를 공식 fallback으로 문서화한다. [Shiki special language](https://github.com/shikijs/shiki/blob/main/docs/languages.md#plain-text)
10. 열린 code fence는 즉시 plain code로 표시하고, fence가 닫히거나 turn이 완료된 뒤 highlight한다. 사용자가 텍스트를 보는 일을 highlighter 로딩이 막지 않게 한다.

## 스트리밍 단계

### 1단계: 단순하고 완결된 구현

- 원문은 기존처럼 매 delta 누적한다.
- renderer에서 현재 스트리밍 메시지의 누적 문자열 전체를 parse한다. 완료된 이전 메시지는 이 갱신 경로를 타지 않는다.
- 렌더 계산은 `requestAnimationFrame`당 최대 한 번으로 coalesce하되 turn 완료 시 최신 source를 즉시 최종 렌더한다.
- 정화한 detached DOM을 `morphdom`으로 기존 메시지 본문과 조정해 동일한 노드를 보존한다. Solid는 wrapper만 소유하고 그 하위 DOM을 동시에 렌더링하지 않는다.
- parse/highlight에 generation 번호를 두어 늦게 끝난 비동기 결과가 최신 DOM을 덮지 못하게 한다.
- 이전에 완료된 code block highlight는 `language + source hash`로 cache한다.

이 단계는 Zed의 “background 작업 하나 + 후속 reparse flag”와 OpenCode의 검증된 `morphdom` 사용을 가져오되, OpenCode의 block projection·worker·streaming token diff까지 복제하지 않는다.

### 2단계: 측정 후 최적화

긴 응답에서 main-thread jank 또는 selection 소실이 확인되면 다음 순서로 확장한다.

1. `marked.lexer()`로 top-level block을 나눈다.
2. append-only일 때 완료 block은 고정하고 마지막 live block만 재parse한다.
3. reference definition처럼 뒤쪽 source가 앞 block 해석을 바꿀 수 있으면 전체 문서 경로로 fallback한다.
4. 기존 `morphdom` 경계를 유지한 채 stable block cache로 파싱 범위를 줄인다.
5. 그래도 비용이 크면 parse와 Shiki를 worker로 이동하고 key별 오래된 요청을 supersede한다.

이는 OpenCode의 현재 구조와 같은 성장 경로다. 첫 버전부터 worker protocol, token diff, LRU를 모두 만들 필요는 없다.

## 코드 블록 UI

최소 UI는 다음으로 제한한다.

- header: 정규화한 language label, Copy 버튼
- body: `<pre><code>`와 block 내부 horizontal scroll
- copy 성공: 버튼 label/icon을 2초간 “복사됨”으로 변경, `aria-live` 또는 접근 가능한 label 제공
- unknown language: plain text
- streaming open fence: plain code, copy 가능
- 실행, Apply, preview, Mermaid는 별도 기능으로 둔다

VS Code는 code block을 editor 객체로 렌더링해 IntelliSense·apply 같은 IDE 기능을 붙이고, OpenCode는 code token과 copy chrome을 별도 관리한다. Atte의 첫 구현은 이 중 언어 표시·highlight·copy까지만 채택한다.

## 보안 계약

- agent response는 신뢰하지 않는다. repository/tool output에서 유입된 문자열도 동일하다.
- parser의 HTML-off 설정과 sanitizer를 중복 적용한다. 하나는 제품 정책, 다른 하나는 방어 계층이다.
- sanitizer 이후에 plugin이 HTML을 다시 쓰지 않는다. `rehype-sanitize`도 마지막 unsafe transform 뒤 sanitize할 것을 요구한다. [rehype-sanitize security](https://github.com/rehypejs/rehype-sanitize#security)
- remote image 자동 로딩을 금지해 IP·접근 시각·tracking query 유출을 막는다.
- local file link는 workspace 경계와 별도 권한 설계 전까지 열지 않는다.
- code, Mermaid, HTML을 렌더링했다고 실행하지 않는다.
- 입력 크기에 측정 기반 안전 임계값과 graceful fallback을 둔다. VS Code generic renderer는 UI freeze를 막기 위해 100,000자에서 자른다. [VS Code length guard](https://github.com/microsoft/vscode/blob/aca2ff4f104679ab93524413380bfb72ad115adc/src/vs/base/browser/markdownRenderer.ts#L490-L503) Atte는 내용을 자르거나 별도 안내를 표시하지 않고 전체 plain text로 fallback한다.

## 검증 범위

구현 시 최소한 다음을 자동화한다.

- CommonMark 본문과 GFM table/strikethrough/task list
- 한 delta 안팎으로 쪼개진 emphasis, link, table, fence
- 열린 fence가 plain code로 보이고 닫힌 뒤 highlight되는 전이
- unknown language fallback과 code 원문 copy
- `<script>`, event attribute, `javascript:`, `data:`, `command:`, remote image 차단
- `http`/`https` link가 webview를 이동시키지 않고 opener를 호출하는지
- user message와 assistant response가 같은 Markdown 모듈·보안 정책을 사용하면서 각자의 기존 시각 variant를 유지하는지
- streaming append 뒤 변경되지 않은 DOM node identity가 유지되고, 최종 DOM이 깨끗한 전체 렌더 결과와 같은지
- sanitizer가 morph보다 먼저 실행되고 구조를 바꾸는 Markdown 갱신도 올바른 최종 DOM으로 수렴하는지
- stale async highlight가 새 turn/source를 덮지 않는지
- 긴 table/code가 메시지 폭을 넓히지 않고 내부 scroll되는지
- 긴 streaming response의 frame time과 parse 횟수

## 구현 순서

1. `marked`와 `DOMPurify` 기반 parser/sanitizer 및 보안 테스트
2. `morphdom` 경계를 가진 shared Markdown component와 typography/table/link 스타일
3. `Message.tsx`의 user/assistant 본문에 연결하고 기존 시각 variant 유지
4. code language/copy/plain fallback
5. Shiki lazy highlight와 stale-result 방지
6. streaming·긴 응답 성능 측정
7. 필요한 경우에만 stable-block/live-tail 및 worker 도입

이 순서는 Markdown 본문이 먼저 end-to-end로 동작한 뒤 코드 경험과 성능을 층별로 더한다. 기존 thread subscription과 delta 누적 계약은 변경하지 않는다.
