Status: ready-for-agent

# Registry 배포와 런타임 관리

## Problem Statement

Atte는 ACP Registry에서 현재 플랫폼 바이너리와 npx 배포를 설치하지만, 지원할 수 없는 uvx 전용 항목도 목록에 노출한다. npx 설치에는 사용자가 설치한 Node.js를 재사용하지 않고 관리형 Node.js만 다운로드하며, 설치된 실행 정의에 구체적인 Node 경로를 영구 저장한다. Registry의 새 버전을 발견해도 설치된 에이전트를 갱신하지 않는다.

앱 크기를 늘리지 않으면서 시스템 런타임을 우선 활용하고, 시스템에 런타임이 없는 사용자에게는 관리형 런타임을 제공해야 한다. 동시에 자동 업데이트가 대화 시작을 지연시키거나 실행 중인 에이전트 파일을 교체해서는 안 된다.

## Solution

Registry 원문에서 알 수 없는 배포 metadata를 보존하되, 현재 플랫폼에서 Atte가 실제로 선택할 수 있는 binary 또는 npx 배포가 있는 항목만 설치 목록에 표시한다. 이미 설치된 항목은 현재 배포가 미지원이어도 제거할 수 있도록 계속 표시한다. 배포 선택 우선순위는 현재 플랫폼 binary, 그다음 npx이며 선택한 배포의 설치 실패를 다른 배포로 우회하지 않는다. uvx는 지원하거나 별도로 판별하지 않고 같은 capability 규칙으로 자연스럽게 제외한다.

npx와 `cmd: node` 배포는 Node 경로와 독립적인 실행 정의를 저장한다. 설치·인증·에이전트 실행 직전에 Node.js 22 이상과 동작하는 npm의 쌍을 해석한다. 사용자의 로그인 셸 `PATH`, 앱 프로세스 `PATH`, Atte 관리형 Node.js 순서로 검사하고 앱 프로세스 수명 동안 결과를 재사용한다. 선택된 시스템 런타임이 사라지면 다음 사용에서 관리형 런타임으로 전환한다. 시스템 npm은 사용자 설정을 그대로 사용하고, 관리형 npm만 전용 빈 user/global config와 cache를 사용한다.

Registry의 정확한 npm 버전은 설치 상한으로 취급한다. 사용자의 `min-release-age` 같은 정책이 허용하는 상한 이하 최신 버전을 설치하고 실제 해석된 버전을 저장한다. lifecycle script는 허용한다. 시스템 npm의 설치 실패를 관리형 npm으로 다시 시도하지 않는다.

Atte는 캐시된 Registry와 설치 정보로 즉시 시작하고, 매 앱 시작마다 Registry를 백그라운드에서 한 번 갱신한다. 실행 중에는 한 시간 간격과 사용자의 수동 새로고침으로 다시 확인한다. 설치된 binary와 npx 항목의 Registry 버전 또는 선택된 배포 정보가 바뀌면 에이전트별 단일 작업으로 새 설치본을 다운로드·설치·검증하며, 서로 다른 에이전트는 최대 세 개까지 병렬로 준비한다. 준비 실패는 활성 설치본이 있는 한 사용자에게 노출하지 않고 다음 Registry 갱신에서 다시 시도한다.

각 설치본은 `agents/<agent-id>/<installation-id>/`의 불변 디렉터리에 저장한다. 디렉터리의 `installation.json`에는 Registry 버전, 실제 설치 버전, 배포 source identity와 실행 정의처럼 승격과 실행에 필요한 최소 정보만 기록한다. 활성·대기 역할의 유일한 selector는 SQLite이며, 기존 `agents` 행에 활성 설치 정보와 단일 `pending_artifact_path`를 둔다. 설치본별 테이블이나 행은 추가하지 않는다.

검증된 pending이 준비되면 해당 에이전트의 새 turn 시작을 잠시 막고 대기 메시지는 큐에 보존한다. 이미 진행 중인 모든 turn이 끝난 뒤 해당 에이전트의 구버전 프로세스를 종료·reap하고, SQLite transaction으로 pending을 active로 승격한 다음 스레드를 새 실행 정의로 재개한다. 진행 중인 turn이 없다면 유휴 프로세스를 종료하고 즉시 전환한다. 이전 활성 설치본과 참조되지 않는 설치 디렉터리는 전환 뒤 best-effort로 제거하고, 실패하면 다음 시작 시 다시 정리한다. 공유 npm 다운로드 cache와 관리형 runtime은 제거하지 않는다.

