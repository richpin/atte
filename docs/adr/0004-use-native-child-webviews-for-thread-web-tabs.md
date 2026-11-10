# 스레드 웹 탭은 네이티브 자식 웹뷰를 사용한다

일반 사이트는 iframe 임베딩을 제한할 수 있고 별도 브라우저 엔진은 앱 크기와 유지보수 비용을 늘린다. 스레드의 웹 탭은 Tauri 자식 웹뷰를 사용하며 macOS에서는 WKWebView로 구현한다. 자식 웹뷰를 위해 Tauri `unstable` 기능을 사용한다.

앱 capability와 명령 호출은 신뢰된 `main` 웹뷰로 제한한다. Rust는 웹 탭의 최초 주소·이동·팝업을 검사하고, 원격 페이지에는 앱 명령 권한을 주지 않는다. 프런트엔드는 탭과 웹뷰 수명을 관리하고 표시되지 않은 웹뷰를 숨긴다. 네이티브 웹뷰와 HTML의 겹침, 탐색 상태 조회는 [웹 탭 코드](../../src-tauri/src/browser.rs)와 [프로젝트 패널](../../src/widgets/thread-panel/ui/ThreadPanel.tsx)에서 다룬다.

웹·Files·Git 탭의 사용자 동작은 각각 해당 구현과 [Files 문서](../features/files.md), [Git 문서](../features/git-history.md)를 따른다.

macOS 탭 단축키는 네이티브 앱 메뉴에서 받아 `main` 웹뷰로 전달한다. 따라서 웹 탭의 자식 웹뷰에 포커스가 있어도 ⌘T/⌘W, Control+Tab, ⇧⌘[/], ⌘1–9가 프로젝트 패널 탭에 적용된다. ⌘W는 열린 탭이 없으면 스레드 화면에서 새 스레드 화면으로 이동하고, 그 밖의 화면에서는 창을 닫는다. 원격 웹뷰에는 앱 명령 권한을 부여하지 않는다.
