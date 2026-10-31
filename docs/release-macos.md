# macOS 직접 배포

`pnpm release:macos`는 Developer ID로 앱과 DMG를 서명하고, Apple Notary Service에 DMG를 제출한 뒤 ticket을 첨부하고 Gatekeeper로 검증한다. Mac App Store 제출과는 별개다.

최초 한 번 `.env.release.example`을 참고해 `.env.release.local`을 만든다. 이 파일은 Git에서 제외된다. `APPLE_SIGNING_IDENTITY`는 Keychain Access의 Developer ID Application 인증서 이름이고, `APPLE_TEAM_ID`는 팀 ID다. `ATTE_NOTARY_PROFILE`은 `xcrun notarytool store-credentials`로 미리 Keychain에 저장한 profile 이름이다. App-specific password는 환경 변수 파일에 넣지 않는다.

배포할 코드가 확정되면 프로젝트 루트에서 `pnpm release:macos`를 실행한다. `Accepted` 이후 ticket과 Gatekeeper 검증까지 성공해야 출력된 DMG를 전달한다. 새로 빌드한 DMG는 이전 notarization ticket을 재사용할 수 없다. 일반 `pnpm tauri build`는 로컬 검증용 Ad-Hoc 서명을 유지한다.
