# macOS 직접 배포 및 앱 업데이트

`pnpm release:macos`는 Apple Silicon(ARM64)용 앱과 DMG를 Developer ID로 서명한다. DMG를 Apple Notary Service에 제출하고 ticket과 Gatekeeper를 검증한다. 동일한 notarization에 포함된 앱에도 ticket을 붙이고 검증한 다음, 최종 앱으로 updater archive와 Tauri 서명, `latest.json`을 생성한다. Mac App Store 제출과는 별개다.

## 최초 설정

1. `.env.release.example`을 참고해 `.env.release.local`을 만든다. 이 파일은 Git에서 제외된다. `APPLE_SIGNING_IDENTITY`는 Keychain Access의 Developer ID Application 인증서 이름이고, `APPLE_TEAM_ID`는 팀 ID다. `ATTE_NOTARY_PROFILE`은 `xcrun notarytool store-credentials`로 미리 Keychain에 저장한 profile 이름이다. Apple app-specific password는 환경 변수 파일에 넣지 않는다.
2. `rustup target add aarch64-apple-darwin`으로 ARM64 빌드 타깃을 설치한다.
3. `pnpm tauri signer generate -w ~/.tauri/atte.key`로 updater 키 쌍을 한 번 생성한다. `.env.release.local`의 `TAURI_SIGNING_PRIVATE_KEY`에 개인키의 절대 경로, `ATTE_UPDATER_PUBLIC_KEY_PATH`에 `.pub` 파일의 절대 경로를 넣는다. 비밀번호를 설정했다면 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`도 지정한다. 개인키와 비밀번호는 저장소에 넣지 않고 별도로 백업한다. 이미 배포한 앱은 기존 공개키를 신뢰하므로 이후 릴리스에도 같은 키 쌍을 사용한다.
4. GitHub `richpin/atte`의 Release와 asset에 사용자가 인증 없이 접근할 수 있어야 한다. 비공개 소스 저장소를 유지하려면 공개 배포 저장소를 별도로 정하고, updater endpoint와 릴리스 스크립트의 asset URL을 함께 변경한다. 앱에 GitHub 개인 토큰을 넣지 않는다.

## 릴리스

1. `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`의 버전을 같은 안정 SemVer로 맞추고 Cargo lock 파일도 갱신한다. 예: `0.1.0`. 이 명령은 stable 배포용이며 prerelease 버전은 거부한다.
2. 프로젝트 루트에서 `pnpm release:macos`를 실행한다. 배포 명령은 공개키를 Tauri 설정에 주입한다. 일반 개발 빌드에는 키와 updater artifact가 필요하지 않다.
3. 모든 검증이 성공하면 `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`에서 이번 실행이 출력한 DMG, `atte_<version>_aarch64.app.tar.gz`, 그 `.sig`, `latest.json`을 가져온다.
4. `v<version>` 태그의 GitHub Release를 draft로 만들고 네 파일을 모두 업로드한다. 태그는 빌드한 코드와 일치해야 한다. 같은 버전의 파일을 나중에 덮어쓰지 않는다. 최초 릴리스 이후에도 모든 stable Release에는 `latest.json`과 updater 파일을 포함한다.
5. asset이 모두 준비되면 Release를 공개하고 latest로 지정한다. `latest.json`에는 `darwin-aarch64` 항목만 포함된다. 다운로드 URL은 정확한 버전 태그에 고정된다. 변경 내용은 GitHub Release 본문에 작성하고, 앱에서도 표시하려면 게시 전 `latest.json`에 선택 필드 `notes`를 넣는다.

## 앱의 동작

서명 공개키가 주입된 macOS 배포 빌드에서는 시작 시 한 번 새 버전을 확인한다. 일반 설정에서도 수동으로 확인할 수 있다. 새 버전이 있으면 오른쪽 하단에 닫을 수 있는 알림을 표시하고, 일반 설정의 `업데이트 확인` 버튼을 `다운로드 및 설치`로 바꾼다. 알림을 닫으면 이번 실행에서는 다시 표시하지 않는다. 사용자가 다운로드 및 설치를 선택해야 적용하며, 다운로드 진행률과 실패·재시도 상태를 표시한다. Tauri가 HTTPS와 artifact 서명을 검증하고, 서명에 기록된 버전도 manifest와 비교한다. 최초 updater 포함 버전 이전의 설치본은 한 번 수동으로 설치해야 한다.

설치 후 즉시 재시작하지 않는다. 사용자가 `Atte 재시작`을 선택하거나 나중에 직접 재실행하면 새 버전을 사용한다. 재시작은 기존 수정 파일 확인과 에이전트 종료·정리를 거친다. 수정 파일 확인에서 취소하면 앱은 계속 실행된다. 실행 중인 에이전트 작업은 재시작 시 종료되므로 완료 후 재시작한다. 앱 업데이트와 Registry 에이전트 업데이트는 별개다.

앱은 DMG에서 Applications로 복사한 뒤 실행한다. 읽기 전용 DMG 위에서는 앱을 교체할 수 없다. 네트워크 오류나 잘못된 manifest는 업데이트 실패로 표시되며 앱 사용을 막지 않는다. 개발 빌드와 공개키 없는 로컬 빌드에서는 업데이트가 비활성화된다.

## 실제 배포 검증

키·Apple 인증서가 준비된 후 두 버전을 빌드해 검증한다. 버전 N을 Apple Silicon Mac의 Applications에 설치하고 N+1 Release를 공개한 뒤 자동 확인, 수동 확인, 다운로드·설치, 재시작 후 버전 표시를 확인한다. 수정 파일 확인 취소, 실행 중인 작업의 종료·정리, 네트워크 실패 후 재시도, 손상된 updater 서명 거부도 확인한다. DMG뿐 아니라 updater로 설치한 앱의 Gatekeeper 실행도 확인한다.

참고: [Tauri updater](https://v2.tauri.app/plugin/updater/), [Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), [GitHub Release 링크](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).
