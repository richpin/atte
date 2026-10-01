Status: complete

# ACP 세션 제목과 스레드 제목 동기화

## 목적과 범위

에이전트가 ACP `session/update`의 `session_info_update`로 제목을 생성하거나 변경하면 해당 Atte 스레드의 제목, 사이드바 목록, 열린 스레드 화면과 저장된 메타데이터에 반영한다. 에이전트가 제목을 제공하지 않으면 현재의 첫 입력 기반 제목을 유지한다. `updatedAt`과 `_meta`는 동기화하지 않으며 기존 `lastPromptAt` 정렬을 유지한다.

ACP 표준 알림을 받는 단방향 동기화다. 에이전트별 API, 추가 LLM 호출, 제목 변경 명령, 수동 제목 편집, 세션 목록 가져오기, 주기적 polling은 포함하지 않는다. 닫혀 있는 앱이나 연결되지 않은 세션에서 발생한 변경을 즉시 감지하는 기능도 포함하지 않는다.

## 근거

- 현재 `agent-client-protocol = 2.1.0`과 잠긴 schema 1.7.0에는 안정된 `SessionUpdate::SessionInfoUpdate`와 `MaybeUndefined<String>`이 이미 있다. 패키지 추가·SDK 업그레이드·unstable feature가 필요 없다.
- [ACP SessionInfoUpdate](https://docs.rs/agent-client-protocol-schema/1.7.0/agent_client_protocol_schema/v1/struct.SessionInfoUpdate.html)는 부분 갱신이다. 제목 필드 생략과 명시적인 `null`을 구분해야 한다.
- [Zed의 스레드 구현](https://github.com/zed-industries/zed/blob/main/crates/acp_thread/src/acp_thread.rs)은 에이전트 제목을 받아 잠정 제목을 교체하고 변경 이벤트를 발행한다. 표준 알림 → 세션 제목 변경 → UI 갱신 패턴을 따르되, null 처리는 ACP 명세를 따른다. 상세 근거는 임시 조사 파일 `docs/research/acp-session-title-sync.md`에 기록하며 Git 이력에 넣지 않는다.
- [Codex ACP v2.0.1](https://github.com/agentclientprotocol/codex-acp/blob/v2.0.1/src/CodexAcpServer.ts)은 턴 종료 이후에도 비동기로 제목을 생성한다. 따라서 active turn 밖의 알림 처리도 필수다.
- ADR 0001의 구독 단일 공급원 정책을 유지한다. 제목은 기존 `ThreadMetadata.title`에 저장하며 데이터베이스 스키마 v1은 변경하지 않는다.

## 제목 정책

| 입력 | Atte 처리 |
| --- | --- |
| 에이전트 제목 없음 | 새 스레드 기본 제목과 첫 입력 본문/첫 첨부 파일명 앞 60자 정책 유지 |
| `title` 필드 생략 (`Undefined`) | 현재 제목 유지, 저장·구독 알림 없음 |
| `title: "..."` (`Value`) | 전달된 문자열로 교체; 첫 입력의 60자 제한을 적용하지 않음 |
| `title: null` (`Null`) | 에이전트 제목 해제: 저장된 `title`을 빈 문자열로 바꾸고 UI는 기존 기본 제목 표시를 사용 |
| 동일한 제목 반복 | 제목 변경에 따른 중복 저장·구독 알림 없음 |
| `updatedAt` 또는 `_meta`만 변경 | 이번 범위에서는 무시; 제목과 Atte 정렬 시각 유지 |

빈 제목 문자열도 임의의 요약으로 바꾸지 않는다. 화면에서는 빈/공백 제목에 기존 기본 제목 표시 정책을 적용한다. 에이전트 제목은 텍스트로 렌더링하며 Markdown/HTML로 해석하지 않는다. 제목 변경은 `lastPromptAt`을 갱신하지 않아 목록 순서를 바꾸지 않는다. 기존 `publish()`가 관리하는 `updatedAt`은 로컬 저장 시각으로 유지한다.

첫 입력 제목은 잠정 제목이다. 에이전트가 제목을 보낸 이후에는 일반 전송·대기열 전송·재연결이 이를 덮어쓰지 않는다. 문자열이 `새 스레드`인지 비교하는 현재 조건에 소유권 판단을 맡기지 않는다. `ThreadState`에 첫 입력 제목 적용 가능 여부를 나타내는 작은 비영속 플래그를 두어 새 draft만 허용하고, 복원된 스레드는 비허용으로 시작한다. 첫 입력 제목을 적용하거나 에이전트의 명시적인 Value/Null을 받으면 비허용으로 바꾼다. 동일 제목 알림도 이 정책 플래그는 갱신하되 불필요한 publish는 하지 않는다. 별도 제목 이력이나 DB provenance 컬럼은 필요 없다.

## 구현 순서

1. `src-tauri/src/agent_runtime.rs`의 notification handler에서 `SessionInfoUpdate`를 `ConfigOptionUpdate`처럼 replay/active 분기보다 먼저 처리한다. 기존 `sessionId` route를 사용해 소유 스레드의 `RuntimeUpdates`로 전달한다. active turn 존재 여부에 의존하지 않아 작업 중, idle, load replay와 resume 연결 중의 제목 알림을 모두 처리한다. 알 수 없거나 제거된 route는 무시한다.
2. `src-tauri/src/thread.rs`의 `RuntimeUpdates`에 제목 갱신 경로를 추가한다. 잠금 후 기존 `generation`을 검사하고, 부분 갱신 의미와 첫 입력 정책을 적용한다. 실제 표시 제목이 바뀌었을 때만 `ThreadState::publish()`를 호출한다. 무조건 publish하는 `modify_state()`에 중복 알림을 맡기지 않는다.
3. `publish()`의 기존 경로로 metadata 저장 → 목록 구독 → 스레드 patch 전달을 재사용한다. 제목 변경 전용 Tauri command/event나 프런트엔드 별도 제목 state를 추가하지 않는다. 저장 실패는 기존 `storageError`로 전달하며 정상 응답 처리와 세션 실행은 유지한다.
4. 기존 Solid 구독으로 사이드바와 열린 스레드 제목이 함께 갱신되는지 확인한다. 빈 제목의 기본 표시가 헤더와 사이드바에 일관되게 적용되는지 검증하고 필요한 부분만 기존 FSD slice 안에서 수정한다. 긴 제목은 데이터에서 자르지 않고 기존 UI 레이아웃으로 표시한다.
5. `docs/database.md`의 첫 메시지 제목 설명을 잠정 제목·에이전트 제목 우선·명시적 해제·저장과 복원 정책으로 갱신한다. README와 초기 SQL은 수정하지 않는다.

## 복원과 연결 경계

앱 재실행 시 마지막으로 저장된 동기화 제목을 그대로 복원한다. load/resume에서 제목 알림이 오면 기존 route를 통해 갱신하고, 알림이 없으면 저장된 제목을 유지한다. load replay buffer에는 제목을 넣지 않는다. 제목은 본문 replay 성공 여부와 독립적인 metadata 알림이므로 load 도중 받은 제목은 즉시 반영하며, 뒤이어 load가 실패해도 수신한 제목을 되돌리지 않는다. 세션 ID와 generation이 맞지 않는 오래된 알림은 반영하지 않는다.

현재 새 세션 route는 `session/new` 응답에서 ID를 받은 뒤 등록된다. 응답 이전의 알림을 위해 전체 미등록 세션 알림 buffer를 추가하지 않는다. 이 경계를 fixture와 지원 에이전트 조사에서 확인한다.

`session/load`와 `session/resume` 응답 자체에는 제목이 없으며, 현재 제목 알림의 재전송도 보장되지 않는다. 따라서 연결되지 않은 동안 외부에서 바뀐 제목은 에이전트가 재연결 후 알림을 보내는 경우에만 반영된다. 항상 외부 최신 제목으로 맞추는 보장이 필요하면 별도 요구사항으로 `session/list` capability·pagination·조회 순서 정책까지 설계해야 한다.

## 검증과 완료 조건

기존 Rust stdio ACP fixture와 통합 테스트를 확장한다. 별도 언어나 새 테스트 프레임워크를 추가하지 않는다.

- 첫 입력 잠정 제목 이후 생성 제목과 후속 변경 제목이 저장 및 두 구독에 반영된다.
- idle, running, 취소 후 idle, load replay, resume 중 알림을 처리한다.
- 생략은 유지, null은 해제, 긴 문자열은 보존, 동일 제목은 중복 저장/알림 없이 처리한다.
- 에이전트 제목이 `새 스레드`와 동일하거나 null인 경우에도 후속 입력이 덮어쓰지 않는다.
- 같은 런타임의 두 세션을 격리하고, 삭제·재연결 뒤 오래된 route/generation의 알림을 거부한다.
- 앱 저장소를 다시 열어 마지막 제목이 복원되고, 재연결 시 알림이 없으면 제목을 유지한다.
- 제목 변경으로 `lastPromptAt`, 메시지 본문, 대기 메시지, 설정, 작업 상태가 바뀌지 않는다.
- 저장 실패가 기존 storageError 경로에 표시된다.
- Solid 앱 테스트에서 patch와 목록 갱신을 전달해 열린 헤더·사이드바 갱신, 빈 제목 기본 표시, 스레드 전환 후 오래된 갱신 무시를 확인한다.

구현 완료 시 Cargo fmt/clippy와 관련 Rust 통합 테스트, `pnpm validate`를 실행한다.
