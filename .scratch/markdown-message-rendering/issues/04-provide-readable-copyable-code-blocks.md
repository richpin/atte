# 04: 읽고 복사할 수 있는 code block을 제공한다

**What to build:** fenced code를 일반 본문과 구분되는 읽기 쉬운 block으로 표시하고, 사용자가 정확한 원문 코드를 복사할 수 있게 한다. 아직 닫히지 않은 fence와 알 수 없는 언어도 기다리거나 오류를 보이지 않고 즉시 plain code로 표시하며, 긴 줄은 스레드가 아니라 code block 안에서 스크롤된다.

**Blocked by:** `01-render-safe-markdown-message-bodies.md` — 01: 공용 메시지 본문에 안전한 기본 Markdown을 렌더링한다

**Status:** completed

- [x] fenced code가 독립된 code block으로 렌더링되고 알려진 language label이 정규화되어 표시된다.
- [x] language가 없거나 알 수 없어도 전체 source가 plain code로 표시된다.
- [x] closing fence가 없는 source도 현재까지의 code를 즉시 읽을 수 있게 표시한다.
- [x] 긴 code line은 code block 내부에서 가로 스크롤되고 메시지와 스레드 폭을 늘리지 않는다.
- [x] code block마다 keyboard로 조작 가능한 copy control이 제공된다.
- [x] copy는 렌더되거나 장식된 DOM이 아니라 exact code source를 clipboard에 쓴다.
- [x] copy 성공 시 버튼의 visual state와 accessible label이 약 2초간 Copied 상태가 되고 screen reader announcement가 제공된다.
- [x] copy 실패 시 success state를 표시하지 않고 code block에 국한된 짧은 오류 feedback을 제공한다.
- [x] 반복 copy는 기존 feedback timer를 안전하게 갱신하고 component 제거 시 timer와 listener가 정리된다.
- [x] Apply, 실행, preview, Mermaid와 code wrapping control은 추가하지 않는다.
- [x] 공용 Markdown UI 테스트가 open fence, unknown language, overflow, exact-source copy, 성공·실패 feedback과 접근성을 검증한다.

## Comments

- 구현 완료. 공용 Markdown UI seam에서 open·unknown fence, overflow, exact-source copy, 성공·실패 접근성 feedback, 반복 copy와 cleanup을 검증했다. `pnpm validate`와 `pnpm build`가 통과했다.
