# Windows 핵심 작업 흐름

첫 대상은 Windows 11 x64 네이티브 앱·에이전트·작업 폴더다. WSL 연결은 제공하지 않는다. macOS에서 교차 컴파일할 수 있지만 Windows 실행 검증은 별도로 필요하다. 설치 파일 생성은 [로컬 빌드](windows-build.md)를 따른다.

## 플랫폼 통합

- Claude·Codex를 포함해 Registry의 Windows 바이너리와 npm 배포를 사용한다. ACP 에이전트 인증과 terminal 인증을 제공하며, terminal 인증은 에이전트 실행 파일에 인증 인수와 환경 변수를 직접 전달해 새 Windows 콘솔에서 실행한다. 셸 문자열이나 `.cmd` 보간은 사용하지 않는다. 콘솔과 자손은 기존 suspended-spawn/kill-on-close Job Object에 속하며 인증 취소·시간 초과·앱 종료 시 정리된다. 콘솔을 직접 닫거나 명령이 실패하면 인증 오류를 반환한다.
- 대화·재개·중지·승인·질문, 에이전트 업데이트의 불변 설치본·drain·승격과 DB 복원은 공통 구현을 사용한다. 재실행 시 관리 Node 런타임 경로는 Windows의 `;` 구분자로 복원한다. DB는 기존 schema v1을 유지한다.
- 작업 폴더·worktree, Git, 파일 멘션·첨부와 Files는 공통 명령을 사용한다. Git for Windows가 설치되어 PATH에서 실행 가능해야 한다. Windows UTF-8 Git 경로와 링크·junction 보호는 Rust 경계에서 처리한다. worktree의 Git 루트는 canonical 경로로 비교하고, 이미 사라진 checkout의 등록 확인은 Windows verbatim 접두사와 경로 구분자를 정리한 경로로 비교한다. 에이전트 실행에는 Windows 경로를 전달하고 파일 참조에는 file URL을 사용한다.
- 웹 탭은 Tauri 자식 WebView2다. 뒤로·앞으로 이동, URL·제목·history 상태를 COM API로 조회하고 loading은 NavigationStarting/NavigationCompleted의 navigation ID로 갱신해 이전 탐색 취소가 새 탐색을 완료 처리하지 않게 한다. favicon 조회는 기존 제한된 평가 경로를 사용한다. 탭 표시·숨김·크기·포커스·종료는 기존 프런트엔드 수명 관리를 공유한다. 최초 URL·탐색·팝업 검증을 유지하고 다운로드를 차단하며 원격 웹뷰에는 앱 capability나 명령 권한을 부여하지 않는다.
- 네이티브 메뉴와 WebView2 컨트롤러의 AcceleratorKeyPressed에서 Ctrl+T/W, Ctrl+Shift+W, Ctrl+Tab/Shift+Tab, Ctrl+1–9를 전달한다. 웹 탭에 키보드 포커스가 있어도 동일한 Rust 동작 전달 경로를 사용한다. Windows 메뉴는 자식 HWND 입력을 먼저 소비하지 않도록 HACCEL을 등록하지 않으며, 기본 편집 키는 WebView2가 처리한다. Ctrl+W는 열린 탭, 스레드 화면, 창 순서로 닫는다. Ctrl+S는 파일 저장, Ctrl+F는 기존 검색을 사용한다. macOS의 Command 키 동작은 유지한다.
- 작업 폴더의 Open in 메뉴는 File Explorer와 Other…를 제공한다. Other…는 네이티브 파일 선택기로 `.exe`를 선택하고 작업 폴더를 하나의 인수로 전달한다. 임의 실행 파일 경로를 프런트엔드 명령 인수로 받지 않는다. 폴더 인수를 지원하는 편집기를 선택해야 한다. Shell용 폴더 경로는 `dunce`로 안전하게 표현 가능한 verbatim 접두사를 정리한다.
- Windows 창 닫기와 Alt+F4는 미저장 파일 확인, 진행 중 설치 완료, 인증 취소, 에이전트 프로세스 정리를 거쳐 종료한다. 저장된 스레드와 worktree는 종료 시 삭제하지 않는다. Windows 네이티브 알림과 작업 표시줄 표시는 [알림 문서](notifications.md)를 따른다.

## 실제 Windows 점검표 — 미실행

각 항목에 Windows 버전, 설치 파일 SHA-256, 에이전트 버전, 결과와 재현 절차를 기록한다. 이 표는 아직 실행하지 않은 검증이다. 교차 빌드 성공을 결과로 대체하지 않는다.

| 영역 | 실제 설치본에서 확인할 항목 |
| --- | --- |
| 설치·시작 | 미서명 Setup.exe 설치, Start Menu 실행, WebView2 초기화, 밝은/어두운 테마, 창 조작 |
| 필수 에이전트 | Claude와 Codex 각각 설치, 브라우저/콘솔 로그인, 취소·콘솔 닫기, 대화, 승인·질문 응답, 중지, 재개 |
| 수명·업데이트 | 로그인 중 취소·앱 종료, 응답 중 종료, 자손 프로세스 잔류 없음, 진행 중 turn 이후 에이전트 업데이트와 재실행 |
| 경로·파일 | 공백·한글·괄호·`&`가 있는 경로, 작업 폴더 선택, worktree 생성·공유·마지막 스레드 삭제, 파일 첨부·이미지·파일 멘션 |
| Files·Git | 파일 생성·편집·Ctrl+S·이동·휴지통, junction 거부, 외부 변경 충돌, 미저장 파일이 있는 상태에서 창 닫기·취소·저장, Git 변경 조회·stage·commit·restore·stash |
| 웹 탭 | HTTPS/로컬 개발 서버, redirect, title/favicon/loading, 뒤로/앞으로, 실패 탐색, popup→새 탭, 숨김·표시·포커스·스레드 전환·닫기 |
| 권한 경계 | 웹 탭에서 Atte 명령 호출 거부, 앱 origin·file:·javascript: 탐색/팝업 거부, 원격 다운로드 차단 |
| 단축키 | 메인 UI와 웹 페이지 입력란 각각 Ctrl+T/W, Ctrl+Tab/Shift+Tab, Ctrl+1–9, Ctrl+Shift+W, Alt+F4; Ctrl+F와 Ctrl+S |
| 알림 | 완료·승인·질문, 배너/알림 센터 클릭, 최소화 복원·스레드 이동, WebView2 포커스 유지, 시스템 차단·집중 모드, 확인·삭제·종료 후 제거 |
| 외부 앱 | File Explorer, `.exe` 편집기 선택·취소, 공백·한글 폴더를 단일 인수로 열기, 삭제된 폴더 오류 |
| 복원 | 앱 완전 종료 후 스레드 목록·메시지·첨부·worktree 복원, 두 에이전트의 기존 스레드 재개, 관리 Node를 사용하는 설치본 재실행 |

실행 ID별 절차·결과 양식과 두 버전 업데이트·코드 서명 판정은 [Windows 미리보기 검증](windows-validation.md)을 따른다. 실제 실행과 서명 준비는 대기 중이다. 정식 Windows 지원은 아직 선언하지 않는다.

## 구현 참고

[Microsoft WebView2 API](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis), [Tauri NSIS 설치 템플릿](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi), [Tauri Windows 알림의 설치 조건](https://v2.tauri.app/plugin/notification/), [VS Code Windows 키보드 관례](https://code.visualstudio.com/shortcuts/keyboard-shortcuts-windows.pdf)를 확인하고 기존 Tauri·Windows API를 사용했다.
