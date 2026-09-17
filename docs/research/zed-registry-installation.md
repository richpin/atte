# Zed의 ACP Registry 설치 구조

확인일: 2026-09-17. Zed의 GitHub HEAD를 조회한 뒤 커밋 `b6171bcc982c406c34e786c09ae26f59620e52ae`의 실제 Rust 파일을 내려받아 확인했다. Registry 원본은 커밋 `9ebd8ead7e8cb22d7c2d7bc8df9fdea62172d2af`와 실제 CDN 응답을 함께 확인했다. 이 문서는 관찰 결과이며 Atte의 확정 ADR이 아니다.

Zed의 일반 Registry 경로는 에이전트 이름별 설치 코드를 추가하지 않는다. Registry의 배포 정의를 읽고 현재 OS·CPU에 맞는 binary를 우선 선택하며, 그것이 없으면 npx 배포를 사용한다. **모든 에이전트를 네이티브 바이너리로 통일한 구현은 아니다.** 현재 Claude와 Codex의 공식 Registry 배포는 npx뿐이므로 이들을 지원하면서 npm을 완전히 제거하는 것은 Registry의 현재 배포 정의와 맞지 않는다.

## 목록 및 배포 선택

- 목록 주소는 `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`이다. 목록 전체를 캐시하고 시작할 때 읽는다. `refresh_if_stale`는 한 시간 간격으로 갱신을 제한한다. 갱신 실패 시 기존 메모리 목록을 지우지 않는다. [URL과 상수](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L20-L21), [갱신 및 캐시 로드](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L209-L332)
- 각 entry의 `id`, `name`, `description`, `version`, 링크, 아이콘, `distribution`을 그대로 일반 모델로 변환한다. 특정 에이전트 allowlist를 거치지 않고 전체 목록을 순회한다. [목록 변환](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L363-L461)
- 지원하는 배포 필드는 `binary`와 `npx`다. 이 커밋의 `RegistryDistribution`에는 `uvx`가 없다. [역직렬화 모델](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L634-L686)
- 선택 순서는 **현재 플랫폼 binary → npx**이다. binary와 npx가 모두 있어도 binary가 현재 플랫폼을 지원하지 않으면 npx를 선택한다. binary만 있고 플랫폼이 맞지 않으면 목록 모델에는 비지원 상태로 남지만 실행 서버 등록에서는 제외한다. 이는 설치 실패 후 자동으로 npx를 시도하는 정책이 아니라, 메타데이터를 읽을 때 한 가지 배포를 선택하는 정책이다. [선택](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L408-L456), [비지원 제외](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L376-L436)
- 플랫폼 키는 `darwin|linux|windows` × `aarch64|x86_64`다. 공급자가 선언한 키에 맞춰 선택한다. [플랫폼 매핑](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_registry_store.rs#L587-L624)

## binary 설치와 실행

`LocalRegistryArchiveAgent` 하나가 모든 Registry binary 설치를 처리한다. 대상 플랫폼의 `archive`, `cmd`, `args`, `env`, 선택적인 `sha256`을 사용한다. 설치 디렉터리는 external agents 디렉터리의 `registry/<id>` 아래다. 하위 캐시 키에는 버전과 URL, 명시된 체크섬이 반영된다. 다운로드는 실제 실행 명령을 구하는 시점에 필요할 때 수행한다. [등록 및 경로](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L384-L414), [캐시 키](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1025-L1054), [설치](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1117-L1327)

지원 형식은 zip, tar.gz/tgz, tar.bz2/tbz2, raw executable이다. dmg/pkg/deb/rpm/msi/appimage와 미지원 압축 형식은 거부한다. 명시된 체크섬이 없고 GitHub Release URL이면 Release API의 asset digest도 조회한다. 두 경로 모두 체크섬을 얻지 못하면 체크섬 없이 내려받을 수 있으므로 “모든 다운로드에 체크섬을 강제한다”는 설명은 부정확하다. [형식 분류](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L897-L948), [체크섬과 다운로드](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1227-L1279)

실행 파일은 기본적으로 압축을 푼 위치의 상대 경로(`./...`)이고, `..` 포함 명령을 거부한다. `cmd == "node"`인 배포는 공통 NodeRuntime으로 처리하는 예외가 있다. 따라서 `binary`라는 배포 이름만 보고 항상 독립 네이티브 실행 파일이라고 가정하면 안 된다. [명령 해석](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1282-L1306)

## npx 배포와 NodeRuntime

`LocalRegistryNpxAgent`는 `registry/npx/<id>`에 공통 `npm install ... --save-exact`를 실행하고, 설치된 package의 executable을 찾아 Node로 실행한다. 사용자에게 전역 npm 설치를 요구하는 구조가 아니다. 이름이 npx 배포이지만 매번 셸에서 `npx <agent>`를 직접 실행하는 구현도 아니다. [npx 설치 및 실행](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1338-L1426)

NodeRuntime은 설정으로 지정된 경로, 허용된 경우 PATH의 Node/npm, 허용된 경우 Zed가 다운로드하는 Node 순서로 해결한다. 관리형 Node는 OS·CPU별 배포를 `nodejs.org/dist`에서 받아 앱 데이터 아래에 둔다. 따라서 에이전트별 런타임 탐색 코드가 아니라 공통 런타임 계층이다. [선택](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/node_runtime/src/node_runtime.rs#L87-L163), [다운로드](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/node_runtime/src/node_runtime.rs#L630-L721)

현재 Zed는 Registry의 정확한 npm 버전을 그대로 강제하지 않고, 사용자의 npm minimum release age 정책과 호환되도록 semver 버전을 상한 범위로 변환한다. 이는 Zed에 실제 있는 정책이지만 Atte가 그대로 채택해야 한다는 뜻은 아니다. 버전 재현성과 공급자 manifest의 args 호환성에 별도 판단이 필요하다. [버전 정책과 주석](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L1436-L1469)

## Claude·Codex 내장 구현과 일반 Registry 경로의 구별

이전에 조사한 Zed 커밋의 내장 Claude/Codex adapter 구현을 최신 일반 Registry 경로로 해석하면 안 된다. 현재 확인한 커밋의 `crates/agent_servers/src` 트리에는 `claude.rs`와 `codex.rs`가 없으며, Registry 등록은 에이전트 ID가 아니라 Binary/Npx 배포 변형을 기준으로 분기한다. [현재 디렉터리](https://github.com/zed-industries/zed/tree/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/agent_servers/src), [일반 등록 코드](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L376-L439)

Registry의 해당 시점 정의는 다음과 같다.

| 에이전트 | Registry ID | 배포 |
| --- | --- | --- |
| Claude Agent | `claude-acp` | `@agentclientprotocol/claude-agent-acp@0.78.0` npx만 제공 |
| Codex | `codex-acp` | `@agentclientprotocol/codex-acp@1.12.0` npx만 제공 |
| Google Antigravity | `antigravity-acp` | 플랫폼별 zip binary; macOS는 aarch64만 제공 |

[Claude manifest](https://github.com/agentclientprotocol/registry/blob/9ebd8ead7e8cb22d7c2d7bc8df9fdea62172d2af/claude-acp/agent.json#L14-L18), [Codex manifest](https://github.com/agentclientprotocol/registry/blob/9ebd8ead7e8cb22d7c2d7bc8df9fdea62172d2af/codex-acp/agent.json#L14-L18), [Antigravity manifest](https://github.com/agentclientprotocol/registry/blob/9ebd8ead7e8cb22d7c2d7bc8df9fdea62172d2af/antigravity-acp/agent.json#L12-L37)

Zed에 정적 agent ID가 전혀 없는 것은 아니다. `EXTENSION_TO_REGISTRY_IDS`는 기존 확장 설정을 Registry ID로 옮기는 마이그레이션 표다. 이것은 새로운 Registry 에이전트를 설치할 때 추가해야 하는 installer 표와 다르다. [마이그레이션 표와 사용](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/project/src/agent_server_store.rs#L194-L238)

또한 최신 `custom.rs`의 실행 연결 계층에는 Claude의 `ANTHROPIC_API_KEY` 초기화, Codex의 API key 환경 변수 전달 등 에이전트 ID별 환경 변수 분기가 남아 있다. 따라서 Zed의 **설치·배포 선택은 일반화되어 있다**고 설명할 수 있지만, **인증·실행 정책까지 에이전트별 예외가 완전히 없다**고 설명할 수는 없다. [실행 환경 예외](https://github.com/zed-industries/zed/blob/b6171bcc982c406c34e786c09ae26f59620e52ae/crates/agent_servers/src/custom.rs#L218-L260)

## Atte에 적용할 수 있는 원칙

소스에서 도출한 제안은 Registry 전체 목록과 공급자가 선언한 배포 정의를 데이터로 취급하고, Binary installer와 Node 기반 package installer 같은 소수의 공통 구현을 두는 것이다. 새로운 에이전트가 이미 지원하는 배포 형식을 사용하면 Atte 코드 변경 없이 표시·설치·실행할 수 있어야 한다. binary 우선 정책은 유지하되, 공식 manifest가 npx만 제공하는 에이전트의 Release URL을 이름별로 추측하거나 별도로 관리하면 에이전트별 정적 로직을 없애려는 목표에서 멀어진다.
