# 전역 사용자 설정

사용자 설정의 원본은 OS 홈 폴더 아래 `~/.atte/settings.json` 하나다. 일반 설정 화면과 파일 직접 편집은 같은 설정을 변경한다. DB, 에이전트 설치본, 첨부 등 기존 앱 데이터의 위치는 바뀌지 않는다.

```json
{
  "theme": "system",
  "locale": "system",
  "notifications": {
    "completion": true,
    "permission": true
  },
  "mcpServers": {}
}
```

- `theme`: `system`, `light`, `dark`. `system`은 OS 화면 모드 변경을 계속 따른다.
- `locale`: `system`, `en`, `ko`. `system`은 OS 언어 목록의 첫 지원 언어를 사용하고, 지원 언어가 없으면 영어로 표시한다. 실행 중 시스템 언어 변경도 반영한다.
- `notifications`: 응답 완료(`completion`), 승인 및 질문 요청(`permission`)의 OS 알림 허용 여부다. 누락한 항목은 활성으로 해석한다.
- `mcpServers`: 이름으로 구분한 전역 MCP 서버 설정이다. 아래 MCP 서버 관리 규칙을 따른다.

누락한 테마·언어는 `system`이다. 알려진 항목의 지원하지 않는 값과 JSON 문법 오류는 설정 오류다. 알 수 없는 필드와 알림 하위 필드, 기존 `mcpServers` 내용은 화면에서 다른 설정을 바꿔도 보존한다.

## 시작과 이전

Rust가 읽기·검증·변경·저장을 소유한다. WebView는 기존 `atte.theme`, `atte.locale` 값을 시작 시 한 번 전달하고 Rust의 초기 스냅샷을 기다린 뒤 본 화면을 구성한다. 선택한 테마와 언어를 첫 화면에 적용한다. 이후 변경 명령은 부분 변경과 성공·실패만 전달하고, 공개 설정은 순서가 보장된 구독으로 받는다.

새 파일에 명시된 값이 우선한다. 새 알림 값이 모두 있으면 이전 알림 파일을 읽지 않으므로 사용하지 않는 원본의 읽기 오류가 새 설정을 막지 않는다. 누락한 값만 기존 WebView 설정과 앱 데이터 폴더의 `notification-preferences.json`에서 가져오고 나머지는 기본값으로 채운다. 새 파일 저장에 성공한 뒤에만 이전 알림 파일과 WebView의 두 키를 정리한다. 실패하면 원본을 보존해 재시도하며, 이미 이전한 값을 다시 덮어쓰지 않는다. 완성된 설정 파일은 재시작만으로 다시 쓰지 않는다.

Tauri가 없는 브라우저 개발은 메모리 설정을 사용한다. 테스트는 `createMemorySettings`와 `SettingsProvider`로 값을 주입한다. 두 환경 모두 localStorage를 새 영구 저장소로 사용하지 않는다.

## 저장과 외부 편집

부분 변경은 한 잠금 아래 직렬화한다. 매번 최신 파일을 읽고 요청한 필드만 바꾼 뒤 같은 디렉터리의 임시 파일을 동기화하고 원자적으로 교체한다. 교체 직전에도 원본 bytes를 비교해 저장 준비 중 발견한 외부 변경은 충돌 오류로 돌려준다. 따라서 오래된 UI 스냅샷으로 다른 항목을 덮어쓰지 않는다. 외부 편집기는 앱의 잠금을 공유하지 않으므로 서로 정확히 동시에 같은 필드를 저장하면 마지막 교체가 우선한다.

첫 초기화 이후 500ms 간격으로 파일을 다시 읽어 외부 수정·교체·삭제와 오류 복구를 감지한다. 읽기와 검증만 수행하며 정상 파일을 주기적으로 다시 저장하지 않는다. 파일 삭제는 기본값으로 반영하고, 다음 화면 변경 시 파일을 다시 만든다.

문법·값·읽기 오류는 마지막 정상 설정과 함께 보관한다. 첫 읽기에 실패하면 기본값으로 화면을 열고 오류 안내를 표시한다. 오류 중에는 테마·언어·알림 저장을 막고 손상된 파일을 덮어쓰지 않는다. 화면 상단의 안내는 오류 상세와 재시도를 제공한다. 파일을 고치면 다음 감지 또는 재시도로 복구한다. 저장 실패도 마지막 정상 값을 유지하며 안내한다. 저장 오류는 파일 읽기가 성공했다는 이유만으로 해제하지 않고 화면의 명시적 재시도까지 유지한다. 다른 앱 기능과 진행 중인 대화는 유지한다.

구독을 다시 연결하면 이전 구독을 해제하고 오래된 구독의 스냅샷을 무시한다. 앱 명령은 신뢰된 `main` WebView에서만 허용하며 프런트엔드에 임의 파일 접근 권한을 추가하지 않는다.

