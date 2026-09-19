# 03: 메시지 전송과 스트리밍 응답

**What to build:** 연결된 스레드에서 메시지를 보내고 응답이 도착하는 대로 읽으며 완료 후 다음 메시지를 보낼 수 있다.

**Blocked by:** [02: 실제 ACP 연결과 스레드 생성](./02-acp-session.md)

Status: done

## 근거와 범위

부모 명세: [Atte 첫 버전 구현 명세](../spec.md). 관련 사용자 스토리: 15–18, 49–50.

02의 연결과 세션을 사용해 첫 스레드 왕복을 완성한다. 완전한 취소·승인 UI는 04, 대기열은 06에서 추가한다. 이 단계까지 완료하면 원래 첫 티켓의 흐름이 완성된다.

공통 원칙: macOS 우선, Rust 공개 스레드 인터페이스 중심 테스트, SolidJS FSD 구성. 필요한 테스트를 먼저 작성하고 관련 frontend 검사·타입 검사·테스트와 Rust 검사·테스트 및 빌드를 통과한다. 실제 에이전트 검증은 Codex로 한정한다.

## Acceptance criteria

- [x] 좁은 스레드 인터페이스로 메시지를 보내고 ACP prompt의 업데이트를 순서대로 수신해 사용자 메시지와 에이전트 응답 및 완료 상태를 표시한다.
- [x] turn당 한 번만 전송하고 실행 중 추가 전송을 UI와 Rust 모두에서 막는다. 완료 후 다음 메시지를 기존 세션에 보내며 prompt 인증 오류와 실행 실패를 명확히 표시한다.
- [x] A안의 오른쪽 정렬된 짙은 회색 둥근 사용자 말풍선과 스레드 너비를 사용하는 왼쪽 정렬 에이전트 본문을 적용한다. 에이전트 이름·아이콘·응답 라벨은 생략하고 헤더는 가벼운 한 줄로 유지한다.
- [x] Rust의 현재 snapshot과 순번 있는 변경 스트림을 UI가 구독한다. 재구독 시 snapshot과 이후 업데이트 사이에 누락이나 중복 적용이 없으며 UI 구독 해제는 실행을 종료하지 않는다.
- [x] 스레드·turn·연결의 식별을 수신 처리에 사용한다. 프로세스 종료와 실패 후에도 오래된 출력이 현재 상태를 잘못 덮어쓰지 않는다.
- [x] 승인 UI 도입 전 승인 요청은 ACP 취소 결과로 해소하고 화면에 이유를 표시한다. 승인 요청을 방치하거나 자동 허용하지 않는다.
- [x] 모의 ACP 에이전트로 스트리밍 순서, 완료, 후속 전송, 중복 전송 방지, 오류, 조기 이벤트와 재구독을 검증한다. Solid 테스트는 조작과 표시 결과를 검증한다.
- [x] 인증된 Codex에 파일 수정이 필요 없는 요청을 보내 스트리밍과 후속 스레드를 확인하고 실행 버전·절차·결과를 기록한다.

## Comments

- 사용자의 첫 티켓 축소 요청에 따라 기존 01을 01–03으로 분할했다. 이 파일은 구현 완료가 아닌 준비된 작업을 나타낸다.


