# 05: 작업 중단과 승인 요청 처리

**What to build:** 사용자가 진행 중인 작업을 중단하거나 입력창에 표시된 승인 요청에 응답하고, 같은 대화에서 작업을 계속할 수 있다.

**Blocked by:** [04: Registry 기반 ACP 에이전트 관리 시스템](./04-agent-management.md)

Status: done

## 근거와 범위

부모 명세: [Atte 첫 버전 구현 명세](../spec.md). 관련 사용자 스토리: 24, 30–36.

04에서 앱 내 설치·인증과 대화 왕복을 확보한 상태에서 03의 기본 승인 취소 처리에 사용자 승인 UI를 추가한다. 설치된 실행 정의와 인증 오류 복구 흐름을 사용해 승인·취소를 실제 앱에서 검증하는 것이 완료 조건이므로 04를 선행한다. 다른 대화에 대한 영향과 승인 목록 표시의 통합 검증은 07에서 확장한다.

공통 원칙: macOS 우선, 공통 ACP와 capability 기반 구현, Rust의 공개 대화 인터페이스 중심 테스트, SolidJS의 FSD 구성. 실연결 검증은 Codex로 한정한다. 필요한 테스트를 먼저 작성하고 기존 동작을 유지한다. UI 기준은 `codex/prototype-ui`의 `b591a6e`, ACP 실행 근거는 `codex/prototype-acp-validation`의 `65023dc16fc7d62e6065082f11e138e4b9f8385d`다. 프로토타입은 설계·검증 근거로 사용한다.

## Acceptance criteria

- [x] 작업 중단 버튼이 세션 범위의 취소를 전달하며 프로세스 전체를 종료하거나 대화 기록을 삭제하지 않는다. 취소 후 새 요청을 보낼 수 있다.
- [x] 진행 중인 prompt를 기다리는 동안에도 취소와 승인 응답을 처리한다. 이전 turn 또는 연결의 늦은 이벤트가 다음 실행 상태를 덮어쓰지 않는다.
- [x] 승인 요청이 채팅 본문 대신 입력창을 대체한다. 요청 내용과 작업 폴더를 표시하고, 에이전트가 제공한 선택지의 이름·순서·ID를 사용한다.
- [x] 승인 버튼은 구분선 없이 작업 폴더 안내와 같은 줄 오른쪽에 배치한다. 선택 후 승인 UI가 해소되고 일반 입력창으로 돌아오며 기존 입력 초안을 보존한다.
- [x] 사용자가 고른 정확한 option ID로 한 번만 응답한다. 이미 해소된 요청에 대한 늦은 클릭이나 중복 클릭은 재실행을 유발하지 않는다. 임의 자동 승인이나 고정된 Codex 전용 선택지는 없다.
- [x] 승인 대기 중에도 작업을 중단할 수 있고, 미해결 승인 요청에 ACP cancelled 응답을 보내 대기 중인 도구가 실행되지 않는다.
- [x] 모의 ACP 에이전트의 임의 option ID로 허용·제공된 거절·승인 대기 중 취소·늦은 이벤트를 검증한다. UI 테스트에서 승인 위치와 입력창 복원을 확인한다.
- [x] 04의 관리 화면에서 준비한 Codex로 일반 취소, 승인 요청의 일회 허용, 승인 대기 중 취소와 이후 후속 요청을 전용 테스트 폴더에서 확인한다. 설치·인증·스트리밍 흐름을 유지하며 실제 요청 내용과 선택을 기록하고 관련 자동 검사와 빌드를 통과한다.

## Comments

- 2026-09-17 순서 조정: 기존 04를 05로 이동했다. 설치·인증을 마친 앱에서 승인·취소를 검증하며, 다중 대화 통합은 새 07이 담당한다.

- 기존 첫 티켓을 세 단계로 나누면서 총 8개 작업으로 번호와 선행 링크를 갱신했다. 첫 티켓의 UI는 최소 대화 화면으로 제한하며 이후 UI는 해당 기능과 함께 완성한다.

- 2026-09-17 구현: Rust 공개 대화 인터페이스에 turn ID로 범위를 제한한 `cancel_turn`과 요청 ID·에이전트 option ID를 검증하는 `answer_permission`을 추가했다. 승인 대기는 SDK dispatch loop 밖에서 처리하며, 취소 중 미해결·늦은 승인 요청에는 ACP cancelled를 반환한다. 다음 prompt는 이전 prompt의 종료 응답 이후에만 허용한다.
- 승인 UI는 입력창을 대체하며 작업 내용·폴더와 에이전트가 제공한 이름·순서의 버튼을 표시한다. 선택 후 입력 초안을 복원한다. 여러 승인 요청은 수신 순서로 처리하고 취소는 모두 해소한다.
- TDD: 일반 취소/같은 세션의 후속 요청, 임의 ID 허용·거절/중복·잘못된 응답 거부, 승인 중 취소/늦은 승인 취소를 공개 Rust 경계와 stdio fixture로 검증했다. UI에서는 승인 위치·선택 순서·중복 클릭 방지·초안 복원·취소 후 오래된 snapshot 무시를 검증했다.
- `code-review`: Standards 0개. Spec에서 ID만 포함한 승인 요청의 작업 내용 누락 1개를 발견했다. 선행 tool_call/tool_call_update와 승인 요청의 부분 필드를 turn별로 병합하도록 수정했고 실패를 재현한 회귀 테스트가 통과했다. 양쪽 재검토 남은 지적 0개.
- 프로토콜 근거: [ACP prompt turn/cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation), [tool calls/permissions](https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission), 사용 중인 Rust SDK 2.1.0의 ordering 문서와 schema 1.7.0의 ToolCallUpdate. ACP v1의 session/update에는 turn ID가 없으므로 취소 종료 응답을 다음 turn의 경계로 사용한다. 에이전트가 종료 응답 뒤 이전 turn의 태그 없는 출력을 보내는 프로토콜 위반은 구분할 수 없다.

