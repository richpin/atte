# 02: 연결된 ACP 세션을 백그라운드에서 정리

**What to build:** 이미 공유 ACP 연결에서 실행 중이거나 준비된 스레드를 삭제할 때 로컬 삭제를 즉시 완료한 뒤, 같은 연결을 이용해 해당 원격 세션의 `session/delete`를 분리된 best-effort 작업으로 요청한다. 원격 동작은 UI를 막거나 다른 스레드를 중단하지 않는다.

**Blocked by:** .scratch/thread-deletion/issues/01-delete-local-threads.md

**Status:** ready-for-agent

- [x] 원격 세션 ID가 있는 연결된 스레드도 01의 동일한 메뉴와 확인 흐름으로 로컬에서 먼저 삭제된다.
- [x] 로컬 삭제 command는 원격 삭제 응답을 기다리지 않고 성공하며 UI는 즉시 목록과 선택 상태를 갱신한다.
- [x] 현재 연결의 initialize 결과에서 `sessionCapabilities.delete`를 독립적으로 확인하고, 지원할 때만 정확한 원격 세션 ID로 `session/delete`를 보낸다.
- [x] 삭제 capability가 없으면 원격 요청을 보내지 않고 로컬 삭제 결과를 유지한다.
- [x] 활성 turn이 있는 스레드에도 `session/cancel`이나 프로세스 종료를 먼저 요청하지 않고 `session/delete` 의미를 에이전트에 맡긴다.
- [x] 원격 삭제 성공, 명시적 오류 또는 transport 종료는 이미 성공한 로컬 삭제를 되돌리지 않는다.
- [x] 원격 실패는 민감한 agent payload나 credential을 포함하지 않는 진단 로그에만 남고 frontend 오류나 toast를 만들지 않는다.
- [x] 원격 삭제 작업에는 별도 timeout을 두지 않으며 UI와 독립적으로 응답 또는 연결 종료를 기다린다.
- [x] 대상 스레드의 route와 local update target을 정리하여 삭제 뒤 도착하는 text, permission, completion 또는 metadata update가 스레드를 되살리지 않는다.
- [x] 같은 에이전트와 작업 폴더의 공유 프로세스에 속한 다른 스레드는 연결, turn, 승인 요청과 메시지 전송을 계속 사용할 수 있다.
- [x] ACP fixture가 delete capability, 성공, 미지원, 오류, 지연과 늦은 update 시나리오를 표현하고 받은 method와 session ID를 관찰할 수 있다.
- [x] 공개 Threads API와 ACP fixture를 사용하는 통합 테스트가 활성 스레드 삭제 시 cancel 부재, detached 요청, 늦은 이벤트 무시와 공유 연결 격리를 검증한다.

## Comments

- 구현 완료. 공유 ACP runtime command로 route를 먼저 분리한 뒤 capability가 있을 때만 `session/delete`를 별도 작업으로 전송한다. 로컬 삭제와 sibling session은 원격 응답·오류·지연과 독립적이다.
- 검증: ACP fixture 통합 테스트에서 정확한 session ID, capability 미지원, 명시적 오류, transport 종료, 응답 지연, 늦은 update, cancel 부재와 공유 연결 격리를 확인했다.
