# 01: ACP 에이전트 세션 제목을 end-to-end로 동기화한다

**Status:** complete

**Blocked by:** None

**What to build:** [명세](../spec.md)의 정책에 따라 ACP `session_info_update`를 해당 스레드의 제목에 반영하고 기존 metadata 저장·목록 구독·스레드 구독을 통해 화면과 재실행 후 상태를 일치시킨다.

- [x] SDK의 기존 SessionInfoUpdate/MaybeUndefined 타입으로 생략·null·문자열을 구분한다.
- [x] 알림을 replay/active 분기보다 먼저 처리하고 idle/load/resume에서도 받는다.
- [x] 세션 route 및 generation으로 다른 스레드와 오래된 실행을 격리한다.
- [x] 새 draft의 첫 입력만 잠정 제목을 설정하도록 비영속 정책 상태를 두고 에이전트 제목을 후속 입력이 덮어쓰지 않게 한다.
- [x] 문자열은 보존하고 null은 빈 저장 제목/기본 표시로 처리한다. 동일 제목은 중복 publish하지 않는다.
- [x] 기존 publish/save/subscription 경로를 재사용하고 lastPromptAt과 작업 상태를 유지한다.
- [x] 기존 UI의 사이드바 및 헤더에서 실시간 변경과 빈 제목 기본 표시를 검증한다.
- [x] fixture 통합 테스트와 Rust 단위 테스트로 lifecycle, 부분 갱신, 중복, 격리, persistence 및 저장 실패를 검증한다.
- [x] docs/database.md를 동기화 정책에 맞춰 갱신한다. README·schema·의존성은 변경하지 않는다.
- [x] Cargo fmt/clippy, 관련 Rust 테스트 및 pnpm validate를 통과한다.

## Comments

2026-10-01: 구현 완료. 제목 알림을 기존 route/generation 및 저장·구독 경로에 연결하고 첫 입력 제목 정책을 비영속 플래그로 관리한다. 기존 헤더와 사이드바의 기본 제목 표시를 재사용한다. updatedAt/_meta 동기화, session/new 응답 이전 알림 buffer, 연결되지 않은 세션 polling과 session/list 조회는 추가하지 않았다.

검증: `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test --locked` 통과. Rust 테스트 179개 통과, 기존 실제 Codex 로그인 필요 테스트 4개 ignored. `pnpm validate` 통과: lint/FSD/typecheck 및 19개 파일의 테스트 174개 통과. 제목 테스트는 긴 문자열·생략·null·중복·generation 차단·저장 실패·load/resume·재실행 복원 및 구독 기반 헤더/사이드바 변경을 검증했다.
