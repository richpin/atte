# Windows 로컬 배포와 앱 업데이트

Windows 11 x64 미리보기를 macOS에서 생성한다. GitHub 업로드·공개는 사용자가 직접 수행한다. Windows 실행 검증 전에는 배포 안내에 **Windows 실행 미검증**을 표시한다. macOS 교차 빌드 성공은 Windows 정식 지원 검증을 대신하지 않는다.

배포 본문에 사용할 안내문과 검증 결과 양식은 [Windows 미리보기 검증](windows-validation.md)에 있다. 현재는 실제 Windows 검증과 코드 서명 수단 확보를 기다리는 상태다.

## 준비

[로컬 빌드 준비](windows-build.md)의 NSIS, LLVM/LLD, cargo-xwin, Rust target과 pnpm 의존성을 설치한다. LLVM의 `clang-cl`과 LLD의 `lld-link`가 PATH에 있어야 한다.

```sh
export PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH"
```

`.env.release.example`을 참고해 Git에서 제외되는 `.env.release.local`에 `ATTE_UPDATER_PUBLIC_KEY_PATH`, `TAURI_SIGNING_PRIVATE_KEY`, 필요한 경우 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`를 지정한다. macOS와 Windows는 같은 updater 키를 사용한다. Windows 빌드에는 Apple 인증서와 notary profile이 필요하지 않다. 키 생성·백업은 [macOS 최초 설정](release-macos.md)을 따른다. 개인키·비밀번호·토큰을 커밋하거나 릴리스에 업로드하지 않는다.

`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`과 Cargo.lock의 버전을 맞춘다. 앱 버전은 `0.1.0` 같은 숫자 SemVer를 사용하며 미리보기 여부는 GitHub prerelease와 업데이트 endpoint로 구분한다. 배포한 버전을 덮어쓰지 않고 다음 검증에는 버전을 증가시킨다.

## 미리보기 생성·수동 공개

```sh
pnpm release:windows
```

명령은 Windows 코드 서명이 없는 NSIS Setup.exe를 빌드하고, Tauri updater 서명을 버전에 결합해 생성한다. `.scratch/releases/windows/preview/<version>/`에 이번 실행의 Setup.exe, `.exe.sig`, `preview.json`, `SHA256SUMS`를 복사한다. updater는 ZIP이 아닌 이 Setup.exe를 사용한다. 빌드 도구나 키가 없으면 실패하며 준비 항목을 안내한다. 네트워크가 필요한 SDK·bundler 다운로드 실패를 해결한 뒤 명령 전체를 재실행한다.

1. `windows-v<version>` 태그로 GitHub `richpin/atte`의 draft Release를 만들고 **prerelease**로 설정한다. 빌드한 develop 커밋을 태그로 지정한다. Setup.exe, `.sig`, `SHA256SUMS`를 업로드한다. Windows 실행 미검증 여부와 미서명 상태를 본문에 명시하고 prerelease로 공개한다. latest로 지정하지 않는다.
2. 별도의 `windows-preview` 태그 Release도 **prerelease**로 유지한다. 여기에 이번 버전의 `preview.json`을 업로드한다. 다음 버전에는 이 채널 asset만 수동 교체한다. 버전별 설치 파일은 원래 태그에서 보존한다.
3. 미리보기 앱은 고정 endpoint `https://github.com/richpin/atte/releases/download/windows-preview/preview.json`만 확인한다. 메타데이터의 설치 파일 URL은 `windows-v<version>`에 고정된다. 두 Release와 asset 모두 인증 없이 접근 가능해야 한다. 앱에 GitHub 토큰을 넣지 않는다.
4. 미리보기에는 `latest.json`을 업로드하지 않는다. 기존 정식 앱은 GitHub `releases/latest/download/latest.json`을 사용하며 prerelease는 GitHub latest 목록에서 제외된다. Windows 미리보기는 정식 채널로 자동 전환되지 않는다. 정식 전환 때는 stable Setup.exe를 수동 설치한다.

