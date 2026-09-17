# 02: 실제 ACP 연결과 대화 생성

**What to build:** 빈 대화에서 준비된 에이전트를 연결하고 실제 ACP 세션의 준비 또는 실패 상태를 확인한다.

**Blocked by:** [01: 작업 폴더 선택과 빈 대화 화면](./01-working-folder.md)

Status: done

후속 정리: 사용자 요청에 따라 Python stdio fixture를 Rust `tests/fixtures/agent.rs`로 교체했다. Cargo example target을 통합 테스트가 빌드·실행하며 새 의존성이나 제품 실행 파일은 추가하지 않는다. 기존 Rust 자동 테스트 12개 및 fmt/check/Clippy 통과, Standards/Spec 리뷰 지적 없음. `AGENTS.md`에 테스트 보조 프로그램도 기존 Rust/TypeScript 기술 스택을 사용한다는 원칙을 추가했다.

## 근거와 범위

부모 명세: [Atte 첫 버전 구현 명세](../spec.md). 관련 사용자 스토리: 9–10, 49–50.

01의 초안에 프로세스와 원격 세션을 연결한다. prompt 전송, 응답 스트리밍과 완전한 승인 UI는 후속 티켓이다. 이후 Registry 설치 결과도 동일한 실행 정의를 사용한다.

공통 원칙: macOS 우선, Rust 공개 대화 인터페이스 중심 테스트, SolidJS FSD 구성. UI 기준은 `codex/prototype-ui`의 `b591a6e`이며 프로토타입 코드를 그대로 이식하지 않는다. 필요한 테스트를 먼저 작성하고 관련 frontend 검사·타입 검사·테스트와 Rust 검사·테스트 및 빌드를 통과한다. 실제 에이전트 검증은 Codex로 한정한다.

## Acceptance criteria

- [x] 공식 Rust ACP SDK의 안정된 표면을 확인해 stdio로 준비된 에이전트를 시작하고 initialize 및 작업 폴더를 지정한 session/new를 수행한다.
- [x] 앱 대화 ID는 유지하고 에이전트가 발급한 세션 ID를 별도로 연결한다. 실행 명령·인자·환경은 실행 정의에 두며 공통 코드에 Codex 전용 경로와 모드를 고정하지 않는다.
- [x] Rust가 프로세스와 연결을 소유하고 연결 전·연결 중·세션 생성 성공·실패가 화면에 표시된다. 세션 생성 성공을 인증 완료로 간주하지 않는다.
- [x] 없는 실행 파일, 초기화 실패, 세션 생성 실패와 인증 필요, 프로세스 종료를 구분한다. 같은 대화의 중복 연결 요청으로 불필요한 중복 세션을 만들지 않는다.
- [x] 정상 종료와 연결 실패 시 관리하는 프로세스를 정리한다. 미구현된 client capability를 광고하지 않으며 예기치 않은 승인 요청은 취소로 해소한다.
- [x] 이 단계의 연결 상태에 필요한 좁은 Tauri 통신만 추가한다. 스트리밍 및 실행 중 재구독 계약은 03에서 확장한다.
- [x] stdio 모의 에이전트로 초기화·세션 생성·오류·프로세스 종료를 재현해 공개 인터페이스와 UI 상태를 검증한다. 실제 Codex로 초기화와 세션 생성 성공을 확인하고 버전과 관찰 결과를 기록한다.

## Comments

- 사용자의 첫 티켓 축소 요청에 따라 기존 01을 01–03으로 분할했다. 이 파일은 구현 완료가 아닌 준비된 작업을 나타낸다.


