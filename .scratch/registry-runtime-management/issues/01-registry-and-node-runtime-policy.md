# 01: Registry 배포와 Node/npm 런타임 정책 완성

**What to build:** 사용자가 현재 플랫폼에서 실제로 실행할 수 있는 Registry 에이전트만 발견하고, 시스템에 호환되는 Node.js와 npm이 있으면 자신의 설정을 그대로 사용하며, 그렇지 않아도 Atte의 관리형 런타임으로 같은 설치·인증·실행 흐름을 사용할 수 있게 한다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] Registry 항목은 에이전트 ID가 아니라 현재 플랫폼에서 선택 가능한 배포 capability로 지원 여부를 판정하고, 미설치된 미지원 항목은 catalog에서 제외한다.
- [x] 이미 활성 설치본이 있는 항목은 Registry에서 사라지거나 현재 배포가 미지원이 되어도 catalog에 남아 사용자가 확인하고 삭제할 수 있다.
- [x] Registry distribution의 알 수 없는 키와 값은 저장 후 다시 읽어도 손실되지 않으며, fixture만 추가한 새 에이전트를 제품 코드의 이름별 변경 없이 처리한다.
- [x] 현재 플랫폼 binary를 npx보다 우선하고, 선택한 binary의 형식 또는 설치가 실패해도 npx로 조용히 우회하지 않는다.
- [x] uvx, Python과 uv 관리형 런타임은 별도 ID 목록 없이 동일한 capability 규칙으로 제외한다.
- [x] Node.js 22 이상과 동작하는 npm 쌍을 로그인 셸 `PATH`, 앱 프로세스 `PATH`, 관리형 런타임 순서로 해석한다.
- [x] 로그인 셸 조회 실패·timeout, 낮은 Node 버전, 누락된 npm과 실패한 probe는 다음 후보 검사로 이어지고 별도 사용자 오류를 만들지 않는다.
- [x] 런타임 해석 결과를 앱 수명 동안 공유하되 사용 직전 유효성 검사를 통과하지 못하면 같은 순서로 다시 해석한다.
- [x] 저장된 실행 정의는 직접 실행 또는 Node entrypoint 의미만 가지며 시스템 Node의 절대 경로를 포함하지 않고, npm 설치·인증·ACP 실행 모두 같은 resolver를 사용한다.
- [x] 호환되는 시스템 Node/npm을 찾으면 관리형 archive를 다운로드하지 않고, 관리형 Node가 필요하면 고정 버전과 checksum을 검증해 macOS aarch64와 x86_64에서 재사용한다.
- [x] 시스템 npm은 사용자의 Registry·인증·proxy·certificate·release-age 설정을 상속하고, 관리형 npm만 Atte 전용 빈 user/global config와 cache를 사용하면서 proxy·certificate 환경은 보존한다.
- [x] Registry의 정확한 npm semver를 설치 상한으로 사용하고, 허용되는 실제 설치 버전을 package metadata에서 확인해 저장하며 lifecycle script를 허용한다.
- [x] 선택된 시스템 npm의 설치 실패는 관리형 npm 다운로드나 재시도의 조건이 아니며 활성 설치본과 사용자 정책을 보존한다.
- [x] catalog, runtime 선택, npm command와 설치→인증→실행의 공개 동작을 회귀 테스트로 검증하고 관련 frontend·Rust 검사를 통과한다.

## Comments

- 2026-09-21: 구현 완료. Registry capability filtering/metadata round-trip, 앱 범위 Node/npm resolver, 경로 독립 Node entrypoint, npm 정책과 설치 상한을 회귀 테스트로 검증했다. `cargo test --locked`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `pnpm check`, `pnpm typecheck`, `pnpm test` 통과. `pnpm check:fsd`는 코드 진단 전에 호스트의 `EMFILE: too many open files, watch`로 두 번 종료됐다.
