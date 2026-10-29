# 스레드 웹 탭은 네이티브 자식 웹뷰를 사용한다

일반 사이트는 iframe 임베딩을 제한할 수 있고 별도 브라우저 엔진은 앱 크기와 유지보수 비용을 늘린다. 스레드의 웹 탭은 Tauri 자식 웹뷰를 사용하며 macOS에서는 WKWebView로 구현한다. 자식 웹뷰를 위해 Tauri `unstable` 기능을 사용한다.

앱 capability와 명령 호출은 신뢰된 `main` 웹뷰로 제한한다. Rust는 웹 탭의 최초 주소·이동·팝업을 검사하고, 원격 페이지에는 앱 명령 권한을 주지 않는다. 프런트엔드는 탭과 웹뷰 수명을 관리하고 표시되지 않은 웹뷰를 숨긴다. 네이티브 웹뷰와 HTML의 겹침, 탐색 상태 조회는 [웹 탭 코드](../../src-tauri/src/browser.rs)와 [프로젝트 패널](../../src/widgets/thread-panel/ui/ThreadPanel.tsx)에서 다룬다.

웹·Files·Git 탭의 사용자 동작은 각각 해당 구현과 [Files 문서](../files.md), [Git 문서](../git-history.md)를 따른다.