## User Stories

1. Atte 사용자로서 현재 Mac에서 실행할 수 없는 uvx 전용 에이전트를 목록에서 보지 않기를 원한다.
2. 이미 설치한 에이전트의 배포가 Registry에서 사라지거나 미지원으로 바뀌어도 이를 확인하고 제거하고 싶다.
3. 시스템에 호환되는 Node.js와 npm이 있으면 이를 재사용해 불필요한 다운로드와 디스크 사용을 피하고 싶다.
4. 시스템 런타임이 없거나 호환되지 않더라도 별도 설치 안내 없이 Atte가 관리형 런타임을 준비하기를 원한다.
5. 셸에서 구성한 Node.js가 GUI 앱의 기본 환경에 없더라도 Atte가 로그인 셸 환경에서 찾기를 원한다.
6. 시스템 npm을 사용할 때 사설 Registry, 인증, proxy, certificate와 release-age 정책이 존중되기를 원한다.
7. 관리형 npm이 시스템 `.npmrc`에 의존하거나 이를 변경하지 않기를 원한다.
8. Registry가 지정한 버전이 release-age 정책에 막히면 허용되는 상한 이하 버전을 설치하고 실제 버전을 확인할 수 있기를 원한다.
9. 시스템 npm의 설치 오류가 다른 npm으로 조용히 우회되어 사용자 보안 정책을 무시하지 않기를 원한다.
10. Registry의 새 버전 다운로드와 설치 때문에 대화 시작이 늦어지지 않기를 원한다.
11. 백그라운드 업데이트가 실패해도 기존 정상 설치본으로 계속 대화하고 싶다.
12. 새 버전이 준비되면 진행 중인 대화를 중단하지 않으면서 가능한 즉시 일관되게 전환하기를 원한다.
13. 업데이트 전환을 기다리는 동안 보낸 메시지가 사라지거나 구버전에서 새 작업을 시작하지 않기를 원한다.
14. 성공적으로 전환된 이전 설치본은 자동으로 제거되되 npm 공유 cache는 재사용되기를 원한다.
15. 손상되거나 사라진 활성 설치본은 기존 준비 중 흐름에서 자동 복구되고, 실행 가능한 설치본이 없을 때만 일반 오류를 보고 싶다.

## Implementation Decisions