### 실제 Codex 검증 — 2026-09-17

macOS Apple Silicon, production Tauri 앱, 04에서 Registry로 설치한 `@agentclientprotocol/codex-acp` 1.12.0과 기존 로그인. 전용 폴더 `/private/tmp/atte-05-turn-control-acceptance`를 native 선택창으로 선택하여 자동 연결했다.

1. 도구·파일 접근 없이 1,000개 인사말을 나열하도록 요청하고 스트리밍 중 `현재 작업 중단`을 눌렀다. 부분 응답과 `취소됨`이 남고 같은 대화가 다시 전송 가능해졌다.
2. 기본 Codex 모드에서 무해한 printf 요청은 어댑터의 자동 검토로 실행되었다. 이를 Atte의 사용자 승인 검증으로 계산하지 않았다. 어댑터가 제공하는 `INITIAL_AGENT_MODE=read-only` 환경 변수로 앱을 재실행했다. 사용자 설정·설치 정의·제품 공통 코드는 바꾸지 않았다.
3. `sandbox_permissions=require_escalated`로 `printf ATTE-05-MANUAL > /private/tmp/atte-05-turn-control-acceptance/manual-allowed.txt`에 대한 일회 승인을 요청했다. 입력창 대신 `Run command`, 명령·cwd, 작업 폴더와 에이전트가 보낸 `Yes, proceed` / `Yes, and don't ask again for commands that start with …` / `No, and tell Codex what to do differently` 순서의 선택지가 나타났다. `Yes, proceed`만 선택했고 파일 내용 `ATTE-05-MANUAL`을 확인했다.
4. 같은 대화에서 `printf SHOULD-NOT-EXIST > /private/tmp/atte-05-turn-control-acceptance/cancelled.txt`의 승인을 요청했다. 승인 대기 화면에서 선택지를 누르지 않고 `현재 작업 중단`을 눌렀다. 승인 UI가 해소되고 `취소됨`이 표시되었으며 해당 파일은 생성되지 않았다.
5. 같은 대화에 도구·파일 접근 없이 `FOLLOWUP-05-OK`만 응답하도록 전송했고 정확한 응답과 완료를 확인했다.
6. 시각 확인에서 긴 선택지 문구의 가로 넘침을 발견하여 폴더와 버튼을 같은 footer 행의 두 열로 배치하고 버튼 문구를 줄바꿈하도록 수정했다. 결정에 도움이 되지 않는 terminal ID와 빈 위치 배열은 승인 상세에서 제외했다.

자동 검증: frontend 22개, Rust 42개 통과(기존 opt-in Codex smoke 2개는 기본 suite에서 제외). Biome, FSD, TypeScript, nightly fmt, Cargo check/Clippy와 production macOS `.app` 빌드 통과. 처음 FSD 검사에서 sandbox의 파일 감시 한도 오류가 발생했으며 `CHOKIDAR_USEPOLLING=1 pnpm validate`로 전체 frontend 검사를 통과했다. 이후 커밋 훅의 일반 검사도 통과했다.

Claude·Antigravity의 실제 계정 동작은 미검증으로 남긴다. 다중 대화 UI 통합과 대기열은 07, 앱 종료 정책은 08 범위다.

- 최종 production 앱에서 긴 승인 문구가 가로 넘침 없이 줄바꿈되고 작업 폴더와 같은 footer 행에 표시되는 것을 재확인했다. `final-cancelled.txt` 승인 대기에서도 중단 후 파일 미생성을 확인했다. 테스트 모드 앱은 종료했다. 구현·검증 완료.

- 2026-09-18 최신 로컬 `main` (`dac3b22`) 통합: Registry 아이콘·삭제 확인, 삭제 시 연결 무효화와 프로세스 종료, SQLite v1 스키마 정책을 유지하면서 승인·취소 구현과 테스트를 병합했다. `origin/main`은 이전 커밋이므로 최신 로컬 `main`을 기준으로 사용했다.
- 통합 회귀 테스트에서 승인 대기 중 에이전트를 삭제하면 승인 UI가 남는 문제를 재현했다. 삭제 시 미해결 승인과 snapshot을 함께 정리하도록 수정했다. 공개 대화 인터페이스에서 승인 제거, turn 취소, 늦은 승인 응답·재연결 거부와 구독 snapshot을 검증했다.
- 병합 후 검증: frontend 25개·Rust 52개 테스트 통과(실제 Codex opt-in 2개 제외). Biome, FSD, TypeScript, nightly fmt, Cargo check/Clippy, `git diff --check`, production macOS `.app` 빌드 통과. 이번 통합에서는 실제 Codex 연결 시나리오를 재실행하지 않았으며 위 2026-09-17 기록과 구분한다.
