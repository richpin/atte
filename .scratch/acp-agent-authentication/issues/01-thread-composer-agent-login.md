# 01: ThreadComposer에서 에이전트 로그인 및 자동 재연결

**What to build:** 인증이 필요한 스레드의 입력창을 ACP 로그인 흐름으로 교체한다. 사용자는 스레드를 떠나지 않고 에이전트가 제공한 방법으로 로그인하고, 로그인 중에도 다른 스레드를 이용하며, 완료 후에는 현재 보고 있는 작업만 필요할 때 재연결한다. 인증 상태와 작업은 에이전트 단위로 공유하고, 취소·늦은 결과·자동 재연결을 안전하게 처리한다.

**Blocked by:** None (can start immediately)

**Status:** completed

- [x] 스레드가 실제 `authenticationRequired`를 받은 경우에만 프롬프트 입력이 인증 UI로 교체되며, `unknown` 상태는 입력을 막지 않는다.
- [x] 인증 UI는 로그인 방법을 자동으로 조회하고 로딩, 인라인 오류, `다시 시도`를 표시한다.
- [x] 지원되는 인증 방법은 에이전트가 광고한 순서·이름·선택적 설명을 보존하며, 알 수 없는 인증 kind는 실행하지 않는다.
- [x] 로그인을 시작하면 모든 방법 버튼이 선택한 방법의 `로그인 진행 중`과 `취소` 동작으로 교체된다.
- [x] 하나의 에이전트에는 한 번에 하나의 인증 작업만 있으며, 같은 에이전트를 쓰는 다른 인증 필요 스레드도 같은 진행·취소 상태를 표시한다.
- [x] 어느 관련 스레드에서든 취소하면 Atte가 인증 결과를 더 이상 기다리지 않고 버튼을 다시 활성화하며, 늦게 도착한 결과를 무시한다.
- [x] Terminal 인증 취소는 Atte의 대기와 setup 자원만 종료하며, 이미 Terminal에서 시작된 외부 명령을 종료했다고 표시하지 않는다.
- [x] 로그인 중 다른 스레드로 이동해도 인증은 계속된다.
- [x] 로그인 완료 시 원래 스레드가 아직 선택되어 있으면 한 번 자동 재연결하고, 다른 스레드를 보고 있으면 아무 스레드도 백그라운드에서 재연결하지 않는다.
- [x] 로그인된 에이전트의 인증 실패 스레드를 나중에 선택하면 한 번 자동 재연결하며, 다시 인증이 필요하면 로그인 UI로 돌아간다.
- [x] 인증이 아닌 이유로 재연결이 실패하면 기존 일반 연결 실패와 `다시 연결` 흐름을 사용한다.
- [x] 인증 UI로 전환해도 초안과 대기 메시지를 보존하고, 로그인과 재연결 후에도 자동 전송하지 않는다.
- [x] 타임라인의 인증 실패 설명은 유지하되 중복되는 관리 페이지 이동과 인증 상태의 `다시 연결` 동작은 제거된다.
- [x] 앱 통합 테스트와 ACP fixture 통합 테스트가 사용자 흐름, 에이전트 단위 공유, 취소, stale 결과, 재연결, 초안·대기 메시지 보존을 외부 동작으로 검증한다.

## Comments

- Added an app-scoped, agent-keyed authentication state machine and inline composer login flow.
- Added cancellable ACP authentication with operation generations so cancelled or late results cannot mutate agent state.
- Added integration coverage for shared authentication, cancellation, stale completion, navigation-sensitive reconnects, and draft/queue preservation.
- Review follow-up gates automatic reconnect on the login origin, waits for backend cancellation cleanup before re-enabling methods, and verifies an immediate retry is no longer busy.
- Focused verification passed: `pnpm exec vitest run src/app/App.test.tsx`, `pnpm typecheck`, `pnpm check`, `pnpm check:fsd`, targeted Cargo integration tests, and strict Clippy.