- 2026-09-17 구현: 공식 `agent-client-protocol = 2.1.0`의 stable-v1 `Client.builder()`, `ByteStreams`, `InitializeRequest(ProtocolVersion::V1)`, `NewSessionRequest(cwd)` 사용. SDK 2.x와 wire v1은 별개다. 미구현 client capability는 기본값(false)이며 승인 요청은 `Cancelled`로 응답한다.
- 설계 근거: [공식 SDK](https://github.com/agentclientprotocol/rust-sdk)의 stable-v1 예제와 저장소의 Zed 조사 자료를 참고했다. 명령·인자·환경은 Rust `AgentDefinition`에 두고, UI에는 식별자·표시명만 제공한다. 현재 런타임은 연결을 대화별로 격리하며 이 정책은 UI 계약에 노출하지 않는다.
- 공개 인터페이스: `create_for_agent`, `connect`, `get`, `shutdown`. 연결 요청은 `connecting`/`sessionReady`일 때 재사용한다. Rust가 앱 ID와 원격 ID, 연결 및 인증 상태를 소유하고, 실패는 실행 파일 누락·실행 실패·초기화·세션 생성·인증 필요·프로세스 종료·연결 단절·시간 초과로 구분한다. 세션 성공의 인증 상태는 `unknown`이다.
- 실행 준비: PATH에 `codex-acp`를 설치하거나 앱 실행 환경의 `ATTE_CODEX_ACP`에 준비된 어댑터 실행 파일의 절대 경로를 지정한다. 자동 설치나 로그인은 수행하지 않는다. 앱이 소유한 프로세스 그룹은 실패와 앱 종료 시 종료하고 직접 자식 프로세스를 reap한다.
- UI: 다음 대화의 준비된 에이전트 선택, 고정 대상 표시, 연결·명시적 재시도, Rust 상태와 오류 표시. 이 티켓에서는 `get_conversation`을 직렬 polling하여 종료도 표시한다. 순서 있는 메시지 스트림 및 실행 중 재구독은 03의 범위다.
- TDD: 공개 Rust 인터페이스의 연결 성공 테스트와 Solid 연결 UI 테스트에서 최초 실패 확인 후 구현. stdio fixture로 cwd·capability·오류·프로세스 종료·승인 취소를 검증했다. 실패 시 reap, 종료 시 하위 프로세스 정리, 알 수 없는 에이전트/대화 거부도 검증했다.
- 실제 Codex: macOS arm64, `@agentclientprotocol/codex-acp` 1.12.0, Rust SDK 2.1.0. `ATTE_CODEX_ACP=<prepared executable> cargo test --manifest-path src-tauri/Cargo.toml --test acp_session real_codex_initializes_and_creates_a_session -- --ignored --nocapture` 성공. 임시 작업 폴더로 initialize와 session/new, 앱 ID 유지·별도 원격 ID·인증 unknown·shutdown을 확인했다. 초기 sandbox 실행은 초기화에 실패했으며, 기존 Codex 설정 디렉터리 접근이 가능한 실행에서 통과했다. prompt 및 Claude/Antigravity는 이 티켓에서 검증하지 않았다.
- 검사: `CHOKIDAR_USEPOLLING=1 pnpm validate`와 `sh scripts/validate-rust.sh` 실행. 기본 Steiger 실행은 환경의 파일 watcher 제한(EMFILE)에 걸려 polling 옵션으로 다시 실행했다.

- macOS 배포 앱 확인: `pnpm tauri build --bundles app` 통과. 네이티브 폴더 선택 → 고정 Codex 대화 → 연결 중 → 세션 준비 완료, 인증 미확인 안내와 비활성 메시지 입력을 확인했다. 기본 800×600 창에서 헤더·폴더·상태·연결 UI 레이아웃을 확인했고 정상 Quit으로 앱이 종료되었다.
- `/code-review`: 시작 커밋 `44d17eb` 기준 Standards/Spec 독립 리뷰. Standards 지적 0건. Spec의 “선택 후 삭제된 폴더가 실행 파일 누락으로 표시됨” 1건을 연결 전 폴더 재검증과 구조화 오류 UI로 수정했다. 공개 Rust 회귀 테스트의 red→green 및 UI 테스트를 추가하고 Spec 재리뷰에서 해결을 확인했다.
- 최종 검증 완료: Solid 11개, Rust 자동 테스트 12개 통과; 실제 Codex 전용 테스트 1개 별도 통과(기본 suite에서는 ignore). Biome·FSD·TypeScript·Rust fmt/check/Clippy와 macOS 앱 빌드 통과. 이 티켓 구현 완료. 메시지 전송·응답 스트리밍·전체 승인 UI는 후속 티켓 범위다.
