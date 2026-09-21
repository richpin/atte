# 02: 불변 설치본과 유휴 자동 업데이트 제공

**What to build:** 사용자가 설치한 에이전트의 새 배포가 발견되면 대화를 시작하거나 앱을 여는 일을 지연시키지 않고 별도 설치본으로 준비하며, 해당 에이전트가 실행 중이 아니면 같은 앱 실행에서 안전하게 새 버전으로 전환한다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 설치와 검증은 에이전트별 임시 위치에서 수행하고, 성공한 결과만 에이전트별 고유 설치본 디렉터리로 확정해 기존 활성 파일을 제자리에서 변경하지 않는다.
- [x] 각 최종 설치본의 정보 파일에는 Registry 버전, 실제 설치 버전, 정규화된 배포 source identity와 경로 독립 실행 정의처럼 승격·비교·실행에 필요한 최소 불변 정보만 기록한다.
- [x] 정보 파일은 경로에서 알 수 있는 agent·installation ID, active·pending 역할, 진행 상태, 프로세스 수와 단순 관찰용 시각을 중복 기록하지 않는다.
- [x] SQLite는 active와 pending selector의 유일한 진실이며, 기존 에이전트 행에 단일 pending 경로만 추가하고 설치본별 테이블·행이나 업데이트 이력을 만들지 않는다.
- [x] 수동 설치, 재실행 후 복원과 삭제가 새 저장 구조에서 동작하며 부분 설치나 검증 실패는 활성 설치본과 저장 상태를 바꾸지 않는다.
- [x] 앱은 캐시된 Registry와 설치 정보로 즉시 시작하면서 매 시작마다 Registry 갱신을 백그라운드에서 한 번 시도하고, 실행 중에는 한 시간 간격과 수동 새로고침으로 다시 확인한다.
- [x] 자동 준비는 설치된 에이전트만 대상으로 하고 Registry 버전과 산출물에 영향을 주는 배포 source identity를 active·pending과 비교한다.
- [x] 같은 Registry 버전이라도 URL, checksum, package 또는 command의 정규화된 identity가 바뀌면 새 설치본을 준비하고, Registry 버전과 identity가 모두 같으면 반복 설치하지 않는다.
- [x] 같은 에이전트의 준비는 single-flight이고 서로 다른 에이전트는 전체 준비 파이프라인을 최대 세 개까지 병렬 실행하며, 공유 관리형 런타임 준비는 앱 전체에서 한 번만 수행한다.
- [x] 준비 중 더 최신 identity가 발견되면 현재 작업을 안전하게 마친 뒤 오래된 결과를 활성화하지 않고 최신 설치를 이어서 준비하며, 검증된 기존 pending은 더 최신 설치의 검증 성공 전까지 유지한다.
- [x] 해당 에이전트에 살아 있는 프로세스가 없으면 검증된 pending을 SQLite transaction으로 즉시 active로 승격하고 실행 정의를 갱신한 뒤 이전 active를 best-effort로 정리한다.
- [x] 앱 시작 시 네트워크 요청과 스레드 복원보다 먼저 유효한 pending을 승격하고 미참조 staging·orphan 설치본을 정리하며, 삭제 실패는 다음 시작에 재시도한다.
- [x] 공유 npm cache와 관리형 runtime은 설치본 정리에서 제외하고, 정상 active가 있는 자동 업데이트 실패는 사용자 상태나 새 UI를 만들지 않은 채 진단 로그와 다음 갱신 재시도로 처리한다.
- [x] source identity 비교, 최대 병렬성, single-flight, 유휴 승격, 재시작 복원과 기본 crash 경계를 공개 동작 중심의 회귀 테스트로 검증하고 관련 frontend·Rust 검사를 통과한다.

## Comments

- 2026-09-21: 구현 완료. 불변 설치본 manifest와 active/pending selector, 시작 복구·orphan 정리, 최대 3개 자동 준비, identity 재검사와 유휴 승격을 추가했다. `cargo test --all-targets`, strict Clippy, Biome, Steiger, frontend typecheck와 79개 Vitest가 통과했다. Steiger는 호스트 watcher 한도를 피하도록 polling mode로 검증했다.
