# ACP 취소 이후 작업 계속하기 조사

조사일: 2026-09-19. ACP 공식 v1 문서와 v2 Draft 문서·RFD를 기준으로 확인했다.

## 결론

ACP에는 `session/cancel`로 중단한 **동일한 prompt turn 또는 실행을 그 지점부터 그대로 재개하는 표준 연산이 없다**. 취소가 완료되면 기존 작업은 종료된 것이다. 같은 스레드의 맥락을 이어서 작업하려면 취소 완료를 확인한 뒤 같은 session ID로 새로운 `session/prompt`를 보내야 한다. 이 후속 prompt에 “계속해”와 같은 지시를 담을 수는 있지만, 이는 새 사용자 메시지이자 새 작업이며 취소된 모델 요청·도구 호출·프로그램 카운터를 복원한다는 프로토콜 보장은 없다.

`session/load`와 `session/resume`의 “resume”은 이 문제의 해법이 아니다. 둘은 연결이나 프로세스가 바뀐 뒤 **기존 세션 문맥을 다시 준비하는 session lifecycle 연산**이고, 취소된 turn을 실행 중 상태로 되돌리는 연산이 아니다.

## ACP v1: 취소는 현재 turn의 종결이다

v1에서 하나의 `session/prompt` 요청은 사용자 메시지로 시작해 agent가 응답을 끝낼 때까지 유지되는 prompt turn이다. 정상 종료든 취소든 agent는 원래 `session/prompt` 요청에 `StopReason`을 반환해 turn을 끝낸다. [`cancelled`는 “Client cancels the turn”을 뜻한다](https://agentclientprotocol.com/protocol/v1/prompt-turn#stop-reasons).

클라이언트가 `session/cancel` notification을 보내면 agent는 모델 요청과 도구 호출을 가능한 한 빨리 중단해야 한다. 진행 중인 작업을 모두 중단하고 남은 update를 보낸 다음, agent는 **원래 `session/prompt` 요청**에 `stopReason: "cancelled"`로 응답해야 한다. 취소 뒤 도착하는 update도 이 최종 응답 전에만 허용된다. 따라서 `cancelled` 응답은 일시 정지가 아니라 해당 turn의 완료 경계다. [ACP v1 Prompt Turn: Cancellation](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)

공식 문서는 turn이 완료된 뒤 대화를 이어가는 방법을 “another `session/prompt`”라고 명시한다. 즉 같은 session context를 활용하되 **새 prompt**를 보내는 방식이다. 취소된 원래 요청의 ID나 실행 위치를 지정해 재개하는 필드는 없다. [ACP v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)

Atte에서 사용자가 “그대로 계속”을 누르는 UI를 제공할 수는 있다. 다만 ACP wire 동작은 취소 완료 후 같은 session ID에 새 `session/prompt`를 보내는 것이며, prompt 내용은 사용자의 명시적 후속 지시이거나 Atte가 정한 제품 정책이어야 한다. 원래 prompt를 그대로 재전송하면 새 turn으로 다시 실행되므로 이미 수행한 작업의 중복 가능성이 있다.

## `session/load`와 `session/resume`은 연결 복원이다

v1의 두 연산은 기존 session context를 다시 사용할 수 있게 준비한다.

- `session/load`는 기존 세션을 복원하면서 보존된 대화 기록을 `session/update`로 replay하고, replay가 끝나면 응답한다. 그 후 클라이언트가 새 prompt를 보낼 수 있다.
- `session/resume`은 기존 세션 문맥과 MCP 연결을 복원하지만 과거 기록을 replay하지 않고, 세션이 새 prompt를 받을 준비가 되면 응답한다.

두 메서드 모두 session ID, 작업 폴더, MCP 서버를 입력으로 받는다. 취소된 prompt request ID, turn ID, 중단 위치 또는 “계속 실행” 플래그를 받지 않는다. 따라서 둘의 “resume”은 **세션 재연결**이고 **취소된 작업 재개**가 아니다. [ACP v1 Session Setup: Loading Sessions](https://agentclientprotocol.com/protocol/v1/session-setup#loading-sessions), [ACP v1 Session Setup: Resuming Sessions](https://agentclientprotocol.com/protocol/v1/session-setup#resuming-sessions)

## ACP v2 Draft: lifecycle은 달라지지만 동일 실행 재개는 추가되지 않는다

v2 Draft에서는 `session/prompt` 응답의 의미가 바뀐다. v1처럼 turn 종료까지 요청을 열어 두지 않고, agent가 사용자 메시지를 ACP conversation에 삽입하면 `messageId`와 함께 응답한다. 이 응답은 처리 완료나 `idle`을 뜻하지 않는다. 이후 실행 상태와 완료는 `session/update`의 `state_update`로 보고한다. [ACP v2 Prompt Lifecycle: Prompt Accepted](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#2-prompt-accepted)

v2의 취소도 active work를 종료한다. `session/cancel`을 받은 agent는 작업을 중단한 뒤 `state: "idle"`, `stopReason: "cancelled"`인 `state_update`를 보내야 한다. 공식 문서는 agent가 `idle`을 보고한 뒤 대화를 계속하는 방법을 다시 “another `session/prompt`”라고 명시한다. 따라서 v2에서도 취소한 동일 실행을 재활성화하는 연산은 없다. [ACP v2 Prompt Lifecycle: Cancellation](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle#cancellation)

v2 Prompt Lifecycle RFD는 이 범위를 더 명확히 제한한다.

- 반환되는 `messageId`는 수락된 사용자 메시지의 ID이지 turn이나 agent 응답의 ID가 아니다.
- queueing, steering, busy 상태에서의 prompt 삽입 정책은 RFD 범위 밖이다.
- retry는 멱등하지 않으며, 같은 내용을 다시 보내면 별개의 submission으로 수락될 수 있다.

그러므로 v2의 빠른 prompt 응답이나 `messageId`를 “취소한 turn의 재개 handle”로 해석하면 안 된다. [ACP v2 Prompt Lifecycle RFD](https://agentclientprotocol.com/rfds/v2/prompt)

v2 Draft는 세션 복원 API도 정리한다. `session/load`를 제거하고 `session/resume` 하나로 통합하며, `replayFrom`을 주면 보존된 기록을 replay하고 생략하면 replay 없이 세션을 복원한다. 이 변경도 restore/replay 방식의 통합일 뿐, 취소된 foreground work를 이어 실행하는 기능은 아니다. [ACP v2 Session Resume Replay RFD](https://agentclientprotocol.com/rfds/v2/session-resume-replay)

v2 문서와 스키마는 현재 Draft이므로 v1 운영 경로와 섞어 구현하면 안 된다. [ACP v2 Draft 공지](https://agentclientprotocol.com/announcements/acp-v2-draft)

## Atte에 적용할 수 있는 최소 동작

취소 뒤 입력을 다시 허용하려는 요구에는 별도 ACP 확장이 필요하지 않다.

1. v1은 원래 `session/prompt`가 `cancelled`로 응답할 때까지, v2는 `idle(cancelled)` update가 올 때까지 해당 실행을 종료 중으로 취급한다.
2. 완료 경계 뒤 입력창을 다시 활성화한다.
3. 사용자가 입력한 후속 내용을 같은 session ID의 새 `session/prompt`로 보낸다.
4. “그대로 계속” 단축 동작을 제공한다면, 그것이 취소된 실행 복원이 아니라 새 후속 prompt 전송임을 제품 계약과 테스트에 명시한다.
5. 원래 prompt 전체를 자동 재전송하지 않는다. ACP에는 중복 제거나 exactly-once 보장이 없고, 일부 도구 작업은 취소 전에 이미 완료됐을 수 있다.

Atte의 도메인 용어로는 같은 **스레드**를 이어가는 동작이지만, ACP 관점에서는 같은 **세션**에 새 prompt turn을 시작하는 것이다. `session/load`/`session/resume`을 호출해야만 후속 입력이 가능한 것은 아니며, 현재 ACP 연결에서 세션이 이미 active라면 취소 완료 후 바로 새 `session/prompt`를 보낼 수 있다.
