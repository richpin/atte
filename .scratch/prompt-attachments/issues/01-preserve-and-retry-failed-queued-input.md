# 01: 실패한 대기 입력을 보존하고 재시도한다

**What to build:** 사용자 입력을 메시지 본문과 첨부 목록의 묶음으로 다루고, 대기 입력의 전송이 실패해도 내용을 잃지 않은 채 사용자가 재시도하거나 삭제할 수 있게 한다. 기존의 텍스트-only 입력과 저장된 대기 메시지는 이전과 동일하게 동작해야 한다.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [x] 사용자 입력은 메시지 본문과 순서가 있는 첨부 목록을 함께 표현하며, 메시지 본문만 있는 기존 전송 동작을 유지한다.
- [x] 기존 형식으로 저장된 텍스트-only 대기 메시지를 오류 없이 불러오고 전송할 수 있다.
- [x] 대기 입력은 에이전트에 성공적으로 전달되기 전에 queue에서 제거되지 않는다.
- [x] 대기 입력 전송이 실패하면 전체 입력이 `failed` 상태로 보존되고 이후 queue의 자동 진행이 멈춘다.
- [x] 사용자가 실패한 입력을 재시도하면 같은 입력이 다시 전송되고, 삭제하면 다음 대기 입력의 진행이 재개된다.
- [x] 입력 상태 전이와 이전 저장 형식 호환성을 자동화된 테스트로 검증한다.

## Comments

- 2026-09-24: 구현 완료. ACP가 prompt 요청을 기록할 때 durable queue에서 제거하되 in-flight 입력을 유지하고, 요청 거부나 연결 실패 시 전체 입력을 `failed`로 복원하도록 했다. 재시도와 삭제 후 FIFO 재개, 기존 `{id,text}` 저장 형식 복원·전송, 첨부 순서 round-trip을 자동화 테스트로 검증했다.
- 검증: `pnpm validate`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test --locked`.
- 코드 리뷰: Standards와 Spec 두 축 모두 최종 finding 없음.
