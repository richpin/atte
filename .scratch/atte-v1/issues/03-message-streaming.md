# 03: 메시지 전송과 스트리밍 응답

**What to build:** 연결된 대화에서 메시지를 보내고 응답이 도착하는 대로 읽으며 완료 후 다음 메시지를 보낼 수 있다.

**Blocked by:** [02: 실제 ACP 연결과 대화 생성](./02-acp-session.md)

Status: ready-for-agent

## 근거와 범위

부모 명세: [Atte 첫 버전 구현 명세](../spec.md). 관련 사용자 스토리: 15–18, 49–50.

02의 연결과 세션을 사용해 첫 대화 왕복을 완성한다. 완전한 취소·승인 UI는 04, 대기열은 06에서 추가한다. 이 단계까지 완료하면 원래 첫 티켓의 흐름이 완성된다.

공통 원칙: macOS 우선, Rust 공개 대화 인터페이스 중심 테스트, SolidJS FSD 구성. UI 기준은 `codex/prototype-ui`의 `b591a6e`이며 프로토타입 코드를 그대로 이식하지 않는다. 필요한 테스트를 먼저 작성하고 관련 frontend 검사·타입 검사·테스트와 Rust 검사·테스트 및 빌드를 통과한다. 실제 에이전트 검증은 Codex로 한정한다.

## Acceptance criteria

- [ ] 좁은 대화 인터페이스로 메시지를 보내고 ACP prompt의 업데이트를 순서대로 수신해 사용자 메시지와 에이전트 응답 및 완료 상태를 표시한다.
- [ ] turn당 한 번만 전송하고 실행 중 추가 전송을 UI와 Rust 모두에서 막는다. 완료 후 다음 메시지를 기존 세션에 보내며 prompt 인증 오류와 실행 실패를 명확히 표시한다.
- [ ] A안의 오른쪽 정렬된 짙은 회색 둥근 사용자 말풍선과 대화 너비를 사용하는 왼쪽 정렬 에이전트 본문을 적용한다. 에이전트 이름·아이콘·응답 라벨은 생략하고 헤더는 가벼운 한 줄로 유지한다.
- [ ] Rust의 현재 snapshot과 순번 있는 변경 스트림을 UI가 구독한다. 재구독 시 snapshot과 이후 업데이트 사이에 누락이나 중복 적용이 없으며 UI 구독 해제는 실행을 종료하지 않는다.
- [ ] 대화·turn·연결의 식별을 수신 처리에 사용한다. 프로세스 종료와 실패 후에도 오래된 출력이 현재 상태를 잘못 덮어쓰지 않는다.
- [ ] 승인 UI 도입 전 승인 요청은 ACP 취소 결과로 해소하고 화면에 이유를 표시한다. 승인 요청을 방치하거나 자동 허용하지 않는다.
- [ ] 모의 ACP 에이전트로 스트리밍 순서, 완료, 후속 전송, 중복 전송 방지, 오류, 조기 이벤트와 재구독을 검증한다. Solid 테스트는 조작과 표시 결과를 검증한다.
- [ ] 인증된 Codex에 파일 수정이 필요 없는 요청을 보내 스트리밍과 후속 대화를 확인하고 실행 버전·절차·결과를 기록한다.

## Comments

- 사용자의 첫 티켓 축소 요청에 따라 기존 01을 01–03으로 분할했다. 이 파일은 구현 완료가 아닌 준비된 작업을 나타낸다.


- 2026-09-17 구현: `send_message`와 원자적 snapshot 구독을 공개 대화 경계에 추가했다. Rust가 turn UUID, 연결 generation, revision, 사용자 메시지, 스트리밍 응답과 stop reason을 소유한다. 구독 시작 시 현재 snapshot을 먼저 보내고 이후 변경 snapshot을 순서대로 전달한다. Tauri Channel을 사용하며 구독 해제와 창 종료는 구독만 정리한다.
- 설계 참고: [ACP stable prompt turn](https://agentclientprotocol.com/protocol/prompt-turn), [Rust SDK ordering](https://docs.rs/agent-client-protocol/2.1.0/agent_client_protocol/concepts/ordering/index.html), 기존 Zed 조사와 `b591a6e:UI-PROTOTYPE.md`. stable-v1의 `PromptRequest`, `SessionNotification`, 순차 notification/result handler 사용. terminal result에서 turn 라우팅을 해제하고 실패 시 프로세스를 정리한 뒤 재연결을 허용한다.
- UI: polling 제거, 단일 전송 보호, 오른쪽 짙은 회색 사용자 말풍선과 전체 너비의 왼쪽 응답, 완료/오류/승인 취소 이유 표시. 오래된 revision은 현재 UI를 덮어쓰지 않는다. 구독 등록 응답보다 먼저 오는 업데이트 및 늦게 완료된 등록의 cleanup을 처리한다.
- 자동 검증: Rust 공개 경계에서 순서·중복 거부·후속 전송·실행 중 재구독·구독 해제 후 계속 실행·prompt 인증/실행 오류·프로세스 종료·외부 세션과 terminal 이후 출력·승인 취소를 확인했다. Solid에서는 전송·표시·실패 시 입력 보존·오래된 revision·늦은 구독 정리를 확인했다.
- 실제 Codex 검증: macOS arm64, `@agentclientprotocol/codex-acp` 1.12.0, Rust SDK 2.1.0. 기존 준비 설치의 실행 파일을 `ATTE_CODEX_ACP`로 지정하고 `cargo test --manifest-path src-tauri/Cargo.toml --test acp_session real_codex_streams -- --ignored --nocapture` 실행. 파일·도구 사용 금지 요청으로 `Remembered cobalt-73.` 응답(6개 streaming revision), 같은 세션의 후속 요청으로 `cobalt-73` 응답(4개 streaming revision), 두 turn 모두 `end_turn`, 작업 폴더 파일 없음 확인. pnpm store 안의 독립 엔트리는 의존성 연결이 없어 종료됐으나 기존 설치의 `.bin/codex-acp`로 통과했다. 실제 로그인 접근을 위해 sandbox 밖에서 실행했다. Claude/Antigravity는 미검증이다.
- macOS 앱 빌드 `pnpm tauri build --bundles app` 통과. Standards/Spec 리뷰와 최종 검증 진행 중.
