# 02: 에이전트 계정 정보 및 로그아웃

**What to build:** 에이전트 관리 페이지에서 현재 앱 실행 중 로그인이 확인된 에이전트의 이메일·요금제와 capability 기반 로그아웃을 제공한다. 사용자는 에이전트 이름으로 확인한 뒤 로그아웃하며, Atte는 성공한 ACP 응답에서만 계정 표시를 제거하고 기존 스레드와 실행 중인 작업을 강제로 변경하지 않는다.

**Blocked by:** 01-thread-composer-agent-login.md

**Status:** completed

- [x] 인증 여부가 확인되지 않았거나 로그아웃된 에이전트 카드에는 인증 영역·로그인 버튼·미인증 안내를 표시하지 않는다.
- [x] 현재 앱 실행 중 로그인이 확인된 에이전트만 인증 영역을 표시하며, 앱 시작 시 모든 에이전트를 실행해 계정을 점검하지 않는다.
- [x] 명시적으로 지원하는 계정 상태 확장에서 이메일과 요금제를 받아 제공된 항목만 텍스트로 표시하고, account label과 조직 정보는 표시하지 않는다.
- [x] 이메일과 요금제가 모두 없어도 에이전트가 ACP logout capability를 광고하고 로그인이 확인됐다면 로그아웃 버튼을 표시한다.
- [x] ACP logout capability를 광고하지 않은 에이전트에는 로그아웃 버튼을 표시하거나 logout 요청을 보내지 않는다.
- [x] 로그아웃 버튼은 에이전트 이름을 사용하는 확인 대화상자를 열고, 요청 중에는 중복 실행할 수 없다.
- [x] 로그아웃이 성공하면 공유 인증 증거와 계정 표시를 제거하지만, 기존 스레드를 인증 실패로 바꾸거나 실행 중인 작업·runtime을 종료하지 않는다.
- [x] 로그아웃이 실패하면 기존 이메일·요금제·로그아웃 동작을 유지하고 인라인 오류를 표시한다.
- [x] 로그아웃 후 기존 스레드가 나중에 `authenticationRequired`를 받으면 01에서 구축한 Composer 로그인 흐름으로 전환된다.
- [x] 앱 통합 테스트와 ACP fixture 통합 테스트가 계정 메타데이터 조합, capability gating, 확인, pending, 성공·실패, 기존 스레드 보존을 외부 동작으로 검증한다.

## Comments

- Added negotiated `authStatus` account metadata, standard capability-gated ACP logout, and an agent-name confirmation flow on the management page.
- Successful logout clears only app-run authentication evidence; failures retain the known account and existing threads/runtimes are left untouched.
- Verification passed for the app integration test, TypeScript typecheck, Biome/FSD checks, strict Clippy, and the ACP session integration target.