- Registry 배포 지원 여부는 에이전트 ID가 아니라 현재 플랫폼에서 선택 가능한 배포 capability로 판정한다.
- Registry distribution의 알 수 없는 키와 값은 역직렬화 후 다시 저장해도 손실되지 않게 보존한다.
- 현재 플랫폼에 지원되는 binary가 있으면 npx보다 우선한다. 현재 플랫폼 binary가 명시되어 있으나 압축·설치 형식이 미지원이면 npx로 fallback하지 않는다.
- 미지원 항목은 catalog에서 제외한다. 활성 설치가 있는 항목은 Registry 유무와 지원 여부와 관계없이 catalog에 남긴다.
- uvx, Python과 uv 관리형 런타임은 범위 밖이다. 특정 uvx 전용 에이전트 ID 목록은 만들지 않는다.
- Node 런타임은 로그인 셸 `PATH`, 앱 프로세스 `PATH`, 관리형 런타임 순서로 해석한다.
- Node.js 최소 호환 버전은 22다. Node와 npm 중 하나라도 없거나 probe가 실패하면 해당 쌍을 사용하지 않는다.
- 로그인 셸 환경 조회 실패 또는 timeout은 앱 프로세스 환경 검사로 이어지며 별도 사용자 메시지를 만들지 않는다.
- 런타임 해석 결과는 앱 수명 동안 공유한다. 사용 직전 가벼운 유효성 검사를 통과하지 못하면 같은 순서로 다시 해석한다.
- 관리형 Node.js는 앱 bundle에 넣지 않고 기존의 고정 버전·checksum 검증 다운로드를 유지한다. 첫 구현은 macOS aarch64와 x86_64만 지원한다.
- 저장된 실행 정의는 직접 실행 또는 Node entrypoint라는 의미를 표현하며 시스템 Node의 절대 경로를 저장하지 않는다.
- 런타임은 npm 설치, 인증 연결, ACP 실행 전에 같은 resolver로 해석한다.
- 시스템 npm command는 사용자의 npm config와 현재 proxy/certificate 환경을 상속한다.
- 관리형 npm command는 Atte 전용 빈 user/global config와 cache를 명시하며 proxy/certificate 환경은 보존한다.
- npx package의 정확한 semver는 `0.0.0 - <registry-version>` 상한으로 변환한다. 설치된 package metadata의 실제 버전을 저장한다.
- npm lifecycle script를 비활성화하지 않는다. `--ignore-scripts`를 제거한다.
- 선택된 시스템 npm의 `npm install` 실패는 관리형 npm 재시도의 조건이 아니다.
- 설치본 경로는 `agents/<agent-id>/<installation-id>/`다. 설치와 검증은 같은 에이전트 디렉터리의 임시 위치에서 끝낸 뒤 최종 설치본 디렉터리로 rename한다. 한 에이전트 아래에는 active, pending과 준비 중 또는 정리 실패한 설치본 때문에 둘 이상의 버전이 잠시 존재할 수 있다.
- 각 최종 설치본에는 `installation.json`을 둔다. agent ID와 installation ID는 상위 경로에서 식별하고 파일에 중복하지 않는다. 파일에는 Registry 버전, 실제 설치 버전, 정규화된 배포 source identity와 Node 절대 경로가 없는 실행 정의 등 해당 설치본의 승격·비교·실행에 필요한 최소 불변 정보만 기록한다. 역할, 진행 상태, 프로세스 수와 단순 관찰용 시각은 기록하지 않는다.
- SQLite가 active와 pending selector의 유일한 진실이다. 기존 `agents` 행과 활성 설치 컬럼을 유지하고 `pending_artifact_path` 하나만 추가한다. 설치본별 테이블, 설치본별 행, 업데이트 이력, 별도 stale 상태 테이블은 만들지 않는다.
- Registry 갱신은 캐시의 나이와 관계없이 매 앱 시작마다 한 번 백그라운드에서 시도하고, 앱 실행 중 한 시간 간격으로 다시 수행한다. 수동 새로고침도 성공하면 같은 업데이트 준비를 유발한다. 실패 시 마지막 정상 Registry와 설치 정보를 유지한다.
- 백그라운드 준비는 설치된 에이전트만 대상으로 한다. Registry 버전과 선택된 배포에서 산출물에 영향을 주는 URL, checksum, package, command 정보를 정규화한 source identity를 active·pending과 비교한다. Registry 버전이 같아도 source identity가 다르면 업데이트하고, 둘 다 같으면 반복 준비하지 않는다.
- 다운로드, 압축 해제 또는 npm 설치, 검증과 최종 디렉터리 확정을 하나의 준비 작업으로 취급한다. 같은 에이전트는 single-flight로 직렬화하고 서로 다른 에이전트는 최대 세 개까지 병렬로 준비한다. 관리형 Node 준비는 앱 전체에서 single-flight로 공유한다.
- 준비 중 더 최신 source identity가 발견되어도 실행 중인 작업을 강제 취소하지 않는다. 완료된 설치본이 이미 오래된 것이면 active나 pending으로 지정하지 않고 정리한 뒤 최신 설치본을 준비한다. 기존의 검증된 pending은 더 최신 설치본의 검증이 성공할 때까지 유지한다.
- pending이 준비되면 해당 agent ID를 draining 상태로 전환한다. draining 이후 들어온 새 메시지와 기존 대기 메시지는 큐에 보존하고 구버전에서 새 turn을 시작하지 않는다. 이미 진행 중인 모든 turn만 완료시킨다.
- 같은 agent ID를 사용하는 모든 작업 폴더와 스레드는 하나의 전환 단위다. 모든 진행 중인 turn이 끝나면 구버전 ACP 프로세스를 정상 종료한다. 제한 시간 안에 끝나지 않으면 Atte가 소유한 프로세스 그룹만 강제 종료하며, 모든 프로세스의 reap을 확인하기 전에는 selector를 바꾸거나 구버전 파일을 삭제하지 않는다.
- 새 연결 시작과 draining·승격은 에이전트별 같은 coordination boundary에서 직렬화한다. 구버전 프로세스를 모두 종료한 뒤 SQLite transaction으로 pending을 active로 옮기고 pending 경로를 비운다. 이후 Threads의 실행 정의를 갱신하고 보존한 메시지를 스레드 재개 뒤 순서대로 처리한다.
- 전환 뒤 이전 active와 active·pending·공유 runtime이 참조하지 않는 설치 디렉터리를 best-effort로 제거한다. 삭제 실패와 디렉터리 rename 또는 DB transaction 사이의 crash는 다음 시작의 경로 검증과 orphan 정리로 수렴시킨다. 삭제 실패는 성공한 활성화를 되돌리지 않는다.
- 앱 시작 시 네트워크 요청과 스레드 복원보다 먼저 로컬 설치 상태를 검증하고 유효한 pending을 active로 승격하며 orphan을 정리한다. 그 뒤 캐시로 앱과 스레드를 복원하고 Registry 갱신을 백그라운드에서 시작한다.
- 앱 종료는 아직 검증·확정되지 않은 준비 작업을 기다리지 않고 취소한다. 다음 시작에서 미참조 staging을 정리한다. 이미 최종 디렉터리와 `pending_artifact_path`가 commit된 설치본은 보존하고 시작 시 승격한다.
- 사용자의 명시적 삭제가 자동 업데이트보다 우선한다. 해당 에이전트의 준비와 draining을 취소하고 기존 삭제 흐름으로 프로세스를 종료한 뒤 active, pending과 staging 설치본을 제거한다. npm 공유 다운로드 cache와 관리형 runtime은 보존한다.
- 활성 설치본이 손상된 경우에만 준비 중 상태에서 현재 Registry 배포로 자동 복구한다. 정상 active가 있으면 pending 준비를 기다리지 않고 대화를 시작한다.
- 자동 업데이트 준비·draining·성공·실패를 위한 새 진행 문구, 알림 또는 설정 UI는 추가하지 않는다. 활성 설치본이 있는 업데이트 실패는 진단 로그만 남기고 다음 Registry 갱신에서 재시도한다.
- schema는 출시 전 정책에 따라 v1 초기 schema를 직접 수정하고 upgrade migration은 추가하지 않는다.