## 정식 배포

[실환경 점검](windows-workflows.md), 아래 두 버전 업데이트, Windows 코드 서명 준비를 마친 후 사용한다. `--stable`은 정식 endpoint를 주입하지만 현재 자동 코드 서명을 제공하지 않는다. 이 플래그만으로 정식 Windows 지원이 준비되었다고 간주하지 않는다.

```sh
pnpm release:macos
pnpm release:windows --stable
pnpm release:manifest /tmp/latest.json \
  src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/update-darwin.json \
  .scratch/releases/windows/stable/<version>/update-windows.json
```

macOS 명령은 [Developer ID·notarization 준비](release-macos.md)를 먼저 완료한다. 각 빌드는 플랫폼별 fragment만 만들며 정식 `latest.json`은 합치기 명령만 생성한다. 버전이 다르거나 플랫폼이 빠지거나 중복되면 합치기를 거부하므로 어느 플랫폼도 실수로 누락하지 않는다. 플랫폼별 이전 버전 URL을 새 전역 버전 아래에 복사하지 않는다. Tauri의 `requireSignedVersion` 검증과 충돌하기 때문이다. 한 플랫폼만 수정했어도 두 플랫폼을 같은 버전으로 빌드한다.

`v<version>` draft Release 하나에 macOS DMG, updater `.app.tar.gz`와 `.sig`, Windows Setup.exe와 `.sig`, 합친 `latest.json`을 모두 업로드한다. 필요하면 manifest에 `notes`를 수동 추가한다. URL·버전·두 플랫폼 서명을 확인한 뒤 정식 공개하고 latest로 지정한다. 각 fragment는 업로드할 필요 없다. 기존 macOS asset·manifest를 덮어쓰지 않으며 모든 후속 정식 Release에도 두 플랫폼을 포함한다. 자동 업로드와 CI는 없다.

## Windows 설치·재시작 정책

공개키가 있는 release 빌드에서 기존 업데이트 알림·설정을 사용한다. 다운로드 시 HTTPS, updater 서명, 서명에 기록된 버전을 검증한다. Windows에서는 검증된 설치 파일을 메모리에 보관하고 `Atte 재시작`을 선택할 때 설치한다. 수정 파일 확인을 취소하면 앱과 다운로드를 유지한다. 승인하면 알림 정리, 진행 중 설치·제거 작업 완료, 에이전트와 자식 프로세스 종료를 기다린 다음 Tauri NSIS updater를 실행한다. Tauri가 현재 앱을 종료하고 설치 프로그램이 앱을 다시 실행한다. 앱 데이터·스레드 이력·worktree와 인증 정보는 기존 저장 위치에서 유지한다.

재시작 대신 앱을 종료하면 메모리의 Windows 다운로드는 폐기한다. 다음 실행에서 다시 다운로드해야 한다. 설치 프로그램 실행에 실패하면 대화상자를 표시하고 종료하므로 기존 앱을 다시 실행해 재시도한다. macOS의 설치 후 나중에 재시작하는 기존 동작은 유지한다.

## 실제 Windows 두 버전 검증

1. 같은 키로 서명한 미리보기 N과 더 높은 N+1을 생성한다. `windows-vN`, `windows-vN+1`에 파일을 보존한다. 처음에는 채널 `preview.json`을 N으로 설정한다.
2. Windows 11 x64에서 N의 Setup.exe를 설치한다. Claude·Codex 인증, 스레드·첨부·worktree와 수정 파일을 준비하고 데이터가 유지되는지 기록한다.
3. 채널 manifest만 N+1로 교체한다. 앱 시작 확인과 수동 확인, 버전·다운로드 진행률을 확인한다. 네트워크 단절 후 재시도와 손상된 파일·서명 거부를 확인한다.
4. 다운로드 후 `Atte 재시작`에서 수정 파일 확인을 취소하고 앱·작업이 계속되는지 확인한다. 다시 재시작을 승인해 실행 중 에이전트·인증 콘솔·자식 프로세스 정리를 확인한다. 진행 중 설치·제거 작업이 있으면 완료를 기다리는지도 확인한다.
5. NSIS 설치와 앱 재실행 뒤 N+1 표시, 기존 스레드 재개, 첨부·설정·인증·worktree 보존을 확인한다. 일반 종료 후 다시 실행할 때 재다운로드하는 경로도 확인한다. 기존 macOS 정식 앱에는 이 미리보기가 표시되지 않아야 한다.

