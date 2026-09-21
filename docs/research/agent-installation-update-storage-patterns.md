# 설치형 프로그램의 업데이트 저장·활성화 패턴

조사일: 2026-09-20 (Asia/Seoul). Zed, Chromium, Sparkle, Homebrew, OSTree의 공식 문서와 소스를 확인했다. 이 문서는 관찰 결과와 Atte 설계의 도출 과정을 기록하며, 확정 결정은 연결된 ADR이 우선한다.

## 결론

실행 중인 프로그램을 안정적으로 갱신하는 제품들은 대체로 **새 설치본을 별도 위치에 완성한 뒤, 안전한 수명주기 경계에서 활성 설치본을 가리키는 작은 상태만 전환**한다. 이전 설치본 정리는 전환과 분리하고 실패 시 재시도한다. 반면 실행 직전에 항상 패키지를 준비하는 Zed의 npx 경로처럼 지연 설치를 전제로 한 시스템은 단일 디렉터리의 제자리 갱신도 사용한다.

Atte에는 이 패턴을 에이전트별 불변 설치본과 SQLite selector로 적용한다. 다만 현재 저장 모델과 active 하나·pending 하나라는 제한을 이용해 설치본별 테이블 대신 기존 `agents` 행의 active 정보와 단일 pending 경로를 사용한다. 새 설치본이 준비되면 해당 에이전트의 새 turn을 막고 진행 중인 turn을 마친 뒤 구버전 프로세스를 종료하므로, 다음 앱 시작을 기다리지 않고 안전하게 활성화할 수 있다. 구체적인 최종 결정은 [ADR 0003](../adr/0003-stage-agent-installations-and-drain-runtimes.md)에 기록한다.

## 비교

| 제품 | 새 버전 저장 | 활성화 | 이전 버전 정리·복구 |
| --- | --- | --- | --- |
| Zed binary agent | 버전·URL·checksum에서 만든 캐시 키별 디렉터리 | 에이전트 명령을 구할 때 해당 디렉터리를 선택 | 선택 후 다른 캐시 디렉터리를 정리 |
| Zed npx agent | 에이전트별 단일 npm 디렉터리 | 명령을 구할 때 `npm install` 후 즉시 사용 | 별도 active/pending 설치본 없음 |
| Chrome/Chromium on Windows | 사용 중이면 `new_chrome.exe`와 새 버전 디렉터리를 병렬 보관하고 Registry에 이전 버전·전환 명령 기록 | Chrome 시작 또는 종료 경계에서 `chrome.exe → old_chrome.exe`, `new_chrome.exe → chrome.exe` | 전환 실패 시 work item rollback; old 파일은 별도 프로세스가 지연·재시도 삭제 |
| Sparkle | 고유 cache 설치 디렉터리에 archive를 옮기고 별도 extraction 디렉터리에서 검증 | 대상 앱 종료 뒤 최종 설치; 앱 번들은 atomic-safe 교체 | 성공·실패 후 installer cleanup |
| Homebrew | Cellar의 버전별 keg 디렉터리 | `opt` symlink 및 prefix 링크가 활성 keg를 가리킴 | upgrade/install 뒤 기본적으로 cleanup 수행 |
| OSTree/rpm-ostree | content-addressed 저장소와 버전별 deployment를 병렬 생성 | boot configuration을 원자적으로 바꾸고 다음 부팅에 적용 | 이전 deployment를 rollback 대상으로 유지; 기본적으로 최대 두 개 보관 |

## Zed: 배포 형식마다 다른 모델

Zed의 Registry binary 설치는 `registry/<agent-id>` 아래에서 Registry 버전, archive URL, checksum을 반영한 cache key를 사용한다. 명령이 필요할 때 현재 cache key의 설치본을 준비하고 사용하므로 파일시스템의 버전별 디렉터리가 설치본 정체성을 가진다. 현재 설치본을 가리키는 독립 DB 행이나 영속 `pending` 슬롯은 없다. [cache key와 설치 디렉터리](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1025-L1054), [다운로드·검증·정리](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1117-L1327)

npx 경로는 다르다. 에이전트별 `registry/npx/<id>` 디렉터리에 `npm install --save-exact`를 실행하고 그 설치본에서 executable을 찾아 바로 실행한다. 버전별 active/pending 복사본을 교체하는 모델이 아니라 실행 명령을 구하는 경로에서 단일 package 디렉터리를 갱신하는 모델이다. [npx 설치 및 실행](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1338-L1426)

이 차이는 Zed의 세부 파일 배치를 그대로 복제하기보다 제품의 설치 시점에 맞춰 패턴을 선택해야 함을 보여준다. Atte는 스레드 시작 시 지연 설치하지 않으므로 Zed npx의 제자리 갱신은 직접적인 기준이 되기 어렵다.

