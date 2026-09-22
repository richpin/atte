# 01: 공용 메시지 본문에 안전한 기본 Markdown을 렌더링한다

**What to build:** 사용자 메시지와 에이전트 응답을 하나의 공용 Markdown 렌더러로 표시한다. 사용자가 작성하고 에이전트에 전달되는 source는 그대로 유지하면서, 스레드 타임라인에서는 일반적인 Markdown 구조가 읽기 좋은 형태로 보인다. 두 참여자의 기존 시각적 구분과 긴 사용자 메시지 접기는 유지하고, 모든 렌더링 결과는 메시지 본문 안에 격리된 보안 경계를 통과한다.

**Blocked by:** None (can start immediately)

**Status:** completed

- [x] 사용자 메시지와 에이전트 응답이 동일한 공용 Markdown 모듈을 사용하고, 입력창과 outbound source는 plain text 그대로 유지된다.
- [x] CommonMark 문단, 제목, 강조, 목록, blockquote, 인라인 코드와 채팅형 단일 줄바꿈이 렌더링된다.
- [x] GFM 표, 취소선과 task list가 렌더링되며 task list checkbox는 읽기 전용이다.
- [x] 사용자 메시지는 기존 dark bubble을, 에이전트 응답은 기존 flat body를 유지한다.
- [x] Markdown 제목과 typography는 메시지 지역의 의미·시각 계층을 사용하고 scoped Tailwind 스타일이 바깥 스레드 요소에 영향을 주지 않는다.
- [x] 표와 긴 본문이 메시지 또는 스레드 폭을 늘리지 않으며 넓은 표는 본문 내부에서 가로 스크롤된다.
- [x] raw HTML은 실행되거나 사라지지 않고 문자 그대로 표시된다.
- [x] 모든 parser 결과가 엄격한 sanitizer allowlist를 거친 뒤에만 live DOM에 반영되고 script, iframe, form, event attribute와 임의 style은 허용되지 않는다.
- [x] 일반 plain text와 malformed Markdown도 원문을 잃지 않고 읽을 수 있으며 렌더 실패 시 전체 source가 안전한 plain text로 표시된다.
- [x] 기존 약 20줄 기준의 사용자 메시지 접기·펼치기가 렌더된 높이와 resize에 따라 계속 동작한다.
- [x] 공용 Markdown UI 테스트가 문법, 보안, semantic structure와 fallback을 사용자에게 보이는 DOM으로 검증한다.
- [x] 얇은 메시지 통합 테스트가 사용자·에이전트 본문 연결, 시각적 variant와 기존 접기 동작을 검증한다.

## Comments

- 구현 완료. `pnpm validate`에서 정적 검사, FSD 검사, typecheck와 전체 105개 테스트가 통과했고 `pnpm build`도 성공했다.