## Windows 코드 서명 준비

현재 Setup.exe는 Authenticode 미서명이며 SmartScreen의 경고나 조직 정책으로 실행이 차단될 수 있다. **Tauri updater 서명은 배포 파일의 무결성·버전을 검증하며 Windows 게시자 신뢰를 부여하지 않는다.**

정식 배포 전 조직에 맞는 Authenticode 인증서 또는 Microsoft Artifact Signing을 선정·발급한다. [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)의 `bundle.windows.signCommand`로 macOS에서 실행 가능한 서명 도구를 연결하고 키는 저장소 밖의 인증서 저장소나 서명 서비스에 보관한다. 교차 빌드에서는 NSIS 설치 파일과 내부 실행 파일 모두 서명되는지 확인한다. 타임스탬프, 게시자, Windows의 Authenticode 검증을 확인하고 그 최종 Setup.exe에 updater 서명·SHA-256을 다시 생성한다. updater 서명 이후 EXE를 코드 서명하면 updater 무결성이 깨진다. 현재 릴리스 명령은 미서명 미리보기용이며 이 준비와 Windows 실제 검증을 마치기 전 정식 지원으로 공개하지 않는다.

참고: [Tauri updater](https://v2.tauri.app/plugin/updater/), [macOS 교차 빌드](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos), [GitHub latest 링크](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases).

## 로컬 검증 기록 (2026-11-06)

macOS Apple Silicon에서 `pnpm release:windows`를 실제 실행해 `.scratch/releases/windows/preview/0.1.0/`에 Setup.exe(7.91 MiB), updater `.sig`, `preview.json`, `SHA256SUMS`를 생성했다. SHA-256은 `2332d0777e71e51d3affb17ed255bdc187064874f5216f1b372b5252f7d6f613`이다. 최종 서명에 `version:0.1.0`이 포함되며 manifest는 버전별 Windows prerelease URL을 가리킨다. 이 미리보기 manifest를 정식 병합 명령에 입력했을 때 게시를 거부하는 것도 확인했다.

`pnpm validate`는 63개 파일·518개 테스트와 정적 검사·FSD·TypeScript 검사를 통과했다. `sh scripts/validate-rust.sh`는 포맷·전체 대상 검사·Clippy와 373개 테스트를 통과했고 기존 8개는 제외됐다. Windows 전체 대상·전체 feature의 cargo-xwin Clippy(`-D warnings`)도 통과했다. Standards·Spec 코드 리뷰 모두 지적이 없었다.

교차 링크 시 Windows CRT PDB 누락 경고와 Tauri의 교차 코드 서명 생략 안내는 남는다. Setup.exe는 Authenticode 미서명이다. 업로드·공개, Apple notarization 재실행, Windows 앱·테스트 실행과 두 버전 간 실제 업데이트는 수행하지 않았다. 앞의 실환경 절차와 후속 Windows 검증 작업에서 확인한다.

테스트 경계를 확인한 뒤 manifest 병합 공개 함수의 회귀 테스트 10개와 앱 종료 이벤트의 편집 취소·재확인 및 저장 완료 대기 테스트 2개를 추가했다. 릴리스 스크립트 테스트도 기본 `pnpm test`와 정적 검사에 포함한다. 최종 `pnpm validate`는 65개 파일·530개 테스트를 통과했고 기존 Rust 종료·자식 프로세스 정리 경계의 테스트 9개도 별도로 통과했다. 이 추가 작업은 테스트·검증 설정만 변경하며 위 설치 파일의 앱 코드는 그대로다.