## Testing Decisions

- 테스트는 내부 mutex나 task 배치보다 catalog 노출, 실행 command, 설치 버전, 파일 전환과 재시작 결과를 검증한다.
- Registry fixture에 uvx 전용, 알 수 없는 배포, binary+npx, 미지원 현재 플랫폼 binary, 설치된 뒤 미지원이 된 항목을 포함한다.
- uvx 전용과 알 수 없는 배포 항목이 미설치 상태에서 catalog에 없고, 같은 항목의 활성 설치가 있으면 제거 가능하게 보이는 테스트를 둔다.
- Registry metadata를 DB에 저장하고 다시 읽은 뒤 알 수 없는 distribution 데이터가 유지되는 테스트를 둔다.
- 로그인 셸 PATH, 앱 PATH와 관리형 fallback은 제어된 executable fixture를 사용하는 NodeRuntime 단위 테스트로 각각 검증한다.
- Node 21 이하, 누락된 npm, 실패하는 version probe가 관리형 fallback으로 이어지는 테스트를 둔다.
- 정상 시스템 Node/npm 쌍은 관리형 archive를 다운로드하지 않고, 사라진 cached runtime은 관리형으로 전환되는 테스트를 둔다.
- 시스템 npm command에는 격리 config가 없고 관리형 npm command에는 빈 config와 전용 cache가 설정되는지 검증한다.
- npm install fixture가 version upper bound, lifecycle script 허용과 실제 설치 버전 저장을 관찰한다.
- 시스템 npm 설치 실패 시 관리형 runtime download 또는 install 재시도가 발생하지 않는 테스트를 둔다.
- 저장소를 다시 열어도 Node entrypoint 정의에 시스템 Node 절대 경로가 남지 않고, 인증과 ACP 실행 때 resolver가 선택한 Node를 사용하는 테스트를 둔다.
- 앱 시작은 cached catalog와 스레드 복원을 네트워크에 막지 않으면서 매번 한 번 갱신을 시작하고, 실행 중 한 시간 주기와 수동 새로고침도 업데이트 준비를 유발하는 테스트를 둔다.
- Registry version 또는 source identity 변경 후 설치된 에이전트만 백그라운드에서 준비하고, 같은 identity를 반복 수신하면 active나 pending을 재설치하지 않는 테스트를 둔다.
- 서로 다른 네 에이전트의 제어된 installer fixture로 최대 세 작업만 동시에 실행되고, 같은 에이전트의 준비와 공유 Node 준비는 single-flight인 테스트를 둔다.
- 최종 경로가 `agents/<agent-id>/<installation-id>/`이고 `installation.json`에 승격·비교·실행에 필요한 최소 정보만 있으며 역할과 진행 상태가 없는지 검증한다.
- 준비 실패가 active 설치와 기존 pending을 유지하고 사용자 catalog를 실패 상태로 바꾸지 않는 테스트를 둔다.
- 준비 중 더 최신 identity가 발견되면 오래된 완료물을 활성화하지 않고 최신 설치를 이어서 준비하며, 최신 준비가 실패하면 기존의 검증된 pending을 유지하는 테스트를 둔다.
- 유휴 프로세스가 있으면 이를 종료한 뒤 같은 앱 실행에서 즉시 승격하고, active turn이 있으면 완료될 때까지 구버전을 유지하는 테스트를 둔다.
- draining 동안 새 turn은 시작하지 않고 새 메시지와 기존 대기 메시지를 보존하며, 같은 agent ID의 모든 프로세스를 reap하고 승격·재개한 뒤 순서대로 처리하는 테스트를 둔다.
- 정상 종료 timeout에서는 Atte 소유 프로세스만 강제 종료하고, reap 실패 시 active selector와 구버전 파일을 유지하는 테스트를 둔다.
- 새 연결 시작과 승격이 경합해도 구버전 프로세스가 생기지 않고, 같은 agent ID의 기본 실행 정의가 한 버전으로 유지되는 테스트를 둔다.
- manager를 다시 열면 기존 `agents` 행의 pending 경로를 active로 승격하고 이전 active, staging과 orphan 설치 디렉터리를 제거하며 공유 runtime/cache는 남기는 테스트를 둔다.
- 디렉터리 확정, pending commit, active 승격과 정리의 각 crash 경계에서 다시 열면 안전하게 수렴하는 테스트를 둔다.
- 준비 중 앱 종료는 지연되지 않고 미확정 staging은 다음 시작에 정리되며, commit된 pending은 보존·승격되는 테스트를 둔다.
- 자동 업데이트와 명시적 삭제가 경합하면 삭제가 이기고 해당 에이전트의 active·pending·staging만 제거되는 테스트를 둔다.
- frontend에는 업데이트 상태나 메시지를 추가하지 않았음을 기존 agent management 렌더링 테스트로 확인한다.

