# ACP를 기준으로 한 대기 메시지 설계 조사

조사일: 2026-09-18. 대상: [07: 프로젝트별 동시 대화와 대기 메시지](../../.scratch/atte-v1/issues/07-conversations-queue.md).

## 결론

대기 메시지는 Atte가 소유하는 **대화별 영속 FIFO**로 구현한다. 에이전트에는 실행할 메시지 하나만 `session/prompt`로 전송한다. 이번 티켓에서 요구하는 미전송 메시지 삭제, 앱 재실행 후 보존, 비정상 종료 후 자동 전송 억제는 프로토콜 자체가 제공하는 기능이 아니라 Atte의 정책이다. ACP v2 Prompt Lifecycle RFD도 queueing 자체는 해당 제안의 범위 밖이라고 명시한다. [ACP v2 Prompt Lifecycle RFD](https://agentclientprotocol.com/rfds/v2/prompt)

## ACP v1에서 보장하는 경계

`session/prompt`의 응답이 turn 종료를 나타낸다. 텍스트 청크가 끝나거나 도구 하나가 완료되는 것은 turn 종료가 아니다. 완료 후 다음 prompt를 보낼 수 있다. stop reason은 `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`로 구분된다. 따라서 **Atte 권고 정책**은 `end_turn`에서만 FIFO의 다음 메시지를 자동 전송하고 나머지 결과에서는 멈추는 것이다. `Ok(PromptResponse)`라는 사실만으로 정상 완료를 판정하면 안 된다. [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)

취소는 session ID를 담은 `session/cancel` notification이다. 취소 요청 자체에는 응답이 없으며, 원래 prompt에 대한 `cancelled` 응답이 취소 완료 경계다. 클라이언트는 해당 turn의 미완료 승인 요청에 `cancelled` outcome을 응답해야 한다. 취소 이후에도 마지막 업데이트가 올 수 있으므로 처리해야 한다. **Atte 권고 정책**은 취소 의도를 기록하는 즉시 자동 전송을 중지하고, 취소 완료까지 기존 실행을 점유 상태로 유지하는 것이다. [ACP v1 Prompt Turn: Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)

일반 요청용 `$/cancel_request`도 존재하지만 구현 지원은 선택 사항이다. turn 취소에는 session 단위의 명시적 `session/cancel` 의미를 적용한다. 대기 메시지 삭제는 아직 ACP 요청이 없으므로 로컬 FIFO 삭제만 수행한다. [ACP v1 Cancellation](https://agentclientprotocol.com/protocol/v1/cancellation)

## 여러 대화와 공유 연결

ACP 세션은 고유 ID와 독립적인 문맥·기록·상태를 가진다. prompt, cancel, update 등은 session ID를 사용한다. 따라서 **Atte 권고 구조**는 대화별 실행 상태·FIFO·승인 요청을 갖고, 공유 연결에서 들어온 메시지를 session ID로 분배하는 것이다. 한 대화의 승인 응답을 기다리며 연결 전체의 수신 처리를 막지 않아야 한다. [ACP v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)

공식 v1 capability 목록에는 전용 `concurrentSessions` 또는 큐 기능 capability가 없다. 세션 모델이 분리를 지원한다는 것과 특정 에이전트가 여러 prompt를 실제로 병렬 실행한다는 것은 구분해야 한다. 같은 연결의 두 세션, 한 세션 승인 대기 중 다른 세션 진행, 한 세션 취소 격리는 티켓에 따라 실제 어댑터로 검증할 조건이다. 이는 프로토콜이 모든 구현의 스케줄링을 보장한다는 주장이 아니다. [ACP v1 Initialization](https://agentclientprotocol.com/protocol/v1/initialization)

공유 stdio 연결은 하나의 에이전트 프로세스 stdin/stdout으로 JSON-RPC 메시지를 교환한다. **설계상 결과**로 연결이 끊어지면 그 연결에 속한 모든 대화의 현재 실행이 영향을 받는다. 해당 대화의 자동 전송을 모두 멈추되, 다른 연결의 대화까지 멈추면 안 된다. [ACP v1 Transports](https://agentclientprotocol.com/protocol/v1/transports)

## 영속화와 중복 전송의 한계

JSON-RPC `id`는 요청과 응답의 상관관계를 식별한다. 동일 ID 재시도가 원격 실행을 중복 제거한다는 보장은 없다. ACP의 agent-owned `messageId`도 사용자 메시지를 보낼 때 클라이언트가 정하는 멱등성 키가 아니다. 따라서 **설계상 추론**으로, 전송 도중 연결이 끊기면 에이전트가 요청을 받았는지 로컬 저장소만으로 확정할 수 없으며 자동 재전송으로 exactly-once 실행을 보장할 수 없다. [JSON-RPC Request Object](https://www.jsonrpc.org/specification#request_object), [ACP Message ID](https://agentclientprotocol.com/rfds/message-id)

2026-09-18 사용자 피드백을 반영한 단순화 정책:

- FIFO 항목은 고정된 로컬 ID와 순서, 본문을 가진다. 이 ID를 ACP 메시지 ID로 취급하지 않는다.
- 삭제와 전송 선택은 동일한 대화 상태 변경 경로에서 직렬화한다. 삭제가 먼저 확정되면 전송하지 않고, 전송 선택이 먼저 확정되면 더 이상 삭제 가능한 미전송 메시지로 표시하지 않는다.
- 전송 시도 기록이나 결과 불명 상태를 저장하지 않는다. 실행할 첫 항목을 저장된 대기열에서 제거한 뒤 ACP 전송을 한 번 시도한다. 제거 저장이 실패하면 전송하지 않는다.
- 전송 실패 시 자동 재삽입·재전송하지 않고 기존 오류 UI로 알린다. 남은 대기 메시지는 유지하고 자동 전송을 중지한다.
- 대기열 제거와 실제 전송 사이에 앱이 비정상 종료되면 해당 항목은 복원되지 않을 수 있다. 이는 전송 기록·복구 상태를 두지 않는 단순한 설계의 한계이며 무손실 전달을 보장하지 않는다.
- 대기열에서 제거된 본문을 로컬 대화 이력이나 별도의 복구 기록으로 영속 보관하지 않는다.

`session/load`는 에이전트가 소유한 기록을 replay하고, `session/resume`은 기록 replay 없이 세션을 다시 준비한다. 둘 다 Atte 대기 메시지 전송 명령이 아니다. **Atte 권고 정책**은 재실행·load/resume·인증 성공 후 큐를 중지 상태로 복원하고 명시적 사용자 동작만으로 재개하는 것이다. [ACP v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)

## 안정 버전과 초안 구분

공식 공지는 ACP v2를 Draft로 분류하며 version negotiation과 feature flag 뒤에서 검증하고 기본 운영 경로로 출하하지 말라고 안내한다. 이번 티켓은 기존 v1 구현에 맞추는 것이 적절하다. [ACP v2 Draft 공지](https://agentclientprotocol.com/announcements/acp-v2-draft)

v2 초안에서는 prompt 응답이 수락만 나타낸다. 실행 종료는 `session/update`의 `state_update`에서 `state: idle`과 `stopReason`으로 보고된다. 향후 v2를 도입한다면 이 차이를 ACP 경계에서 정규화하고 큐의 정상 완료 정책은 유지할 수 있다. 지금 v1 코드에 v2의 완료 신호를 섞어 넣으면 안 된다. [ACP v2 Prompt Lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)

## 확인해야 할 테스트 경계

다음은 위 프로토콜과 티켓 요구에서 도출한 Atte 검증 항목이다.

1. 동일 대화의 동시 제출은 한 turn과 FIFO로 직렬화되고 서로 다른 대화는 독립적으로 진행한다.
2. 마지막 청크·도구 완료·승인 응답만으로 다음 메시지를 보내지 않는다. 해당 turn의 `end_turn`에서만 한 항목을 선택한다.
3. `refusal`, 토큰/요청 제한, JSON-RPC 오류, 연결 장애, 인증 상실에서는 다음 메시지를 보내지 않는다.
4. 취소 의도가 먼저 기록된 경우 뒤늦은 `end_turn` 응답이 도착하더라도 자동 전송을 재개하지 않는다.
5. 취소 중 미완료 승인은 `cancelled`로 응답하고 다른 대화의 승인·turn은 유지한다.
6. 삭제와 dispatch 경쟁은 한쪽만 성공한다. 이전 turn/연결의 뒤늦은 완료 신호로 다음 항목을 두 번 전송하지 않는다.
7. 대기열 제거 저장 실패 시 전송하지 않는다. 제거 후 실패한 항목을 자동 재삽입·재전송하지 않으며, 재실행 시 남은 대기열만 복원하고 자동 실행하지 않는다.
8. 기록 replay, 대화 선택, 인증 성공은 자동 전송의 계기가 아니다. 중지된 큐를 사용자가 어떤 조작으로 재개할지는 구현 전에 명시한다.

## Atte 구현에 적용한 설계

Rust `Conversations`가 대화별 FIFO와 실행 정책을 소유하고 SolidJS는 해당 상태를 표시한다. [send_message](../../src-tauri/src/conversation.rs)는 실행 중 제출을 대기열에 저장하고, [ACP runtime](../../src-tauri/src/agent_runtime.rs)은 완료 시 stop reason을 전달한다. 준비 상태 전환 자체는 큐 실행 트리거로 사용하지 않는다.

사용자 결정에 따라 SQLite v4에서는 기존 `conversations` 행의 `queued_messages` 컬럼에 `{id, text}` JSON 배열을 저장한다. v3의 별도 큐 테이블은 마이그레이션으로 대화 행에 합친다. 빈 큐는 `[]`이며 대화 행을 삭제하지 않는다. 배열 순서가 FIFO 순서이므로 별도 sequence나 전송 상태 컬럼을 두지 않는다. 추가 작업의 저장 성공 후에만 프론트엔드에 접수 성공을 알린다. 기존 메타데이터의 best-effort 저장 방식으로는 이 보장을 대체할 수 없다. 사용자 삭제와 전송을 위한 제거를 대화별로 직렬화하며 RPC 응답을 기다리는 동안 상태 잠금을 유지하지 않는다.

Runtime은 기존 generation과 turn ID에 stop reason을 포함한 완료 결과를 전달한다. `end_turn`이며 해당 실행에 취소 의도가 없을 때만 FIFO 첫 항목을 선택한다. 같은 에이전트 실행 정의와 폴더의 대화는 연결을 공유하며, session ID별 라우팅과 active turn을 관리한다. FIFO는 대화별로 유지한다.

UI는 입력창 위에 대기 메시지를 먼저 들어온 항목부터 위에서 아래로 표시하고 각 항목 맨 오른쪽에 휴지통 버튼을 둔다. 중단 후에도 항목을 유지하며 자동 전송하지 않는다.

중지된 큐의 명시적 재개 조작은 아직 확정되지 않았다. 이전 조사에서 제안한 빈 입력창의 전송 버튼/Enter 재개는 채택된 요구사항이 아니므로 구현에 추가하지 않는다.

## 기존 제품의 참고 패턴

Zed는 실행 중 제출한 메시지를 큐에 두고 현재 응답 후 처리한다. 사용자 취소 뒤에는 큐를 멈추는 패턴을 참고할 수 있다. Atte에는 티켓에 있는 FIFO·취소 후 중지만 도입하고 steering 등 추가 동작은 범위에 포함하지 않는 것이 적절하다. [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel), [Zed 고정 리비전의 MessageQueue](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/conversation_view/message_queue.rs)
