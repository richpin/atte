# Open in 메뉴와 앱 아이콘

Status: completed

스레드 헤더에 OS가 조회한 앱과 실제 아이콘을 표시하는 Open in 서브메뉴를 추가한다. 상세 동작은 ../spec.md를 따른다.

## Acceptance criteria

- Reconnect 뒤에 Open in이 표시되고 OS가 해당 작업 폴더를 열 수 있다고 반환한 앱을 선택할 수 있다.
- 각 앱 아이콘은 16px 크기로 원래 색상을 유지한다.
- 목록 로딩, 재시도, 아이콘 fallback과 키보드 선택을 지원한다.
- 현재 스레드의 작업 폴더를 Rust가 조회하며 임의 실행 명령을 받지 않는다.
- 없는 폴더·앱 연결·스레드와 실행 실패를 사용자에게 안내한다.

## Comments

2026-10-14: 구현 완료. 프런트엔드 테스트에서 목록과 순서, 현재 스레드 전달, 재시도·재조회, 아이콘 fallback, 키보드 선택과 플랫폼 제한을 확인했다. Rust 테스트에서 지원 앱 매핑, 잘못된 앱 ID, 없는 스레드·폴더 및 공백·한글 경로를 확인했다. macOS 네이티브 이벤트 루프에서 실제 Finder와 Zed의 32×32 PNG 아이콘 추출과 테스트 폴더 열기를 확인했다. 이 환경에는 VS Code와 Cursor가 설치되지 않아 실제 실행은 검증하지 않았다. 실제 아이콘을 사용한 브라우저 미리보기로 라이트·다크 테마를 확인했으며 부모 메뉴의 overflow로 서브메뉴가 잘리는 문제를 Portal 렌더링으로 해결했다.

검증 완료: pnpm validate(28개 파일, 262개 테스트), pnpm build, cargo test --locked --offline, cargo clippy --all-targets --all-features --locked --offline -- -D warnings, git diff --check 통과.

2026-10-15: 사용자가 고정 지원 앱 목록 대신 OS 기반 검색을 요청해 명세와 구현을 변경했다. NSWorkspace.URLsForApplicationsToOpenURL로 프로젝트 문서와 폴더의 앱 연결을 조회한다. 루트 .xcworkspace를 .xcodeproj보다 우선하며, 프로젝트가 여러 개면 파일명을 표시해 구분한다. 스레드별 조회, 빈 목록 안내 및 실행 직전 앱·문서 조합 검증을 추가했다. 네이티브 테스트에서 고정 등록 없이 Xcode가 검색되고 해당 .xcworkspace에 대한 실행 요청이 성공했으며 임의 앱 경로는 거부됐다. Xcode 내부 화면은 초기 External Agent Access 권한 설정 대화상자가 표시돼 확인하지 않았으며 해당 설정은 변경하지 않았다.

최종 검증: pnpm validate(28개 파일, 264개 테스트), pnpm build, cargo clippy --all-targets --all-features --locked --offline -- -D warnings 통과. cargo test의 기존 ACP 세션 제목 테스트가 첫 전체 실행에서 시간 초과했으나, --test-threads=4로 전체를 다시 실행해 통과했다(기존 무시 테스트 5개). macOS 12 이전에는 새 NSWorkspace selector를 호출하지 않고 조회 오류로 처리한다.


2026-10-15: 사용자 요청으로 프로젝트 파일 탐색과 우선순위, 앱 목록 병합, 프로젝트 파일명 표시를 모두 제거했다. 스레드의 작업 폴더 하나에 대해 OS가 반환한 앱 목록과 순서를 그대로 사용하고 선택한 앱에 해당 작업 폴더 자체를 전달한다. 실행 직전 OS 조회 결과에 포함된 앱인지 재검증하는 동작과 아이콘 표시는 유지한다.

단순화 검증: 관련 Rust 테스트 7개와 프런트엔드 테스트 7개, 전체 타깃 Clippy를 통과했다. 실제 macOS 이벤트 루프에서 같은 작업 폴더에 .xcworkspace와 .xcodeproj를 추가하기 전후 앱 목록·순서·이름·아이콘이 동일함을 확인했으며, OS가 반환하지 않은 앱은 거부됐다. 검증용 임시 프로그램은 삭제했다.

전체 프런트엔드 검증 pnpm validate(264개 테스트)와 nightly Rust 포맷 검사도 통과했다.


2026-10-15: ‘다른 앱…’을 추가했다. OS 조회 상태와 무관하게 네이티브 앱 선택 창에서 .app 하나를 선택해 원래 스레드의 작업 폴더를 열 수 있다. 취소는 정상 종료로 처리하며 선택 앱은 저장하지 않는다. 앱 경로는 Rust에서만 획득하고 APPL 번들 및 실행 파일을 검사한다. 관련 프런트엔드 테스트 10개와 Rust 테스트 10개를 통과했고, 실제 네이티브 선택 창에서 취소·Xcode 선택 후 열기 흐름을 확인했다. 임시 테스트 프로그램은 삭제했다.

최종 검증: pnpm validate(267개 테스트), pnpm build, nightly fmt 검사, 전체 타깃 Clippy 통과. Rust 전체 테스트는 기존 ACP 세션 제목 테스트의 시간 초과로 한 번 실패했으나 단독 재실행 및 --test-threads=1 전체 재실행에서 통과했다(기존 무시 테스트 5개).

최종 디자인: 사용자 요청대로 구분선을 제거하고 ‘다른 앱…’을 일반 앱 항목 바로 뒤에 배치했다.
