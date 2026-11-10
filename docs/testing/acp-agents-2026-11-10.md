# ACP 에이전트 설치·실행 검증 — 2026-11-10

macOS 26.6.2 / ARM64, Node.js v24.19.0, npm 11.17.0에서 실행했다. [공식 Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 45개 중 Claude·Codex·Grok·Antigravity 4개를 제외하고, 현재 Atte가 설치할 수 있는 39개를 실제 다운로드·설치·실행했다. uvx 전용 Fast-agent·Minion Code 2개는 현재 미지원으로 테스트하지 않았다.

Atte의 실제 SystemInstaller, 인증용 initialize, Threads 연결·session/new 경로를 사용했다. 별도 임시 앱 DB·HOME·작업 폴더에서 실행했고 기존 사용자 로그인 파일·API 키를 제공하지 않았다. 모델 프롬프트 전송과 로그인 후 작업 수행은 검증하지 않았다. 스레드 생성 성공은 메시지 응답까지 보장하는 판정이 아니다. Windows·Linux 실행 결과가 아니다.

Registry 원문 SHA-256: `058934be542f579db42af20eef9111ac332479f90c0cea2dde3fd84c31ca1b16`.

## 검증 후 지원 결정

Harn(`harn`), Agoragentic(`agoragentic-acp`), Crow(`crow-cli`)는 아래에서 확인한 호환성·배포 문제로 Atte 지원 대상에서 제외했다. 설치·자동 업데이트·실행을 차단하며 미설치 항목은 카탈로그에서 숨긴다. 기존 설치 파일과 스레드 기록은 보존하고, 기존 설치 항목은 설정에서 삭제할 수 있다. 제외 정책은 Registry 새 버전에도 유지한다.

Goose·Pi ACP는 지원한다. Goose의 기존 제공자·모델·인증 설정을 앱에서 읽을 수 있고 Pi의 별도 `pi` CLI를 앱 PATH에서 찾을 수 있어야 한다. 초기 설정을 완료한 환경에서의 Atte 연결·메시지 성공은 아직 검증하지 않았다.

아래 표와 개수는 제외 결정 전의 실제 검사 이력으로 보존한다. 이후 전수 검증기는 같은 Registry 지원 정책을 따르므로 위 세 에이전트를 실행하지 않고 제외 사유를 `skipped`에 기록한다.

제외 정책 적용 후 `pnpm validate`의 정적 검사·FSD 검사·타입 검사·프런트엔드 테스트 530개와 `sh scripts/validate-rust.sh`의 포맷·전체 대상/feature 검사·Clippy·Rust 테스트 386개가 통과했다(Rust 제외 10개). 회귀 검사에서는 캐시를 다시 연 뒤의 카탈로그 제외, 설치·기존 설치 재사용·인증 차단, 실행 가능한 에이전트 복원 제외, 자동 업데이트 제외, Registry 메타데이터가 없는 기존 설치의 사유 보존 및 삭제를 확인했다. 설정 화면은 기존 설치 항목의 사용 불가 사유를 한국어·영어로 표시한다.

## 요약

| 판정 | 수 |
| --- | ---: |
| 스레드 생성 성공 | 12 |
| 인증 필요 | 22 |
| 추가 설정·도구 필요 | 2 |
| 호환성·배포물 문제 | 3 |
| 설치 실패 | 0 |

후속 공통 tar 해제 수정과 Harn·Mistral Vibe 재검증을 반영한 결과는 설치 성공 39개, Atte 인증 검사 초기화 성공 38개다. Crow는 초회 검사 시간 초과 뒤 직접 초기화에는 응답했으나 세션 생성에 실패했다. Mistral Vibe도 첫 인증 검사에는 실패했지만 같은 설치본 재검사에서는 성공했다. 인증 필요 22개는 에이전트가 ACP 오류 -32000을 통해 정상적으로 인증을 요구한 경우이며 로그인 후 세션·메시지 성공은 미검증이다. 아래 최종 표는 초기 39개 검사와 개별 재검증을 합친 결과이며, 수정 후 39개 전체를 다시 실행한 결과는 아니다.

## 전체 결과

| 에이전트 | 버전 | 배포 | 설치 | ACP 초기화 | 최종 판정 | 비고 |
| --- | --- | --- | --- | --- | --- | --- |
| Agoragentic | 1.3.0 | npm | 성공 | 성공 | 호환성·배포물 문제 | `session/new`에 -32601 Method not found 반환. |
| Amp | 0.12.0 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Auggie CLI | 0.37.0 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Autohand Code | 0.9.10 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Bob | 2.1.0 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Cline | 3.0.74 | npm | 성공 | 성공 | 인증 필요 | 초회에는 Atte의 과도한 링크 동일성 검사로 실패. 수정·회귀 테스트 후 재설치와 초기화 성공, 인증 필요. |
| Codebuddy Code | 2.182.0 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Cortex Code | 1.0.73 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Corust Agent | 0.6.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| crow-cli | 0.1.49 | binary | 성공 | 초회 실패 | 호환성·배포물 문제 | 초회 Atte 초기화 시간 초과. 직접 재시도에서는 초기화 성공. 기본 MCP 호출에서 `crow-cli`를 PATH에서 찾지 못함. PATH 보완 후에도 `crow_cli.mcp.vision` 모듈 누락으로 하위 프로세스 종료. |
| Cursor | 2026.11.05 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| DeepAgents | 0.1.7 | npm | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Devin | 3000.12.32 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| DimCode | 0.5.25 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Dirac | 0.5.24 | npm | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Factory Droid | 1.6.1 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Gemini CLI | 0.67.0 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| GitHub Copilot | 1.0.108 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| GLM Agent | 1.17.1 | npm | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| goose | 1.58.0 | binary | 성공 | 성공 | 추가 설정·도구 필요 | `session/new` 내부 오류. 로그에서 `GOOSE_PROVIDER` 설정 누락 확인. |
| Harn | 0.10.193 | binary | 성공 | 성공 | 호환성·배포물 문제 | 공통 tar 링크 지원 후 설치·초기화 성공. `session/new`에서 비표준 `environmentPolicy` 필수 요구로 -32602 반환. |
| Junie | 3959.6.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kilo | 7.8.27 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Kimchi | 1.32.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kimi CLI (Legacy) | 1.52.0 | binary | 성공 | 성공 | 인증 필요 | 초회 인증 검사 초기화 실패. 설치본을 재사용한 재검증에서는 Atte 초기화 성공 및 인증 필요 반환. |
| Kimi Code | 2.5.2 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kiro CLI | 3.0.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| MiniMax Code | 0.2.7 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Mistral Vibe | 3.1.1 | binary | 성공 | 성공 | 인증 필요 | 공통 tar 링크 지원 후 설치 성공. 첫 인증 검사 실패 후 같은 설치본 재검사 성공. 스레드 연결은 `Missing API key for mistral provider.`(-32000) 반환. |
| Nova | 1.1.65 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| OpenCode | 2.2.6 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| OpenCode V2 | 2.2.6 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| pi ACP | 0.0.34 | npm | 성공 | 성공 | 추가 설정·도구 필요 | 초기화 성공. 별도 `pi` 실행 파일이 PATH에 없어 스레드 생성 실패. 에이전트가 `@earendil-works/pi-coding-agent` 설치를 요구. |
| Poolside | 1.0.16 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Qoder CLI | 1.1.86 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Qwen Code | 0.27.1 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| siGit Code | 1.7.10 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Stakpak | 0.3.88 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| VT Code | 0.96.14 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |

## 테스트 중 수정한 항목

Cline의 메인 npm 패키지는 JS 래퍼를 제공하지만 npm이 실제 `.bin/cline`을 같은 설치본의 `@cline/cli-darwin-arm64/bin/cline`에 연결했다. 두 경로가 동일해야 한다는 Atte 검사를 제거했다. 메타데이터·선언된 진입점·실제 실행 링크의 설치본 내부 경계 검증은 유지했다. 이 링크 구조의 회귀 테스트가 수정 전 Integrity 오류로 실패하고 수정 후 통과하는 것을 확인했다. Cline을 새 임시 설치본에 다시 설치해 initialize 성공·인증 필요 응답을 확인했다.

## 후속 공통 설치 수정

Harn의 실행 파일 별칭과 Mistral Vibe의 Python.framework 상대 링크를 축소한 Rust tar fixture가 기존 해제기에서 `Integrity`로 실패하는 것을 확인했다. 에이전트 ID별 예외 대신 기존 `tar` 0.4.46의 `Entry::unpack_in`을 사용하도록 공통 해제 경로를 수정했다. 엔트리별 실제 부모 경로 검증과 전체 해제 후 링크 최종 대상 검증을 함께 적용한다. 관리 Node 런타임만 링크를 무시하던 분기도 제거했다. 외부 경로·끊어진 링크·순환 링크·덮어쓰기·특수 파일 거부, 합계 해제 용량 제한과 특수 권한 비트 제거는 유지한다. ZIP 링크 지원은 변경하지 않았다.

같은 Registry snapshot·버전·체크섬으로 격리 HOME에서 실제 설치를 다시 수행해 Harn과 Mistral Vibe 모두 설치 성공을 확인했다. Harn은 Atte 인증 검사 초기화도 성공했으나, 스레드 생성 시 아래의 비표준 요청 필드 요구가 새로 드러났다. Mistral Vibe는 첫 인증 검사에 실패했지만 스레드 연결에서는 정상적인 인증 필요 오류를 반환했고, 동일 설치본을 재사용한 재검사에서는 Atte 인증 검사 초기화도 성공했다. 첫 검사 실패 원인은 확정하지 않았고 자동 재시도나 시간 제한 변경을 추가하지 않았다.

회귀 검사는 `cargo test --manifest-path src-tauri/Cargo.toml --lib agent_management::archive::tests --locked`로 실행한다. CLI 별칭·framework 체인·앞선 링크·내부 `..` 대상·하드 링크·새 런타임 출력 디렉터리·외부 쓰기 거부·덮어쓰기 거부·끊어진 링크·순환 링크·용량 제한·특수 파일 거부를 검사한다.

## 남은 문제의 근거

- **Harn:** 링크 거부로 인한 설치 실패는 해결했다. 이후 `session/new`에서 `[environment_policy.missing] runnable session admission requires environmentPolicy`(-32602)를 반환했다. `kind`를 `inherited`, `isolated`, `granted` 중 하나로 지정하라고 요구한다. 표준 ACP 요청에 없는 에이전트 전용 필드를 임의로 추가하지 않았다.
- **Agoragentic:** `initialize` 응답 후 `session/new`에 `Method not found: session/new`(-32601)를 반환했다.
- **Crow:** 기본 설정이 내부 MCP 서버를 `crow-cli mcp`로 실행해 PATH 의존성이 있다. 실행 파일 디렉터리를 PATH에 추가한 비교 실행에서도 `ModuleNotFoundError: No module named crow_cli.mcp.vision`으로 MCP 프로세스가 종료했다. 배포 바이너리 의존성 문제도 존재한다.
- **Goose:** 에이전트 자체 로그의 내부 오류 데이터가 `Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER`였다.
- **Pi ACP:** 에이전트가 `Could not start pi: executable not found (command: pi)`를 반환했다.
- **Kimi CLI Legacy:** 첫 검사에서는 초기화에 실패했다. 동일 설치본 재사용 재검증에서는 initialize와 인증 필요 응답을 확인했으므로 재시도 결과로 분류했다.

Harn의 전용 요청 확장, Agoragentic의 메서드 대체, Crow 배포물 패치, Goose 제공자·모델 자동 선택, Pi 별도 패키지 자동 설치는 추가하지 않았다. [Pi 공식 설치 전제](https://github.com/svkozak/pi-acp#prerequisites)도 별도 `pi` 실행 파일과 제공자 설정을 요구한다. 논의 후 Harn·Agoragentic·Crow는 지원 대상에서 제외하고, Goose·Pi ACP는 기존 CLI 설정·도구를 앱에서도 사용할 수 있어야 하는 지원 대상으로 유지하기로 결정했다.

## 재현과 회귀 검사

전수 검증기는 `src-tauri/src/agent_management/live_registry_tests.rs`의 opt-in 테스트다. `ATTE_SWEEP_ROOT`와 별도 HOME을 같은 임시 부모 디렉터리 아래 형제 디렉터리로 준비하고, 결과 경로를 `ATTE_SWEEP_REPORT`로 지정해야 한다. `ATTE_SWEEP_ONLY`로 ID 목록, `ATTE_SWEEP_REGISTRY`로 Registry snapshot, `ATTE_SWEEP_REUSE_STORE`로 읽기 전용 설치본 재사용을 선택할 수 있다.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  agent_management::live_registry_tests::installed_registry_agents_initialize_and_create_sessions \
  --locked -- --ignored --nocapture
```

실제 실행 시에는 허용 목록의 시스템 환경변수만 전달해 원래 HOME과 API 키를 제외했다. 최초 39개 실행은 약 17분 16초가 걸렸고 Cline·Kimi는 별도 재검증했다. 실행기는 에이전트별 실패를 수집해 JSON에 기록한다. 테스트 실행기 자체의 종료 코드 0은 모든 에이전트의 성공을 의미하지 않는다.

Cline 수정 후 `scripts/validate-rust.sh`의 포맷·전체 대상 검사·Clippy 및 Rust 테스트 379개 통과(실패 0개, opt-in 등을 포함해 제외 10개)를 확인했다. 전수 네트워크 테스트와 Cline·Kimi 재검증은 별도로 명시 실행했다.

Windows 전체 대상·전체 feature 교차 검사도 통과했다. Windows 실제 실행은 하지 않았다. 검증 종료 후 약 8.8GB의 임시 설치본·격리 HOME은 삭제했고, Registry snapshot과 초기·재검증 JSON은 로컬 `.scratch/acp-smoke/`에 보존했다. 기존 앱 설치 목록·사용자 인증 파일은 변경하지 않았다.

후속 tar 수정 후 `sh scripts/validate-rust.sh`의 포맷·전체 대상/feature 검사·Clippy 및 Rust 테스트 384개가 통과했다(실패 0개, 제외 10개). 실제 Harn·Mistral Vibe 설치 재검증과 Vibe 재검사는 별도로 실행했으며, 결과 JSON은 로컬 `.scratch/acp-smoke/link-fix-results.json`, `.scratch/acp-smoke/link-fix-recheck.json`에 보존했다. 실행기의 종료 코드 외에 개별 `install`·`initialize`·`session_error` 필드로 판정했다.

후속 수정의 `cargo xwin check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets --all-features --locked`도 통과했다. Windows 실제 실행은 검증하지 않았다.
