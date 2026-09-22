# 02: 스트리밍 Markdown을 프레임 단위로 안전하게 조정한다

**What to build:** 작은 text delta로 자라는 현재 에이전트 메시지를 자연스럽게 표시하면서 이미 렌더된 동일 부분의 DOM을 보존한다. 누적 source는 최신 상태를 유지하되 화면 작업은 animation frame 단위로 합치고, 완료·취소 같은 terminal update에서는 최신 내용을 즉시 확정한다. 실패하거나 안전한 처리 한계를 넘은 메시지도 자르지 않고 전체 내용을 plain text로 보여준다.

**Blocked by:** `01-render-safe-markdown-message-bodies.md` — 01: 공용 메시지 본문에 안전한 기본 Markdown을 렌더링한다

**Status:** completed

- [x] 스트리밍 중인 현재 메시지만 갱신되고 완료된 이전 메시지와 바깥 스레드 DOM은 다시 렌더링되지 않는다.
- [x] 여러 작은 source update가 한 animation frame 안에 도착하면 parse, sanitize와 DOM 조정이 최대 한 번 수행된다.
- [x] turn 완료, 취소 또는 다른 terminal stop reason에서 마지막 source가 다음 frame을 기다리지 않고 즉시 반영된다.
- [x] 정화한 detached DOM만 morphdom에 전달되고 Solid는 안정된 wrapper만 소유해 같은 하위 DOM을 동시에 조정하지 않는다.
- [x] 단순 append 뒤 변경되지 않은 내용의 DOM node identity가 유지된다.
- [x] append가 아닌 변경과 뒤쪽 문법이 앞쪽 구조를 바꾸는 경우에도 결과가 최신 source의 깨끗한 전체 렌더와 같아진다.
- [x] event delegation이 morph 이후에도 링크·복사 같은 후속 상호작용을 연결할 수 있는 안정된 경계를 제공한다.
- [x] component disposal과 새 generation에서 예약 frame, observer, timer와 오래된 비동기 결과가 정리되거나 무시된다.
- [x] parsing, sanitizing 또는 morphing 실패 시 별도 안내 없이 전체 source가 안전한 plain text로 표시된다.
- [x] 측정 기반 안전 임계값을 넘는 메시지는 숨은 truncation 없이 전체 source를 plain text로 표시한다.
- [x] 높이 변경은 사용자가 최신 위치에 있을 때만 기존 최신 위치 추적을 따르고, 이전 내용을 읽는 사용자를 아래로 이동시키지 않는다.
- [x] 제어된 animation frame 테스트가 update coalescing, terminal flush, cleanup과 stale-result 거부를 검증한다.
- [x] DOM identity와 fresh-render equivalence 테스트가 incremental update의 안정성과 최종 수렴을 검증한다.

## Comments

- 구현 완료. 현재 parser/sanitizer 경로를 측정했을 때 50,000자 약 23ms, 100,000자 약 45ms, 250,000자 약 113ms의 median이어서 조사 근거와 같은 100,000자를 formatted-render 상한으로 두고 초과 source는 전체 plain text로 표시한다.
- `pnpm build`와 `pnpm validate`가 성공했으며 정적 검사, FSD 검사, typecheck와 전체 112개 테스트가 통과했다.