## Out of Scope

- uvx, uv 또는 Python 런타임 지원
- Windows와 Linux 관리형 Node.js 배포
- Node 경로, 시스템 런타임 무시 또는 자동 다운로드 금지 설정 UI
- 수동 업데이트 버튼, 업데이트 진행률, 성공 알림 또는 실패 경고
- 설치 버전 rollback UI와 업데이트 이력 보관
- 자동 업데이트 동시성, 주기 또는 활성화 정책 설정 UI
- npm 공유 cache 크기 제한 또는 정리 정책
- Registry 배포 schema 자체의 변경

## Further Notes

- Zed의 검증된 패턴 중 binary 우선 선택, uvx 미노출, 시스템 Node 우선·관리형 fallback, npm 버전 상한과 lifecycle script 허용을 따른다.
- Atte는 명시적 설치 모델을 유지하므로 Zed의 대화 시작 시 lazy installation은 따르지 않는다. Chrome·Sparkle·Homebrew·OSTree에서 공통으로 확인한 별도 설치본 준비, 작은 selector 전환과 사후 정리 패턴을 따른다.
- 설치본 저장과 실행 중 전환은 [Stage immutable agent installations and drain runtimes before activation](../../docs/adr/0003-stage-agent-installations-and-drain-runtimes.md)을 따른다.
