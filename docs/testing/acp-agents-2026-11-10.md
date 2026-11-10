# ACP 에이전트 설치·실행 검증 — 2026-11-10

macOS 26.6.2 / ARM64, Node.js v24.19.0, npm 11.17.0에서 실행했다. [공식 Registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) 45개 중 Claude·Codex·Grok·Antigravity 4개를 제외하고, 현재 Atte가 설치할 수 있는 39개를 실제 다운로드·설치·실행했다. uvx 전용 Fast-agent·Minion Code 2개는 현재 미지원으로 테스트하지 않았다.

Atte의 실제 SystemInstaller, 인증용 initialize, Threads 연결·session/new 경로를 사용했다. 별도 임시 앱 DB·HOME·작업 폴더에서 실행했고 기존 사용자 로그인 파일·API 키를 제공하지 않았다. 모델 프롬프트 전송과 로그인 후 작업 수행은 검증하지 않았다. 스레드 생성 성공은 메시지 응답까지 보장하는 판정이 아니다. Windows·Linux 실행 결과가 아니다.

Registry 원문 SHA-256: `058934be542f579db42af20eef9111ac332479f90c0cea2dde3fd84c31ca1b16`.

## 요약

| 판정 | 수 |
| --- | ---: |
| 스레드 생성 성공 | 12 |
| 인증 필요 | 21 |
| 추가 설정·도구 필요 | 2 |
| 호환성·배포물 문제 | 2 |
| 설치 실패 | 2 |

수정 후 최종 결과는 설치 성공 37개, Atte 인증 검사 초기화 성공 36개다. Crow는 초회 검사 시간 초과 뒤 직접 초기화에는 응답했으나 세션 생성에 실패했다. 인증 필요 21개는 에이전트가 ACP 오류 -32000을 통해 정상적으로 인증을 요구한 경우이며 로그인 후 세션·메시지 성공은 미검증이다.

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
| Harn | 0.10.193 | binary | 실패 | 미실행 | 설치 실패 | 다운로드 SHA-256 일치. 아카이브의 `harn-dap -> harn`, `harn-lsp -> harn` 링크를 Atte가 거부. |
| Junie | 3959.6.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kilo | 7.8.27 | binary | 성공 | 성공 | 스레드 생성 성공 | 인증 없는 환경에서 session/new 응답 성공. |
| Kimchi | 1.32.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kimi CLI (Legacy) | 1.52.0 | binary | 성공 | 성공 | 인증 필요 | 초회 인증 검사 초기화 실패. 설치본을 재사용한 재검증에서는 Atte 초기화 성공 및 인증 필요 반환. |
| Kimi Code | 2.5.2 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Kiro CLI | 3.0.0 | binary | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| MiniMax Code | 0.2.7 | npm | 성공 | 성공 | 인증 필요 | 에이전트가 인증 필요 반환. |
| Mistral Vibe | 3.1.1 | binary | 실패 | 미실행 | 설치 실패 | 다운로드 SHA-256 일치. `_internal/Python` 및 Python.framework 내부 상대 심볼릭 링크를 Atte가 거부. |
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

## 남은 문제의 근거

- **Harn / Mistral Vibe:** 두 아카이브 모두 Registry의 SHA-256과 일치했다. Atte의 tar 해제기는 일반 에이전트 아카이브의 링크 엔트리를 일괄 거부한다. 안전한 설치본 내부 링크를 지원하는 변경이 필요하다. 이번 테스트에서는 압축 해제 보안 정책을 변경하지 않았다.
- **Agoragentic:** `initialize` 응답 후 `session/new`에 `Method not found: session/new`(-32601)를 반환했다.
- **Crow:** 기본 설정이 내부 MCP 서버를 `crow-cli mcp`로 실행해 PATH 의존성이 있다. 실행 파일 디렉터리를 PATH에 추가한 비교 실행에서도 `ModuleNotFoundError: No module named crow_cli.mcp.vision`으로 MCP 프로세스가 종료했다. 배포 바이너리 의존성 문제도 존재한다.
- **Goose:** 에이전트 자체 로그의 내부 오류 데이터가 `Failed to resolve provider and model: Configuration value not found: GOOSE_PROVIDER`였다.
- **Pi ACP:** 에이전트가 `Could not start pi: executable not found (command: pi)`를 반환했다.
- **Kimi CLI Legacy:** 첫 검사에서는 초기화에 실패했다. 동일 설치본 재사용 재검증에서는 initialize와 인증 필요 응답을 확인했으므로 재시도 결과로 분류했다.

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
