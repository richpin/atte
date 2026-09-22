# 05: 스트리밍 code block에 lazy syntax highlighting을 적용한다

**What to build:** 사용자가 source를 즉시 읽을 수 있는 code block 경험을 유지하면서, 완성된 fence에는 필요한 언어만 지연 로드해 구문 강조를 적용한다. 스트리밍 중 source가 계속 변하더라도 오래된 비동기 결과가 최신 code를 덮지 않고, highlighter 실패는 해당 block을 plain code로 남긴다.

**Blocked by:** `02-reconcile-streaming-markdown.md` — 02: 스트리밍 Markdown을 프레임 단위로 안전하게 조정한다; `04-provide-readable-copyable-code-blocks.md` — 04: 읽고 복사할 수 있는 code block을 제공한다

**Status:** completed

- [x] syntax highlighter는 최초로 필요한 시점에만 초기화되고 모든 grammar를 선행 로드하지 않는다.
- [x] code fence의 정규화된 language에 필요한 grammar만 load한다.
- [x] open fence는 plain code로 유지되고 fence가 닫히거나 turn이 완료되면 highlight 대상으로 전환된다.
- [x] highlighter와 grammar load를 기다리는 동안에도 전체 source와 copy control을 즉시 사용할 수 있다.
- [x] 지원하지 않는 language는 error나 빈 화면 없이 plain code로 유지된다.
- [x] highlight 결과는 language와 exact source generation에 대응하며 오래된 결과가 더 최신 source를 덮지 않는다.
- [x] completed code의 동일 language와 source에 대한 highlight 결과는 안전하게 재사용할 수 있다.
- [x] highlighting DOM은 sanitizer 보안 경계를 우회하지 않고 copy source를 변경하지 않는다.
- [x] highlighter 초기화, language load 또는 highlight 실패는 해당 code block만 plain code로 유지하고 메시지 전체를 실패시키지 않는다.
- [x] component disposal 시 진행 중인 결과는 무시되고 highlighter 관련 resource와 generation state가 누수되지 않는다.
- [x] 스트리밍 테스트가 open-to-closed 전환, lazy language load, stale-result rejection과 completed render 수렴을 검증한다.
- [x] 실패 테스트가 unknown language와 highlighter 오류에서 source·copy·layout이 계속 동작함을 검증한다.

## Comments

- 2026-09-22: Shiki의 fine-grained core와 JavaScript regex engine을 사용해 highlighter를 최초 highlight 시점에 초기화하고, 정규화된 language grammar만 dynamic import하도록 구현했다. Token text로 안전한 DOM을 구성하고 exact source·language·appearance 기준의 bounded cache와 stale-result guard를 적용했다.
- 2026-09-22: `pnpm validate` 통과(16 files, 132 tests). `pnpm build`로 지원 language와 두 theme만 별도 lazy chunk로 생성되는 것을 확인했다. 구현 및 code review 완료.