참고: [VS Code 사용자 설정](https://code.visualstudio.com/docs/configure/settings), [tempfile 원자 교체](https://docs.rs/tempfile/latest/tempfile/struct.NamedTempFile.html#method.persist).

## MCP 서버 관리

앱 메뉴의 **MCPs**에서 전역 또는 사이드바에 표시된 프로젝트를 선택하고 서버를 검색·추가·상세 편집·삭제한다. 등록은 연결 성공을 뜻하지 않는다. 토글은 Atte가 전달할 목록만 제어하며 에이전트가 자체 설정에서 읽는 서버를 변경하지 않는다.

전역 서버는 `~/.atte/settings.json`의 `mcpServers`, 프로젝트 서버는 선택한 폴더의 `.atte/mcp.json`에 저장한다. 상위 폴더나 Git 루트를 탐색하지 않는다. 같은 이름은 프로젝트 항목 전체가 우선하며 비활성 프로젝트 항목은 같은 이름의 전역 서버도 제외한다. 관리 worktree 스레드는 원본 폴더의 설정을 사용하고 도구의 실제 작업 위치는 스레드의 작업 폴더다. 설정 변경은 새 대화·재연결부터 적용된다. 열린 스레드의 Thread Info에는 Context 아래 MCP 섹션에서 현재 연결의 활성 서버 이름과 문제 사유를 표시한다. 서버가 없으면 `없음`, 연결 정보 미수신 시 `정보 없음`을 표시하며 목록은 최대 5행 이후 내부 스크롤한다. 문제 사유는 이름 오른쪽 원형 느낌표의 hover·키보드 포커스 툴팁으로 확인한다. MCP 제목 오른쪽 화살표로 MCPs 페이지를 열어 서버를 관리한다. 이 박스에는 설정 변경 안내나 재연결 버튼을 표시하지 않는다. 설정 변경은 실행 중인 작업을 중단하거나 공유 에이전트 프로세스를 종료하지 않는다.

```json
{
  "mcpServers": {
    "local-tools": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "your-mcp-server"],
      "env": {
        "API_KEY": { "kind": "environment", "value": "EXISTING_API_KEY" }
      }
    },
    "remote-tools": {
      "type": "http",
      "enabled": false,
      "url": "https://example.com/mcp",
      "headers": {
        "X-Workspace": { "kind": "literal", "value": "example" }
      }
    }
  }
}
```

`enabled`를 생략하면 활성이다. 명령어와 인자 배열은 별개로 전달하며 셸 문자열로 합치지 않는다. 명령어는 에이전트 실행 환경의 PATH 또는 작업 폴더를 기준으로 실행 가능한 절대 경로로 해석한다. 헤더 인증·인증 없는 Streamable HTTP는 에이전트가 ACP HTTP MCP 지원을 광고할 때 전달한다. OAuth 서버는 아래 인증 중계 규칙을 따른다.

환경변수·헤더의 값 유형은 일반값(`literal`), 기존 환경변수 참조(`environment`), OS 자격 증명 참조(`secret`)다. Bearer 인증은 `Authorization` 헤더를 비밀값으로 선택하고 `Bearer …`를 입력한다. 사용자 지정 인증 헤더도 동일하게 설정한다. 비밀값은 macOS Keychain 또는 Windows 자격 증명 저장소에 저장하며 JSON과 조회 응답에는 불투명 참조만 남긴다. 편집 폼의 기존 비밀값 입력을 건드리지 않으면 유지하고, 새 값을 입력하면 교체하며, 행을 삭제하면 자격 증명도 삭제한다. 참조의 자격 증명 주소에는 설정 파일의 범위·서버 이름을 함께 사용하므로 같은 이름의 프로젝트 서버끼리 공유하지 않는다. 자격 증명 저장소 오류는 평문 파일 저장으로 대체하지 않는다.

ACP `session/new`, `session/load`, `session/resume`에 활성 서버를 전달한다. MCP를 전달한 세션 설정의 실패는 에이전트가 자격 증명을 오류에 되돌려 보낼 수 있으므로 코드와 안전한 일반 안내만 표시하고 원본 메시지·data는 공개하지 않는다. 누락되거나 빈 자격 증명·환경변수, 실행할 수 없는 명령어, HTTP 미지원, 지원하지 않는 서버 설정은 서버별 이유와 함께 제외하고 나머지를 계속 전달한다. 이유는 스레드 화면에 표시한다. 파일을 읽거나 JSON을 해석할 수 없으면 마지막 정상 등록 목록과 오류를 유지하고 해당 파일의 저장·영향받는 새 MCP 세션 설정을 막는다. 표시된 파일을 수정하면 구독과 감지 주기에 따라 복구한다.

카탈로그는 제공하지 않는다. 가져오기와 독립 연결 확인은 아래 절차를 따른다.

참고: [Zed의 로컬·원격 MCP 관리와 외부 에이전트 구분](https://zed.dev/docs/ai/mcp), [ACP v1 세션 설정](https://agentclientprotocol.com/protocol/v1/session-setup), [keyring 네이티브 자격 증명 저장소](https://docs.rs/keyring/3.6.3/keyring/).

검증 절차와 네이티브 확인 범위는 [MCP 설정 검증](../testing/mcp-settings.md)을 따른다.

## 기존 MCP 가져오기와 연결 확인

MCPs의 **서버 가져오기**에서 **전역 설정 탐색**을 실행하면 Claude Code (`~/.claude.json`), Claude Desktop (macOS의 `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows의 앱 설정 디렉터리 `Claude/claude_desktop_config.json`), Cursor (`~/.cursor/mcp.json`), Codex (`$CODEX_HOME/config.toml`, 기본 `~/.codex/config.toml`), Zed (macOS의 `~/.config/zed/settings.json`, 다른 OS의 설정 디렉터리 `zed/settings.json`)를 읽는다. 프로젝트 설정이나 OAuth 자격 증명 파일은 탐색하지 않는다. 원본 도구·경로·읽기 오류와 서버별 지원 여부를 표시하며, 한 원본의 오류가 다른 원본을 막지 않는다. 탐색은 등록이나 실행을 수행하지 않는다.

일반 `mcpServers` JSON/JSONC 붙여넣기, 네이티브 파일 선택, Codex TOML 및 Zed `context_servers` JSONC를 지원한다. JSONC는 주석과 마지막 쉼표를 허용하는 검증된 파서로 해석한다. 파일은 UTF-8, 최대 1 MiB다. 검토 응답은 서버 이름·전송 방식·불투명 선택 ID만 포함하고 실제 설정과 비밀값은 Rust 메모리에 유지한다. 검토를 닫으면 이를 폐기하고 15분이 지난 선택은 거절한다.

대상 전역·프로젝트와 가져올 서버를 고른다. 충돌은 대상 이름을 바꾸거나 **명시적으로 덮어쓰기**를 선택해야 한다. 저장 시에도 충돌을 검사한다. 서버마다 성공·실패를 처리하여 일부 오류로 성공한 항목을 되돌리지 않는다. 가져온 서버는 항상 비활성이다. 환경변수·헤더의 평문값은 일반값인지 비밀값인지 추측하지 않고 모두 OS 자격 증명 저장소에 보관한다. 원본 파일은 변경하지 않으며 원본과 대상이 같은 파일이면 거절한다.

stdio의 `command`, 문자열 배열 `args`, `env`, HTTP의 `url`, `headers` (Codex는 `http_headers`)를 변환한다. 값 전체가 `${NAME}` 또는 `${env:NAME}`이면 환경변수 참조로 보존한다. Codex의 `env_vars`와 `env_http_headers`도 참조로 변환한다. 인자의 자격 증명·인증 헤더 옵션, 환경변수 대입, 인증·query가 포함된 URL은 보수적으로 거절하고 비밀 환경변수·헤더를 사용한 수동 설정을 안내한다. 지원하지 않는 전송, 명령어·인자·URL의 변수 확장, 복합 변수식·기본값, URL query, 별도 작업 위치, OAuth 설정, 동적 헤더 helper, 도구 허용 정책 등 알 수 없는 서버 옵션이 있으면 해당 항목 전체를 거절하고 수동 등록을 안내한다. 예를 들어 `bearer_token_env_var`는 접두사가 필요한 참조이므로 현재 자동 변환하지 않는다. 호환되지 않는 옵션을 누락한 채 가져오지 않는다.

등록 서버의 **연결 확인**은 활성 여부와 무관하게 별도의 stdio 프로세스 또는 Streamable HTTP 세션으로 MCP initialize와 도구 목록 조회를 수행한다. 전역 서버는 홈 폴더, 프로젝트 서버는 선택한 폴더를 작업 위치로 사용하고 앱 프로세스의 환경변수를 해석한다. 도구를 호출하지 않는다. 결과는 연결됨·도구 없음·인증 필요·네트워크 오류·실행 실패·시간 초과·취소·설정 오류·프로토콜 오류를 구분하고 다음 행동을 안내한다. 통신 확인 제한은 20초이고 종료 정리는 별도의 제한 시간 안에서 기다리며 화면을 떠나거나 취소하면 확인 연결을 정리한다. stdio 자식과 프로세스 그룹은 종료·회수하고, HTTP 세션은 SDK의 종료 경로로 정리한다. HTTP는 리디렉션을 따라 인증 헤더를 다른 대상으로 보내지 않는다. 응답 본문·프로세스 stderr·원본 오류는 공개하지 않는다. 기존 대화 연결을 사용하거나 종료하지 않으며 서버 활성화와 대화 재연결은 별도 동작이다.

형식 근거: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude Desktop 설정](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Cursor MCP](https://cursor.com/docs/context/mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Zed MCP](https://zed.dev/docs/ai/mcp). 연결과 세션 종료는 [공식 Rust MCP SDK](https://docs.rs/rmcp/3.9.0/rmcp/)를 사용한다.

## MCP OAuth 로그인과 ACP 인증 중계

HTTP 서버의 인증을 **OAuth**로 선택하고 저장한 뒤 MCPs 카드에서 **로그인**한다. 시스템 브라우저에서 인증하고 Atte로 돌아온다. 카드는 인증 필요·로그인 중·인증 완료·재인증 필요 상태와 로그인 취소·로그아웃을 제공한다. 인증 완료는 MCP 도구 연결 확인 결과와 별개다. 사전 등록된 공개 native 클라이언트 ID를 입력하거나 비워 두어 동적 클라이언트 등록을 사용한다. 사전 등록 클라이언트는 `http://127.0.0.1:<동적 포트>/callback`을 허용해야 한다. 클라이언트 secret을 사용하는 confidential 클라이언트는 지원하지 않는다.

```json
{
  "mcpServers": {
    "remote-oauth": {
      "type": "http",
      "url": "https://example.com/mcp",
      "oauth": {},
      "headers": {}
    }
  }
}
```

사전 등록은 `"oauth": { "clientId": "your-public-client-id" }`로 설정한다. OAuth와 정적 Authorization 헤더는 함께 사용할 수 없다. 다른 사용자 지정 헤더와 비밀값 참조는 유지한다. OAuth 전송은 HTTPS 또는 loopback HTTP만 허용하며 리디렉션에 토큰을 전달하지 않는다.

공식 Rust MCP SDK가 서버 메타데이터 탐색, Authorization Code와 S256 PKCE, callback state·issuer 검증, 만료 확인과 refresh token 회전을 수행한다. Atte는 인증 세션을 범위·서버 이름·정확한 서버 URL·클라이언트 설정에 묶어 OS 자격 증명 저장소에만 저장한다. 재시작 후에는 현재 issuer를 확인하고 복원한다. 같은 인증의 토큰 복원·갱신·저장·로그아웃을 직렬화하며 저장소 실패 시 평문 저장으로 대체하지 않는다. 갱신 거절이나 권한 변경은 재인증을 안내한다. 로그인은 5분 후 시간 초과하고 callback listener는 성공·실패·취소 시 닫는다.

ACP new/load/resume은 연결마다 임시 Bearer 자격 증명으로 보호된 `127.0.0.1` 중계를 받는다. 상위 OAuth 토큰은 에이전트에 전달하지 않는다. HTTP 지원 에이전트는 중계 URL을, 미지원 에이전트는 같은 Atte 실행 파일의 `--mcp-stdio-bridge` 진입점을 사용한다. 이 진입점은 Tauri를 시작하지 않고 stdio MCP와 Streamable HTTP를 연결한다. 중계는 요청·응답·알림·취소·SSE 스트림을 전달하고 각 연결은 별도 MCP 세션을 유지한다. 독립 연결 확인도 별도 중계를 사용한다.

로그인·로그아웃은 해당 서버를 사용하는 열린 스레드에 재연결 안내를 제공한다. 정상 토큰 갱신은 중계 내부에서 처리하고 재연결을 요구하지 않는다. 중계는 자신이 발급받은 MCP session ID만 받아 다른 연결의 세션 ID 혼용을 거절한다.

로그아웃하면 저장 자격 증명을 삭제하고 해당 인증의 열린 중계 접근과 스트림을 무효화한다. 저장소 삭제에 실패해도 현재 실행의 접근은 차단하며 재인증 상태에서 저장소를 잠금 해제한 뒤 로그아웃을 재시도할 수 있다. 설정 파일이 손상되어도 마지막 등록 목록의 인증 상태와 로그아웃을 유지한다. 일반 설정 편집·토글은 기존과 같이 다음 연결에 적용한다. 연결 종료 시 listener와 임시 자격 증명을 폐기하고 알려진 상위 MCP 세션에 제한 시간 내 DELETE를 시도한다. 다른 스레드나 공유 에이전트 프로세스는 종료하지 않는다.

프로토콜 근거: [Rust MCP SDK OAuth](https://github.com/modelcontextprotocol/rust-sdk/blob/main/docs/OAUTH_SUPPORT.md), [Zed OAuth 구현](https://github.com/zed-industries/zed/blob/main/crates/context_server/src/oauth.rs). 외부 ACP 전달과 앱 자체 OAuth를 구분하고 Atte가 공통 인증을 소유한다.
