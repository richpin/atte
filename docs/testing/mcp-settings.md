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

## OAuth와 ACP 인증 중계

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests::oauth -- --ignored
cargo run --manifest-path src-tauri/Cargo.toml --example mcp-oauth-fixture
```

OAuth suite는 실제 loopback OAuth·MCP 서버와 메모리 자격 증명 저장소를 사용한다. SDK가 생성한 S256 PKCE를 서버에서 검증하고 동적·사전 등록, callback state·issuer 오류, 취소, 키체인 정리 실패, 재시작 복원, 동시 refresh와 회전 저장, refresh 거절, 범위·URL·issuer 격리, 로그아웃을 확인한다. URL 편집 뒤에도 기존 연결이 로그아웃으로 무효화되어야 한다. 알림·취소·열린 SSE 전달과 로그아웃에 따른 스트림 종료도 확인한다.

같은 suite에서 실제 Atte 실행 파일을 빌드하여 `--mcp-stdio-bridge`로 실행한다. stdin을 유지한 채 연결을 종료해도 브리지가 제한 시간 안에 종료되는지 확인한다. ACP fixture는 세션별 MCP 설정을 유지하고 HTTP 지원 여부 두 경우 모두 new/load/resume 뒤 실제 도구를 호출한다. 한 스레드를 재연결한 뒤 다른 스레드에서도 도구를 호출하여 공유 에이전트 프로세스와 연결 격리를 확인한다. 테스트용 실행 파일 경로만 실제 빌드 산출물로 주입하며 제품은 Tauri를 실행한 앱 경로를 사용한다.

예제는 URL 한 줄만 출력하고 합성 인증 정보만 발급하는 수동 UI 검증용 서버다. MCPs에서 출력된 URL과 OAuth를 등록하면 시스템 브라우저가 로컬 callback으로 돌아온다. 종료 시 프로세스를 중단하고, 앱에서 로그아웃한 뒤 테스트용 등록을 삭제한다. 실제 계정·외부 OAuth 서비스·사용자 API 키는 사용하지 않는다.

04번 구현 중 macOS debug 번들에서 등록, 시스템 브라우저 로그인, 키체인 저장, 앱 종료·재시작 후 인증 복원, 복원된 인증으로 도구 목록 조회, 로그아웃과 이후 접근 거절을 확인했다. 밝은 테마의 OAuth 카드와 키보드 로그인, 어두운 테마 전환을 확인했다. 네이티브 자동화의 팝업 조작이 불안정하여 OAuth 카드 자체의 어두운 테마 시각 확인은 남아 있다. 테스트용 서버를 제거하고 원래 테마를 복원했다.
