# 에이전트 응답의 Markdown 렌더링 조사

조사일: 2026-09-21. 공식 제품 문서, 공식 공개 소스, 프로토콜·Markdown 명세만 확인했다. 실제 제품 UI의 비공개 구현이나 문서에 없는 동작은 추정으로 구분했다. 이 문서는 구현 명세나 ADR이 아니라 후속 설계를 위한 조사 결과다.

## 결론

Atte는 에이전트의 텍스트 응답을 Markdown으로 렌더링해야 한다.

가장 직접적인 근거는 모델의 일반적인 출력 습관이 아니라 Atte가 사용하는 Agent Client Protocol(ACP)이다. ACP v1의 `ContentBlock::Text`는 텍스트가 일반 텍스트이거나 Markdown일 수 있다고 정의하고, **클라이언트가 이 텍스트를 Markdown으로 렌더링해야 한다(`SHOULD`)**고 명시한다. [ACP v1 schema의 text content 정의](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L3343-L3379)

일반 텍스트도 유효한 Markdown 입력이므로 별도의 “plain text 또는 Markdown” 판별은 필요하지 않다. 모든 텍스트 응답을 제한된 Markdown 문법으로 해석하면 일반 텍스트는 그대로 보이고, 구조화된 응답만 제목·목록·코드 블록 등으로 표현된다. CommonMark도 모든 문자 시퀀스를 유효한 문서로 정의한다. [CommonMark 0.31.2 §2.1](https://spec.commonmark.org/0.31.2/#characters-and-lines)

제품 비교에서 공통적으로 확인되는 최소 경험은 다음과 같다.

- 문단, 제목, 강조, 목록, 인라인 코드, 링크 같은 본문 서식
- 언어가 표시되고 구문 강조가 적용되는 fenced code block
- 코드 블록 단위 복사
- 제품 성격에 따라 파일에 삽입·적용하는 추가 동작
- 스트리밍 중에도 누적된 Markdown 응답을 표시하는 구조

Atte의 첫 범위는 CommonMark 중심 본문과 GFM의 실용적인 일부(표, 취소선, task list)를 안전하게 렌더링하고, 코드 블록에 언어 표시·구문 강조·복사를 제공하는 정도가 적절하다. raw HTML, 명령 링크, 원격 이미지, 수식, Mermaid/실행 가능한 preview는 같은 “Markdown 지원”으로 한꺼번에 포함하지 말고 별도 기능으로 판단해야 한다.

## 왜 Markdown이 필요한가

### 1. ACP의 표시 계약이다

ACP의 텍스트 블록은 별도 `format` 필드 없이 문자열 하나를 전달하지만, 그 문자열이 Markdown일 수 있으며 클라이언트에 Markdown 렌더링을 권고한다. 즉 Atte가 일반 텍스트로만 표시하면 프로토콜상 유효한 에이전트 응답에서 제목, 목록, 링크, 코드 fence가 원문 기호로 노출된다. [ACP v1 `ContentBlock`](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L3333-L3382)

ACP는 응답을 `session/update`로 스트리밍한다. 따라서 렌더러는 완성된 한 문자열만 받는다고 가정할 수 없고, chunk를 순서대로 누적하는 현재 스레드 모델 위에서 동작해야 한다. [ACP protocol overview의 message flow](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx#message-flow)

### 2. 모델과 코딩 제품이 Markdown을 실제 출력 형식으로 사용한다

OpenAI는 ChatGPT의 응답 스타일 설정을 “more markdown”이라고 부르며 제목, 목록, 표를 예로 든다. ChatGPT의 코드 블록에는 언어 레이블과 복사 동작이 있다. [ChatGPT Characteristics](https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt), [ChatGPT writing/code blocks](https://help.openai.com/en/articles/20001246)

Anthropic의 공식 prompting 문서는 Claude 응답에서 Markdown 사용량을 조절하는 방법을 안내하며 인라인 코드, fenced code block, 제목, 굵게·기울임, 목록을 구체적으로 언급한다. 이는 Claude가 기본적으로 이런 구문을 출력할 수 있음을 확인해 주지만, Claude 앱의 정확한 Markdown parser나 전체 지원 dialect를 공개한 문서는 아니다. [Claude prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#control-the-format-of-responses)

GitHub Copilot과 Cursor도 코드 블록을 단순 문자열이 아니라 별도 UI 단위로 다룬다. GitHub Copilot은 코드 블록의 복사·커서 삽입·새 파일 삽입·터미널 삽입 동작을 문서화했고, Cursor는 chat code block에 Apply 동작을 제공해 왔다. [GitHub Copilot Chat in IDE](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/get-started-with-chat-in-your-ide#write-code), [Cursor Apply Button v2](https://cursor.com/changelog/0-23-x)

## 제품별 확인 결과

| 제품 | 공식 근거로 확인된 응답 표시 | 확인되지 않았거나 별도 기능인 항목 |
| --- | --- | --- |
| ChatGPT | 제목·목록·표를 Markdown 서식으로 사용한다. 코드 블록은 언어 레이블과 복사를 제공하며, 일부 블록은 편집·전체 화면·preview·실행도 지원한다. | 일반 응답 renderer의 정확한 dialect, raw HTML 정책, 스트리밍 parser 구현은 공식 문서에서 확인하지 못했다. Mermaid·HTML·React·SVG·Vega preview는 지원되는 코드 블록에만 붙는 별도 기능이다. |
| Claude | 공식 prompting 문서가 인라인 코드, fenced code block, 제목, 굵게·기울임, 목록 등 Markdown 출력을 전제로 한다. 최신 모델의 수학 출력은 LaTeX를 기본으로 한다고 안내한다. | Claude 앱의 정확한 Markdown dialect, 표·LaTeX의 실제 renderer 범위, raw HTML 정책은 공식 문서에서 확인하지 못했다. Artifacts는 Markdown 문서·코드·HTML·SVG·diagram·React를 채팅 옆 전용 창에 표시하는 별도 surface다. |
| GitHub Copilot | 응답은 구문 강조·들여쓰기 등으로 format된다. 코드 블록에는 IDE별로 복사, 커서/새 파일/터미널 삽입, preview가 제공된다. 공식 예시는 Markdown 표와 Mermaid fenced code를 생성한다. | 공식 표·Mermaid 문서는 결과를 복사해 Markdown 지원 위치에 붙이는 흐름을 설명하므로 Copilot Chat 자체의 표·Mermaid native rendering까지 증명하지는 않는다. |
| VS Code Chat / Copilot Chat | Chat API는 CommonMark 문법의 Markdown fragment를 스트리밍한다. 제목, 강조, 링크, 이미지가 예시로 문서화되어 있고, fenced code block은 IntelliSense·formatting·editor 적용 동작을 제공한다. chat 본문과 code block typography도 별도 설정이다. | 표는 CommonMark 표준에 없으므로 API 문서만으로 보장되지 않는다. 명령 링크는 일반 링크와 달리 명시적 trust allowlist가 필요하다. |
| Cursor | 공식 changelog가 chat의 code block과 Apply 동작을 확인해 준다. 현재 공식 Agent 문서는 생성 이미지를 chat 안에 inline 표시한다고 설명한다. | 공개 문서는 일반 응답의 Markdown dialect, 표·수식·raw HTML·스트리밍 renderer를 규정하지 않는다. 따라서 “VS Code fork이므로 VS Code와 완전히 같다”고 추정하면 안 된다. |

### ChatGPT

ChatGPT는 Markdown을 선택 가능한 응답 서식으로 명시한다. “Use more markdown” 설정의 예가 제목, 목록, 표이고, writing block은 굵게·기울임, 제목, 링크, 번호/글머리 목록, checklist를 지원한다. [ChatGPT Characteristics](https://help.openai.com/en/articles/20001038-characteristics-in-chatgpt), [writing block formatting](https://help.openai.com/en/articles/20001246#h_1c10069601)

코드 블록은 본문과 분리되어 언어 레이블과 복사를 제공한다. 지원되는 블록에는 편집, 전체 화면, Code/Preview 전환, Python 실행 같은 동작도 붙는다. HTML, React, SVG, Mermaid, Vega/Vega-Lite는 일반 Markdown 본문 기능이라기보다 **지원되는 코드 블록의 sandboxed preview**다. 외부 리소스가 필요한 preview는 권한을 요청할 수 있다. [ChatGPT code blocks and preview](https://help.openai.com/en/articles/20001246#h_fa6b9d3988)

따라서 Atte에 직접 적용할 검증된 패턴은 “본문 Markdown + 별도 code block chrome + 복사”다. 실행과 preview는 첫 Markdown renderer의 필수 범위가 아니다.

### Claude

Anthropic은 응답 format 제어 예시에서 Markdown의 인라인 코드, fenced code block, 제목, 굵게·기울임, 순서/비순서 목록을 직접 언급한다. 같은 문서는 최신 Claude 모델이 수학 표현에 LaTeX를 기본 사용한다고 설명한다. 이는 출력에 Markdown/LaTeX가 들어올 수 있다는 근거다. [Claude response formatting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#control-the-format-of-responses), [Claude LaTeX output](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices#latex-output)

Claude의 Artifacts는 채팅 응답 본문과 구분해야 한다. Markdown/plain text 문서, 코드, HTML, SVG, diagram, React component를 채팅 오른쪽 전용 창에서 표시한다. 따라서 Claude가 이런 결과를 지원한다는 사실은 일반 메시지 Markdown renderer가 HTML이나 diagram을 직접 실행한다는 증거가 아니다. [Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)

Claude 앱 renderer의 공개 명세를 찾지 못했으므로 “GFM 전체 지원”, “표 native rendering”, “raw HTML 허용” 같은 주장은 하지 않는다.

### GitHub Copilot

GitHub은 Copilot Chat 응답을 구문 강조, 들여쓰기, 문맥 링크 등으로 format한다고 설명한다. [GitHub Copilot Chat application card](https://docs.github.com/en/copilot/responsible-use/chat#performance)

특히 코드 블록은 IDE별로 복사뿐 아니라 커서, 새 파일, 터미널에 삽입하거나 결과를 preview하는 동작을 제공한다. 모든 surface에 같은 action이 있는 것은 아니다. [Copilot Chat in IDE](https://docs.github.com/en/copilot/how-tos/chat-with-copilot/get-started-with-chat-in-your-ide#write-code)

공식 cookbook은 Copilot이 Markdown 표를 생성하고 Mermaid fenced code를 생성할 수 있음을 보여준다. 다만 설명은 생성 결과를 복사해 문서나 GitHub의 Markdown surface에 붙이는 흐름이므로, 이것만으로 Chat 패널 자체가 표나 Mermaid diagram을 render한다고 결론 내리지 않는다. [Generating tables](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/generating-tables), [Creating diagrams](https://docs.github.com/en/copilot/tutorials/copilot-cookbook/communicate-effectively/creating-diagrams)

### VS Code Chat / Copilot Chat

VS Code의 공개 Chat Participant API는 가장 구체적인 비교 근거다. 응답에 CommonMark 문법의 Markdown을 사용할 수 있고, 공식 예시는 제목, 기울임·굵게, 링크, 이미지를 여러 `stream.markdown(...)` 호출로 보낸다. 즉 Markdown과 streaming을 별도 개념으로 나누지 않고 **Markdown fragment stream을 누적 표시**하는 API다. [VS Code Chat Participant API: Markdown output](https://code.visualstudio.com/api/extension-guides/ai/chat#markdown-output)

fenced code block은 IntelliSense, code formatting, active editor에 적용하는 interaction을 제공한다. 채팅 설정도 Markdown 본문 글꼴과 code block 글꼴·크기·굵기·행 높이·줄바꿈을 구분한다. [VS Code Chat Participant API: code block](https://code.visualstudio.com/api/extension-guides/ai/chat#code-block), [VS Code chat display settings](https://code.visualstudio.com/docs/chat/chat-overview#_customize-the-chat-display)

링크는 보안 경계를 가진다. 일반 웹 링크와 달리 `command:` 링크는 신뢰된 명령 ID를 명시적으로 allowlist한 `MarkdownString`에서만 작동한다. 서비스에서 받은 Markdown에 무조건 command 실행 권한을 주면 command injection 위험이 있다고 공식 문서가 경고한다. [VS Code command link trust](https://code.visualstudio.com/api/extension-guides/ai/chat#command-link)

### Cursor

Cursor의 공식 changelog는 chat code block에 Apply 동작이 존재함을 명확히 보여준다. [Cursor Apply Button v2](https://cursor.com/changelog/0-23-x)

현재 Agent 문서는 생성된 이미지를 프로젝트의 `assets/`에 저장하고 chat 안에 inline 표시한다고 설명한다. 이는 구조화된 이미지 결과의 표시 근거이지 Markdown image syntax 전체 지원의 근거는 아니다. [Cursor Agent: image generation](https://cursor.com/docs/agent/overview#image-generation)

Cursor는 비공개 제품 부분이 크고 현재 공개 문서에 Markdown dialect가 명시되지 않는다. 코드 블록과 inline image는 확인됐지만, CommonMark/GFM 전체, 표, 수식, Mermaid, raw HTML, streaming parser의 동작은 미확인으로 남긴다.

## 문법별 판단

| 기능 | 업계·프로토콜 근거 | Atte의 첫 범위 판단 |
| --- | --- | --- |
| 문단·줄바꿈 | 모든 조사 제품의 기본 본문, CommonMark 핵심 | 포함 |
| 제목·강조·목록·blockquote | ChatGPT, Claude, VS Code에서 공식 확인 | 포함 |
| 인라인 코드 | Claude, VS Code/CommonMark에서 확인 | 포함 |
| fenced code block | 모든 코딩 제품에서 핵심 UI 단위 | 포함 |
| 언어 레이블·syntax highlight·copy | ChatGPT, GitHub Copilot, VS Code에서 확인 | 포함 |
| 링크 | ChatGPT와 VS Code에서 확인 | `http`/`https` 등 안전한 scheme만 포함 |
| 표 | ChatGPT가 서식으로 명시하고 Copilot이 Markdown 표를 생성 | GFM 표 포함, 좁은 화면에서는 가로 스크롤 |
| 취소선·task list | GFM의 널리 쓰이는 확장; ChatGPT checklist 확인 | 낮은 비용이면 포함 |
| Markdown 이미지 | VS Code CommonMark output에서 확인, ACP에는 별도 image content도 존재 | 기본 비활성 또는 별도 정책. structured image와 구분 |
| 수식 | Claude가 LaTeX를 출력할 수 있음 | 후속 범위. Markdown 표준이 아니고 별도 parser 필요 |
| Mermaid·diagram | ChatGPT preview, Claude Artifact, Copilot 생성에서 확인 | 후속 범위. code block을 기본적으로 실행하지 않음 |
| raw HTML | CommonMark에는 포함되지만 안전한 chat UI에는 추가 sanitization 필요 | 비활성화하고 문자 그대로 표시 |
| 명령·앱 deep link | VS Code도 별도 trust allowlist 요구 | 첫 범위에서 비활성. 도입 시 scheme·명령 allowlist |

### dialect

CommonMark를 기준으로 삼는 것이 가장 보수적이다. VS Code Chat API도 CommonMark를 명시한다. 다만 coding-agent가 비교표와 checklist를 자주 출력하고 ChatGPT/GitHub 문서도 이를 사용하므로, 사용자 가치가 높은 GFM 확장 중 표, 취소선, task list 정도를 명시적으로 더하는 것이 적절하다.

“GFM 지원”이라고 표현할 때는 raw HTML까지 그대로 실행한다는 의미가 되어서는 안 된다. GFM 자체도 GitHub.com이 HTML 변환 뒤 보안과 일관성을 위해 추가 sanitization을 수행한다고 명시한다. [GitHub Flavored Markdown spec](https://github.github.com/gfm/#what-is-github-flavored-markdown)

## 스트리밍 렌더링

확인된 사실은 다음과 같다.

- ACP는 모델 출력을 `session/update` 알림으로 stream한다. [ACP overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx#message-flow)
- VS Code Chat API는 하나의 응답에서 `stream.markdown(...)`을 여러 번 호출하며, code fence의 시작·내용·끝도 서로 다른 호출에 걸칠 수 있는 예시를 제공한다. [VS Code streaming Markdown example](https://code.visualstudio.com/api/extension-guides/ai/chat#markdown-output)
- Markdown token은 chunk 경계와 일치하지 않는다. 예를 들어 `**`, 링크 destination, code fence, 표 행은 여러 chunk에 나뉠 수 있다. 이는 위 streaming 계약에서 도출되는 구현 제약이다.

따라서 후속 구현에서는 chunk 하나를 독립 Markdown 문서로 render하면 안 된다. 동일한 에이전트 메시지의 원문을 순서대로 누적한 뒤 누적 문자열을 render해야 한다. 매 token마다 비싼 전체 DOM 작업을 강제할 필요는 없고, UI update를 짧게 coalesce하되 turn 완료 시 최종 누적 원문으로 한 번 더 render하는 방식이 안전하다. 이 문단은 제품 문서에 명시된 내부 구현을 복제한 것이 아니라 ACP/VS Code의 공개 streaming 계약에서 도출한 권고다.

미완성 fence나 링크가 잠시 생기는 것은 정상적인 streaming 상태다. renderer가 이를 오류로 처리하기보다 현재까지 유효한 문서로 표시하거나 안전한 plain-text fallback을 제공해야 한다. 사용자가 복사할 때는 렌더된 DOM이 아니라 누적된 원문 Markdown 또는 code block 원문을 기준으로 해야 한다.

## 보안과 개인정보 경계

에이전트 응답은 신뢰할 수 없는 입력으로 취급해야 한다. 모델 자체의 실수뿐 아니라 읽은 repository 문서, 웹 검색 결과, tool output의 prompt injection이 응답 문자열에 영향을 줄 수 있기 때문이다.

### raw HTML

CommonMark 문법에는 raw HTML block과 inline raw HTML이 포함되며 HTML output에서 escape되지 않는다. [CommonMark raw HTML blocks](https://spec.commonmark.org/0.31.2/#html-blocks), [CommonMark raw HTML](https://spec.commonmark.org/0.31.2/#raw-html)

따라서 “CommonMark parser를 사용한다”만으로 안전하지 않다. Atte는 raw HTML parsing/rendering을 끄고 `<script>`, event handler, `iframe`, `style`뿐 아니라 모든 임의 HTML을 문자 그대로 표시하는 것이 가장 단순하다. 꼭 HTML 일부가 필요해지는 경우에만 tag·attribute allowlist와 검증된 sanitizer를 별도 도입해야 한다. GitHub도 GFM 변환 후 추가 sanitization을 수행한다. [GFM security note](https://github.github.com/gfm/#what-is-github-flavored-markdown)

### 링크와 이미지

- 링크는 `http:`와 `https:`를 기본 허용하고, `javascript:`, `data:`, 임의 `command:`/custom scheme은 차단해야 한다.
- 로컬 `file:` 링크나 앱 deep link는 workspace 경계, 경로 정규화, 명시적 user action을 포함한 별도 정책이 필요하다.
- 원격 Markdown 이미지를 자동 로드하면 사용자의 IP, 접근 시각, 추적 query가 외부 서버에 노출될 수 있다. 첫 범위에서는 remote image를 로드하지 않거나 명시적 클릭 후 로드하는 편이 안전하다.
- ACP의 structured `ImageContent`는 Markdown image와 별개다. agent가 명시적으로 전달한 MIME type·bytes를 검증해 표시하는 경로와, text 안의 임의 URL을 가져오는 경로를 섞지 않는다. [ACP v1 image content](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json#L3380-L3412)

VS Code가 `command:` 링크를 일반 링크보다 더 엄격하게 다루고 명령 ID allowlist를 요구하는 것도 같은 경계의 선례다. [VS Code command link trust](https://code.visualstudio.com/api/extension-guides/ai/chat#command-link)

### code block과 diagram

code block은 표시와 복사만으로도 가치가 있다. 내용이 `bash`, `html`, `mermaid`라고 해서 실행하거나 preview해서는 안 된다. ChatGPT도 실행·preview를 별도 action과 sandbox로 제공한다. [ChatGPT code preview security](https://help.openai.com/en/articles/20001246#h_15d7f2a603)

## Atte에 대한 최소 권고

구현 시점의 가장 작은 완결 범위는 다음과 같다.

1. 에이전트 `TextContent`를 제한된 Markdown으로 render한다. plain text도 같은 경로를 사용한다.
2. CommonMark를 기준으로 하고 GFM의 table, strikethrough, task list만 명시적으로 추가한다.
3. fenced code block을 별도 시각 단위로 만들고 언어 레이블, syntax highlight, block-level copy를 제공한다. 언어를 알 수 없으면 plain text로 표시한다.
4. raw HTML과 실행 가능한 content는 끈다. 링크 scheme은 allowlist하고, remote image·local file·app command는 별도 정책 전에는 자동 실행하거나 로드하지 않는다.
5. streaming chunk는 메시지 원문에 누적한 뒤 누적 문서를 render한다. parser 오류나 미완성 syntax가 UI 전체를 깨뜨리지 않도록 plain-text fallback을 둔다.
6. 넓은 표와 긴 코드 줄은 메시지 전체 폭을 늘리지 않도록 해당 block 안에서 가로 스크롤한다.
7. Markdown source를 원본으로 유지한다. 접근성 tree, selection, copy, 검색이 canvas가 아니라 실제 text/semantic element를 기준으로 동작해야 한다.

첫 범위에서 제외해도 ACP 준수와 핵심 사용성에 문제가 없는 항목은 수식, Mermaid, HTML/React/SVG preview, 코드 실행, editor Apply, command link, 원격 이미지 자동 표시다. 이들은 사용 사례와 보안 모델이 확정된 뒤 독립 기능으로 추가할 수 있다.

## 최종 판단

Markdown 렌더링은 필요하다. 근거의 우선순위는 다음과 같다.

1. ACP가 text content의 Markdown 렌더링을 클라이언트에 권고한다.
2. ChatGPT와 Claude는 공식 문서에서 Markdown 형식의 응답을 전제로 한다.
3. GitHub Copilot, VS Code Chat, Cursor는 특히 code block을 syntax-aware한 상호작용 단위로 취급한다.
4. coding-agent 응답의 코드, 목록, 비교표, 링크를 plain text로만 보여주면 정보 구조와 작업 효율을 잃는다.

다만 “Markdown 지원”은 임의 HTML이나 실행 가능한 preview를 허용한다는 뜻이 아니다. Atte에는 **안전한 제한 Markdown + 강한 code block 경험**이 우선이며, 수식·diagram·preview는 후속 확장으로 분리하는 것이 기존 제품의 경계와도 맞는다.
