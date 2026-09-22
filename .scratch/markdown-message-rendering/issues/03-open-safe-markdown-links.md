# 03: 안전한 웹 링크와 Markdown 이미지 링크를 제공한다

**What to build:** 메시지 본문의 일반 웹 링크를 hyperlink로 표시하고 사용자의 시스템 브라우저에서 연다. Atte WebView는 링크 대상으로 이동하지 않으며, 위험하거나 승인되지 않은 scheme에는 동작을 부여하지 않는다. Markdown 이미지는 외부 resource를 자동으로 불러오지 않고 읽을 수 있는 링크 형태로만 제공한다.

**Blocked by:** `01-render-safe-markdown-message-bodies.md` — 01: 공용 메시지 본문에 안전한 기본 Markdown을 렌더링한다

**Status:** completed

- [x] absolute `http`와 `https` Markdown link만 활성 hyperlink로 표시된다.
- [x] hyperlink activation은 WebView navigation을 막고 Tauri opener를 통해 시스템 브라우저를 호출한다.
- [x] opener plugin과 capability는 승인된 web URL scheme에 필요한 최소 범위로 구성된다.
- [x] `javascript`, `data`, `file`, `command`, relative URL과 custom scheme은 외부 동작이나 navigation을 만들지 않는다.
- [x] 차단된 destination도 사용자가 읽을 수 있는 label은 유지하며 별도 경고 banner를 표시하지 않는다.
- [x] hyperlink는 추가 confirmation이나 custom tooltip 없이 pointer와 keyboard로 열 수 있다.
- [x] Markdown image syntax는 `img` 또는 다른 resource-loading element를 생성하지 않는다.
- [x] Markdown image는 alt text와 URL을 읽을 수 있게 표시하고, destination이 허용된 web URL일 때만 hyperlink를 제공한다.
- [x] 링크와 이미지 동작은 sanitizer 이후 안정된 wrapper의 event delegation을 사용한다.
- [x] UI 테스트가 허용·차단 URL, keyboard activation, WebView navigation 방지와 opener 호출을 검증한다.
- [x] 테스트가 Markdown image로 네트워크 resource-loading attribute나 element가 생성되지 않음을 검증한다.

## Comments

- 구현 완료. `pnpm validate`에서 정적 검사, FSD 검사, typecheck와 전체 115개 UI 테스트가 통과했고 `pnpm build`도 성공했다. `cargo test --all-targets --all-features --locked`에서 141개 Rust 테스트가 통과하고 4개 수동 통합 테스트가 제외됐다.