- 2026-09-17 구현: `send_message`와 원자적 snapshot 구독을 공개 스레드 경계에 추가했다. Rust가 turn UUID, 연결 generation, revision, 사용자 메시지, 스트리밍 응답과 stop reason을 소유한다. 구독 시작 시 현재 snapshot을 먼저 보내고 이후 상태 변경 snapshot과 텍스트 증분(`TextDelta`)을 순서대로 전달한다. Tauri Channel을 사용하며 구독 해제와 창 종료는 구독만 정리한다.
- 설계 참고: [ACP stable prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [Rust SDK ordering](https://docs.rs/agent-client-protocol/2.1.0/agent_client_protocol/concepts/ordering/index.html), 기존 Zed 조사. stable-v1의 `PromptRequest`, `SessionNotification`, 순차 notification/result handler 사용. terminal result에서 turn 라우팅을 해제하고 실패 시 프로세스를 정리한 뒤 재연결을 허용한다.
- UI: polling 제거, 단일 전송 보호, 오른쪽 짙은 회색 사용자 말풍선과 전체 너비의 왼쪽 응답, 완료/오류/승인 취소 이유 표시. 오래된 revision은 현재 UI를 덮어쓰지 않는다. 구독 등록 응답보다 먼저 오는 업데이트 및 늦게 완료된 등록의 cleanup을 처리한다.
- 자동 검증: Rust 공개 경계에서 순서·중복 거부·후속 전송·실행 중 재구독·구독 해제 후 계속 실행·prompt 인증/실행 오류·프로세스 종료·외부 세션과 실패 응답 이후 출력·승인 취소를 확인했다. Solid에서는 전송·표시·실패 시 입력 보존·오래된 revision·늦은 구독 정리를 확인했다.
- 실제 Codex 검증: macOS arm64, `@agentclientprotocol/codex-acp` 1.12.0, Rust SDK 2.1.0. 기존 준비 설치의 실행 파일을 `ATTE_CODEX_ACP`로 지정하고 `cargo test --manifest-path src-tauri/Cargo.toml --test acp_session real_codex_streams -- --ignored --nocapture` 실행. 파일·도구 사용 금지 요청으로 `Remembered cobalt-73.` 응답(6개 streaming revision), 같은 세션의 후속 요청으로 `cobalt-73` 응답(4개 streaming revision), 두 turn 모두 `end_turn`, 작업 폴더 파일 없음 확인. pnpm store 안의 독립 엔트리는 의존성 연결이 없어 종료됐으나 기존 설치의 `.bin/codex-acp`로 통과했다. 실제 로그인 접근을 위해 sandbox 밖에서 실행했다. Claude/Antigravity는 미검증이다.
- macOS 앱 빌드 `pnpm tauri build --bundles app` 통과. 네이티브 800×600 창에서 폴더 선택 → Codex 연결 → 첫 전송(`Streaming works.`) → 동일 스레드 후속 전송/같은 응답 → 완료와 입력 복구 확인. 짙은 회색 오른쪽 말풍선, 라벨 없는 왼쪽 응답, 한 줄 헤더를 screenshot으로 확인했다.
- `/code-review`: 사용자 확인 기준 `cfefc49`에서 Standards/Spec 독립 리뷰. Standards의 구독 cleanup 실패가 새 화면에 영향을 주는 경로와 매 청크 전체 기록 복사를 수정했다. 초기 snapshot/상태 전이와 텍스트 증분을 구분하며 Solid는 스레드·turn·revision을 검증한다. 중복/외부 업데이트 거부 및 오래된 cleanup 오류 회귀 테스트 추가. Standards 재리뷰 잔여 지적 0건.
- Spec 검증 보완: 지연 없는 프로세스 종료를 반복해 마지막 buffered 출력 손실을 재현했다. 프로세스 종료 시 최대 1초 동안 이미 도착한 protocol 데이터를 처리한 뒤 실패를 게시한다. 인증 오류 직후 종료하는 경우의 오분류도 공개 경계 테스트로 red→green 확인했다. SDK의 `is_incoming_transport_closed`로 EOF를 prompt 실행 오류와 구별하고, 구체적 인증/실행 오류는 보존한다. 즉시 종료 시나리오 10회 연속 통과. Spec 재리뷰 잔여 지적 0건.
- 최종 검증: Solid 16개, Rust 자동 테스트 17개, 실제 Codex 두 turn 검증 1개 통과(실제 Codex 테스트 2개는 기본 suite에서 ignore). Biome/FSD/TypeScript/Rust fmt/check/Clippy, 전체 테스트 및 macOS 앱 빌드 확인. 이 티켓 구현 완료. 영속 기록·실제 세션 재개·전체 승인 UI·취소·대기열은 후속 티켓 범위다.

- ACP v1 경계: 정상 turn의 출력은 terminal prompt 응답 이전에 도착한다는 프로토콜 계약을 따른다. 알림에 turn ID가 없으므로 정상 완료 후 다음 turn이 시작된 뒤 임의로 보내는 이전 텍스트까지 식별한다고 주장하지 않는다. 모의 에이전트의 오래된 출력 주입은 실패/인증 오류 뒤의 연결 폐기 경계에서 검증하며, 정상 후속 전송에는 인위적 대기를 넣지 않는다. 최종 ACP 통합 suite 10회 연속 통과.

- 2026-09-17 후속 UX 변경: 사용자 결정에 따라 새 스레드 생성 직후 ACP 연결을 자동 시작한다. 초기 연결 버튼을 제거하고 연결 실패(명령 거절 포함) 시에만 “다시 연결”을 표시한다. 실패 후 자동 재시도하지 않으며 연결 준비 전에는 메시지 전송을 비활성화한다.
