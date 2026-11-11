# MCP 설정 검증

일반 검증은 `pnpm validate`와 `sh scripts/validate-rust.sh`를 사용한다. MCP 서비스 테스트는 `cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests`로 별도 실행할 수 있다.

테스트는 임시 설정 파일과 메모리 자격 증명 저장소를 사용한다. 범위 결합·비활성 제외·원본 폴더와 worktree 작업 위치·비밀값 보존/교체/삭제·자격 증명 실패·외부 편집 충돌·잘못된 파일 보존을 확인한다. Rust ACP fixture가 받은 stdio 설정으로 실제 MCP 프로세스를 실행하여 initialize, tools/list, tools/call을 수행하고, new/load/resume과 공유 런타임 재연결을 검증한다. 세션 설정을 거부하는 에이전트가 자격 증명을 오류에 되돌려 보내도 공개 오류에는 포함하지 않는다.

## OS 및 네트워크 접근이 필요한 테스트

다음 테스트는 기본 suite에서 제외하며 해당 권한이 있는 로컬 환경에서 명시적으로 실행한다. 실제 사용자 서버나 실제 API 키를 사용하지 않는다.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests::native_credentials_round_trip -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests::http_session -- --ignored
```

첫 테스트는 macOS Keychain 또는 Windows 자격 증명 저장소에 무작위 이름의 임시 자격 증명을 저장·조회·삭제한다. OS 저장소가 잠겨 있거나 샌드박스에서 접근할 수 없으면 실패하며 평문 저장으로 대체하지 않는다.

두 번째 테스트는 일시적인 loopback HTTP MCP 서버를 열고 ACP fixture에 HTTP 지원을 광고한다. Bearer·사용자 지정 인증 헤더를 확인하고 new/load/resume 이후의 실제 HTTP 도구 호출을 검증한다. listener와 에이전트 프로세스는 테스트 종료 시 정리한다.

## 네이티브 UI 확인

앱에서 다음 흐름을 밝은·어두운 테마와 키보드 조작으로 확인한다.

- 앱 메뉴의 MCPs 진입, 전역·프로젝트 선택, 검색, 등록·상세 편집·삭제와 토글.
- 비밀값을 조회하지 않고 유지·교체·행 삭제, 값 이름 변경, 교체 입력을 지운 뒤 기존 값 유지.
- 등록 상태를 연결 성공과 구분하고 서버별 전달 제외 이유를 스레드에서 확인.
- 열린 대화에서 설정 변경 안내가 표시되고, 진행 중인 작업을 유지하며 작업 종료 후 재연결 가능.
- 설정 파일을 잘못 편집하면 마지막 정상 목록과 수정할 파일 경로를 유지하고, 복구하면 새 스냅샷 반영.

현재 구현 검증에서 자동화 suite와 macOS Keychain·loopback HTTP 테스트는 통과했다. Mac이 잠겨 있어 네이티브 UI의 테마·시각적 접근성 확인은 완료하지 못했다.

## 탐색·가져오기·독립 연결 확인

`mcp::tests::import`는 Claude Code·Desktop·Cursor·Codex·Zed 형식, JSONC 주석과 마지막 쉼표, 손상·없는 원본, 지원하지 않는 전송·옵션·변수, 부분 실패, 명시적 충돌 처리, 전역·프로젝트 대상, 비활성 등록, 비밀값 분리와 원본 bytes 보존을 검증한다. 원본 입력과 토큰은 오류·검토 응답에 되돌려 보내지 않는다. 기존 저장 경계의 자격 증명 실패·롤백 검증도 함께 사용한다.

`mcp::tests::check_http`는 실패·취소·시간 초과 후에도 HTTP DELETE가 완료된 뒤 결과가 반환되는지 검증한다.

`mcp::tests::check`는 실제 stdio MCP fixture로 initialize와 tools/list, 빈 도구 목록과 도구 기능 없는 서버, 실행 실패, 시간 초과와 취소, 자식 회수, 비활성 상태 및 설정 파일 불변을 확인한다. HTTP 확인은 다음 명령으로 임시 loopback 서버의 실제 헤더 인증·도구 조회·인증 실패와 세션 종료를 확인한다.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests::check::http_check -- --ignored
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests::check_http -- --ignored
```

`McpsPage.test.tsx`는 명시적 확인과 화면 종료 취소·늦은 결과 무시, 원본 표시, 선택 항목만 가져오기, 충돌 시 명시적 덮어쓰기와 자동 활성화·재연결 금지를 검증한다.

네이티브 UI에서는 전역·프로젝트 대상 변경, 네이티브 파일 선택 및 취소, 붙여넣은 원본 검토 후 내용 지우기, 이름 변경·덮어쓰기, 가져오기 일부 실패 후 재시도, 확인 취소와 페이지 이동을 밝은·어두운 테마 및 키보드로 확인한다. 03번 구현 중 Mac이 잠겨 있어 네이티브 UI 검증은 수행하지 못했다.
