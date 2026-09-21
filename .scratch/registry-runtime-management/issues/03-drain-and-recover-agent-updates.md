# 03: 실행 중 업데이트 전환과 수명주기 복구 완성

**What to build:** 새 설치본이 준비된 동안 사용자의 진행 중인 대화와 대기 메시지를 보존하고, 같은 에이전트의 구버전 프로세스를 모두 안전하게 끝낸 뒤 새 버전으로 일관되게 전환하며 종료·삭제·crash 경계에서도 올바른 상태로 수렴하게 한다.

**Blocked by:** [01: Registry 배포와 Node/npm 런타임 정책 완성](./01-registry-and-node-runtime-policy.md), [02: 불변 설치본과 유휴 자동 업데이트 제공](./02-immutable-installations-and-idle-updates.md)

**Status:** ready-for-agent

- [ ] pending이 준비되면 해당 agent ID를 draining 상태로 전환하고, 이미 실행 중인 turn만 완료시키며 새 메시지와 기존 대기 메시지는 구버전에서 시작하지 않고 순서대로 보존한다.
- [ ] 같은 agent ID를 사용하는 모든 작업 폴더와 스레드를 하나의 전환 단위로 다루고, 모든 진행 중인 turn이 끝나기 전에는 active selector나 실행 정의를 바꾸지 않는다.
- [ ] 모든 turn이 끝나면 해당 에이전트의 유휴 ACP 프로세스를 정상 종료·reap하고, 제한 시간에 응답하지 않는 경우 Atte가 소유한 프로세스 그룹만 강제 종료한다.
- [ ] 모든 구버전 프로세스의 reap을 확인하기 전에는 pending을 승격하거나 구버전 파일을 삭제하지 않으며, 종료 확인 실패 시 기존 active와 pending을 유지해 이후 재시도할 수 있다.
- [ ] 새 연결 시작과 draining·승격을 agent ID별 같은 coordination boundary에서 직렬화해 전환 중 구버전 프로세스가 새로 생기지 않게 한다.
- [ ] 구버전 프로세스가 모두 끝나면 SQLite transaction으로 pending을 active로 옮기고 pending을 비운 뒤, Threads의 실행 정의를 갱신하고 스레드를 재개해 보존한 메시지를 순서대로 처리한다.
- [ ] active 승격 성공과 이전 설치본 삭제를 분리해 삭제 실패가 활성화를 되돌리지 않으며, 다음 시작의 orphan 정리로 재시도한다.
- [ ] 준비 중 앱 종료는 완료를 기다리지 않고 미확정 작업을 취소하며, 다음 시작에 staging을 정리하고 이미 commit된 pending은 보존·승격한다.
- [ ] 사용자의 명시적 삭제가 자동 준비와 draining보다 우선해 해당 작업을 취소하고 active·pending·staging 설치본과 소유 프로세스를 제거하되 공유 runtime과 cache는 보존한다.
- [ ] 더 최신 pending 교체, 앱 종료, 명시적 삭제와 새 연결이 동시에 발생하는 경합에서도 한 에이전트의 기본 실행 정의가 한 버전으로 유지된다.
- [ ] 최종 디렉터리 확정, pending commit, 프로세스 종료, active 승격과 이전 설치본 정리의 각 crash 경계에서 재실행하면 active 또는 pending 중 검증된 상태로 수렴한다.
- [ ] 자동 업데이트의 진행·draining·성공·실패를 위한 알림, 진행 문구나 설정 UI를 추가하지 않고 기존 관리 화면과 대화 동작을 유지한다.
- [ ] 유휴·단일 turn·다중 스레드·대기 메시지·종료 timeout·앱 종료·삭제·crash 시나리오를 공개 경계의 회귀 테스트로 검증한다.
- [ ] 전체 frontend·Rust 검사와 production macOS 빌드를 통과하고, Standards와 부모 명세 양쪽의 코드 리뷰에서 남은 지적을 해소한다.
