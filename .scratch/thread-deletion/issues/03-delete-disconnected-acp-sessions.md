# 03: 연결이 없는 ACP 세션도 best-effort로 정리

**What to build:** 앱 재시작 뒤 복원된 스레드처럼 live ACP 연결이 없는 대상도 로컬에서 즉시 삭제하고, 가능한 경우 삭제 전용 연결을 백그라운드에서 시작해 원격 세션을 정리한다. 에이전트를 사용할 수 없는 모든 경우에도 사용자의 로컬 삭제 결과는 유지된다.

**Blocked by:** 02: 연결된 ACP 세션을 백그라운드에서 정리

**Status:** complete

- [x] live 연결이 없는 저장된 스레드를 삭제하면 로컬 목록, 대기 메시지와 영속 metadata가 즉시 제거된다.
- [x] 로컬 삭제 뒤 캡처한 에이전트, 작업 폴더와 원격 세션 ID를 사용해 기존 공유 연결을 찾거나 새 연결을 시작한다.
- [x] 삭제 전용 연결은 초기화와 capability 검사만 수행하며 대상 세션을 `load`, `resume` 또는 새로 생성하지 않는다.
- [x] 새 연결의 `sessionCapabilities.delete`가 지원일 때만 정확한 원격 세션 ID로 `session/delete`를 보낸다.
- [x] capability 미지원은 정상적인 best-effort 종료로 처리하고 원격 method를 호출하지 않는다.
- [x] 에이전트 제거, 실행 파일 부재, launch 실패, initialize 실패, 인증 실패, 프로세스 종료와 delete RPC 오류는 로컬 삭제를 되돌리거나 사용자 오류를 만들지 않는다.
- [x] 원격 실패는 민감한 agent payload나 credential을 포함하지 않는 진단 로그에만 남긴다.
- [x] 삭제 전용 원격 작업에는 별도 timeout을 두지 않으며 frontend command와 확인 창의 수명주기에서 분리한다.
- [x] 원격 작업이 대기 중이어도 다른 스레드의 연결과 앱 사용이 막히지 않는다.
- [x] 삭제 전용 연결과 task가 앱 shutdown 및 공유 runtime 수명주기에 참여하여 프로세스나 task를 고아로 남기지 않는다.
- [x] 저장소를 다시 열어도 로컬 삭제된 스레드가 복원되지 않으며, 자동 `session/list` reconciliation이나 tombstone은 추가하지 않는다.
- [x] ACP fixture와 공개 Threads API 통합 테스트가 저장된 원격 세션의 성공 삭제, capability 미지원과 각 연결 실패에서도 로컬 결과가 유지됨을 검증한다.

## Comments

- 구현 완료. 복원된 ACP 세션은 로컬에서 먼저 영구 삭제한 뒤 일치하는 공유 runtime을 재사용하거나 shutdown에 참여하는 삭제 전용 runtime을 시작한다.
- 검증: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked`, `pnpm check`, `CHOKIDAR_USEPOLLING=1 pnpm check:fsd`, `pnpm typecheck`, `pnpm test` 통과.