## Chromium: 명시적인 현재·새 executable과 지연 전환

Windows Chromium installer는 실행 중인 `chrome.exe`를 덮어쓰지 못하면 새 executable을 `new_chrome.exe`로 둔다. 동시에 Registry의 `opv`에 현재 active 버전을 기록하고 다음 전환을 수행할 rename command를 등록한다. 사용 중이 아닌 설치에서는 이 임시 상태를 제거하고 즉시 finalize한다. [in-use update 상태 기록](https://chromium.googlesource.com/chromium/src/+/main/chrome/installer/setup/install_worker.cc#840)

전환 경계에서는 기존 executable을 `old_chrome.exe`로, 새 executable을 `chrome.exe`로 옮기고 Registry의 임시 상태를 함께 제거한다. 일련의 work item이 실패하면 변경을 rollback한다. [rename과 rollback](https://chromium.googlesource.com/chromium/src/+/main/chrome/installer/setup/setup_main.cc#529)

정리는 활성화와 별도다. 이전 파일이 아직 사용 중일 수 있으므로 정리 프로세스는 처음 15초를 기다리고, 실패하면 5분 간격으로 재시도한다. [이전 버전 정리 재시도](https://chromium.googlesource.com/chromium/src/+/main/chrome/installer/setup/setup_main.cc#460) 이는 "활성화 성공"과 "이전 파일 삭제 성공"을 하나의 원자적 작업으로 묶지 않아도 됨을 보여준다.

## Sparkle: 검증된 staging과 앱 종료 경계

Sparkle는 다운로드 archive를 bundle별 cache 아래 고유 설치 디렉터리로 옮기고, 그 안에 별도 extraction 디렉터리를 만든다. 압축 해제 뒤 서명·버전을 검증한 다음에만 설치 단계로 넘어간다. [고유 staging 및 extraction 디렉터리](https://github.com/sparkle-project/Sparkle/blob/2.x/Autoupdate/AppInstaller.m#L435-L440), [압축 해제 후 검증](https://github.com/sparkle-project/Sparkle/blob/2.x/Autoupdate/AppInstaller.m#L283-L304)

installer는 대상 앱 종료를 감지한 뒤 최종 설치를 수행하고 필요하면 재실행한다. 자동 업데이트도 공식 API상 "install on quit"로 예약된다. [종료 이후 final installation](https://github.com/sparkle-project/Sparkle/blob/2.x/Autoupdate/AppInstaller.m#L728-L789), [install-on-quit API](https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html#updaterwillinstallupdateonquitimmediateinstallationblock)

Sparkle는 앱 번들 교체를 atomic-safe install로 설명하며, 파일 계층에는 원자적 `RENAME_SWAP` 지원도 있다. [Sparkle 기능 설명](https://github.com/sparkle-project/Sparkle#features), [atomic swap 구현](https://github.com/sparkle-project/Sparkle/blob/2.x/Sparkle/SUFileManager.m#L229-L339) 핵심은 다운로드 상태를 앱의 주 데이터 행에 복제하는 것이 아니라, 검증 전 artifact를 staging에 격리하고 실행 중인 앱이 끝난 뒤 짧은 교체를 수행하는 것이다.

## Homebrew: 버전별 설치본과 안정적인 포인터

Homebrew에서 각 formula 버전의 설치 대상은 `Cellar/<formula>/<version>`인 별도 keg이고, rack에는 여러 버전의 keg가 함께 존재할 수 있다. `opt/<formula>`는 active keg를 가리키는 symlink다. [Homebrew 용어 정의](https://docs.brew.sh/Manpage#terminology)

설치 파일은 Homebrew prefix로 symlink되며 설치할 때 자동으로 link된다. `opt` 경로는 버전이 바뀌어도 안정적으로 유지된다. [link 동작](https://docs.brew.sh/Manpage#link-ln-options-installed_formula-installed_cask-), [안정적인 opt 경로](https://docs.brew.sh/How-to-Build-Software-Outside-Homebrew-with-Homebrew-keg-only-Dependencies#discover-the-prefix)

기본 설정에서는 install·upgrade 뒤 cleanup이 수행된다. 즉 새 버전의 물리 디렉터리 생성, 활성 링크 변경, 구 버전 정리를 서로 구분한다. [install 후 cleanup 정책](https://docs.brew.sh/Manpage#install-options-formulacask-)

## OSTree/rpm-ostree: active·pending·rollback deployment

OSTree는 `/ostree/repo`의 content-addressed 객체와 `/ostree/deploy/<stateroot>/<checksum>`의 병렬 deployment를 사용한다. deployment는 서로 독립적인 전체 filesystem tree이며 동일 파일은 hardlink로 공유한다. [OSTree 저장 모델](https://ostreedev.github.io/ostree/introduction/#atomic-transitions-between-parallel-installable-read-only-filesystem-trees)

rpm-ostree upgrade는 실행 중인 root를 바꾸지 않고 새 deployment를 준비해 다음 boot의 기본값으로 지정한다. 이 상태를 공식 문서에서도 `pending deployment`라고 부르며, reboot 후 적용한다. 기본 정책은 boot 가능한 deployment를 최대 두 개 유지하여 이전 상태로 rollback할 수 있게 한다. [rpm-ostree 관리 모델](https://coreos.github.io/rpm-ostree/administrator-handbook/#administering-an-rpm-ostree-based-system)

활성화는 새 tree 생성과 분리된다. 새 boot directory를 완성한 다음 symlink를 원자적으로 바꾸고, 이전 내용은 이후 어느 시점에든 garbage collection할 수 있다. 전원 중단 시 old 또는 new 중 하나만 관찰되도록 설계한다. [OSTree atomic upgrade](https://ostreedev.github.io/ostree/atomic-upgrades/#atomically-swapping-boot-configuration)

Atte가 rollback deployment까지 구현할 필요는 없지만, **새 설치본 완성 → 작은 selector 전환 → 나중에 old 정리**라는 구조는 직접 적용할 수 있다.

## 반복되는 설계 원칙

1. **artifact와 역할을 분리한다.** 버전별 directory/deployment/keg가 실제 설치본이고, `current`, `opt`, boot order, Registry state 같은 작은 selector가 active 역할을 결정한다.
2. **준비 중인 artifact는 실행 경로 밖에 둔다.** 다운로드·압축 해제·패키지 설치·검증이 끝나기 전에는 active selector를 바꾸지 않는다.
3. **활성화 경계를 제품 수명주기에 맞춘다.** Chrome은 다음 시작/종료, Sparkle는 앱 종료, OSTree는 reboot를 사용한다. 실행 중인 파일을 추적해 즉시 바꾸는 복잡성을 피한다.
4. **활성화와 정리를 분리한다.** old 삭제 실패는 새 버전 활성화를 되돌릴 이유가 아니다. 참조되지 않는 artifact를 이후 시작이나 별도 cleanup에서 다시 지울 수 있다.
5. **제자리 갱신은 명시적인 선택이다.** Zed npx처럼 명령 준비가 곧 설치인 경우에는 단순하지만, 대화 시작 지연을 피하려는 Atte에는 부적합하다.

## Atte의 최종 적용

조사 단계에서는 설치본별 행을 두는 정규화 구조를 권장했지만, Atte의 현재 `agents` 행과 필요한 상태가 active 하나·pending 하나로 제한된다는 점을 반영해 더 단순한 단일 행 구조로 결정했다. 최종 결정은 [ADR 0003](../adr/0003-stage-agent-installations-and-drain-runtimes.md)이 우선한다.

```text
agents/<agent-id>/<installation-id>/
├── installation.json
└── <artifact files>

agents row
├── active installation fields
└── pending_artifact_path
```

새 테이블이나 설치본별 행은 만들지 않는다. SQLite는 active와 pending 역할의 유일한 selector이고, `installation.json`은 해당 설치본의 승격·비교·실행에 필요한 최소 불변 정보만 보존한다. `current` symlink나 파일의 역할 필드는 두 번째 selector가 되므로 두지 않는다.

전환 순서는 다음과 같다.

1. 백그라운드 작업은 설치 저장소와 같은 filesystem의 임시 디렉터리에 새 버전을 설치하고 검증한다.
2. 검증 성공 뒤 최소 불변 정보를 담은 `installation.json`과 artifact를 고유한 최종 설치 디렉터리로 rename하고, 기존 `agents` 행의 pending 경로를 transaction으로 교체한다.
3. 해당 에이전트의 새 turn을 막고 진행 중인 turn만 마친 뒤 구버전 프로세스를 모두 종료·reap한다.
4. 같은 행에서 pending을 active로 원자적으로 옮기고 Threads의 실행 정의를 갱신한다.
5. 이전 active와 다른 미참조 설치 디렉터리를 비차단으로 삭제한다. 실패하면 다음 앱 시작에서 다시 시도한다.

이 모델은 Chrome·Sparkle·OSTree의 안전 경계 전환과 Homebrew의 버전별 설치본을 차용하면서도 rollback 이력과 범용 deployment 엔진을 추가하지 않는다. Atte의 대기 메시지와 스레드 재개 기능을 이용해 진행 중인 turn을 보존하면서 같은 앱 실행 안에서 새 버전으로 전환한다.
