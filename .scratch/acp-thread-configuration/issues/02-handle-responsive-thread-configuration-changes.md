# 02: 연속 스레드 설정 변경과 실패를 일관되게 처리한다

**What to build:** 사용자가 스레드 설정을 빠르게 연속 변경해도 입력창과 다른 설정을 계속 사용할 수 있는 반응성 높은 경험을 제공한다. 선택값은 pending 상태나 전역 잠금 없이 즉시 표시하되, ACP 요청과 전체 snapshot 응답은 순서가 뒤집히거나 종속 옵션을 무효화하지 않도록 조정한다. 설정 변경 실패는 해당 선택만 마지막으로 확인된 상태로 되돌리고 스레드의 작업은 계속 유지한다.

**Blocked by:** `01-support-acp-v1-thread-configuration.md` — 01: ACP v1 스레드 설정을 end-to-end로 지원한다

**Status:** ready-for-agent

- [x] 사용자의 선택을 thread subscription에 즉시 반영하고 일반 선택값으로 표시하며 pending 문구, spinner 또는 설정 control 잠금을 노출하지 않는다.
- [x] 설정 요청 처리 중에도 다른 설정, 메시지 작성·전송, turn 취소와 permission 응답을 계속 사용할 수 있다.
- [x] 현재 화면에 표시된 값과 같은 선택은 성공적인 no-op이며 ACP set 요청을 만들지 않는다.
- [x] 같은 스레드에서는 ACP set 요청을 직렬 처리해 동시에 하나만 전송하고, 서로 다른 스레드의 요청은 독립적으로 진행할 수 있다.
- [x] 아직 전송하지 않은 동일 config ID의 연속 선택은 마지막 값으로 합치며 이미 전송된 요청은 취소하거나 재해석하지 않는다.
- [x] 각 성공 응답의 전체 snapshot을 확인 상태로 반영한 뒤 아직 남은 선택의 config ID, 타입과 값이 유효한지 다시 검사한다.
- [x] 모델 변경 등으로 무효화된 후속 선택은 전송하지 않고 에이전트가 새 snapshot에서 제공한 현재값을 표시한다.
- [x] 요청 처리 중 도착한 agent-originated configuration snapshot과 사용자의 아직 유효한 최신 선택을 조정해 오래된 snapshot이 최신 선택을 영구적으로 덮지 않는다.
- [x] 설정 요청 실패 시 실패한 선택을 제거하고 마지막 agent-confirmed snapshot으로 되돌리며 비차단 오류를 표시한다.
- [x] 설정 실패는 스레드를 Failed로 만들거나 ACP 연결을 종료하거나 active turn과 대기 메시지를 변경하지 않는다.
- [x] 연결이 끝났거나 runtime generation이 바뀐 뒤 도착한 오래된 설정 결과는 현재 스레드 상태를 변경하지 않는다.
- [x] 프런트엔드 subscription을 사용할 수 없는 동안에는 기존 ADR에 따라 설정 mutation을 막고, 복구된 snapshot으로 다시 일치시킨다.
- [x] deterministic ACP fixture의 request gate와 기록을 사용한 Rust 통합 테스트가 직렬화, 동일 설정 병합, no-op, 종속 옵션 재검증, 실패 복귀, stale result 거부와 스레드 격리를 검증한다.
- [x] SolidJS 앱 수준 테스트가 즉시 표시, 연속 조작, 다른 composer 동작과의 공존, snapshot 조정과 비차단 실패 경험을 검증한다.
- [x] 기존 메시지 전송, streaming, 취소, 승인 요청, 대기 메시지와 composer layout 테스트가 계속 통과한다.

## Comments

- 구현 완료: 설정 선택을 즉시 구독 상태에 반영하고, 스레드별 직렬화·미전송 선택 병합·응답 snapshot 재검증·실패 복귀·runtime generation 격리를 추가했다.
- 검증: deterministic ACP fixture의 request/update gate와 SolidJS 앱 수준 테스트로 연속 조작, 다른 composer 동작과의 공존, 종속 설정 변경, 비차단 실패를 확인했다.
