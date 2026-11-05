# Windows 로컬 빌드

Windows 11 x64용 개발 중 설치 파일을 macOS에서 생성한다. Windows 실행 검증은 별도로 필요하며, 교차 빌드 성공만으로 정식 Windows 지원을 선언하지 않는다.

## macOS 준비

[Tauri 공식 교차 빌드 절차](https://v2.tauri.app/distribute/windows-installer/#build-windows-apps-on-linux-and-macos)에 따라 NSIS, LLVM/LLD, Windows MSVC target, cargo-xwin을 설치한다. 첫 빌드는 Windows SDK·CRT와 bundler 도구 다운로드에도 네트워크 연결이 필요하다.

```sh
brew install nsis llvm lld
cargo install --locked cargo-xwin
rustup target add x86_64-pc-windows-msvc
export PATH="$(brew --prefix llvm)/bin:$(brew --prefix lld)/bin:$PATH"
pnpm install --frozen-lockfile
pnpm build:windows
```

기본 Tauri 설정에 `tauri.windows.conf.json`이 자동 병합되어 NSIS를 사용한다. MSI는 생성하지 않는다. 산출물 위치는 다음과 같다.

- 앱: `src-tauri/target/x86_64-pc-windows-msvc/release/atte.exe`
- 설치 파일: `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Atte_<version>_x64-setup.exe`

이 명령은 로컬 빌드 전용이다. 코드 서명, updater 서명, 업데이트 manifest 생성과 GitHub Releases 게시는 후속 배포 작업의 범위다.

## 구현 경계

- Registry의 `windows-x86_64` 바이너리와 npm 배포를 선택한다. Windows에서는 시스템 `node.exe`와 같은 디렉터리의 npm JS entrypoint를 Node.js로 직접 실행해 `.cmd` 셸 해석을 피한다. 호환 런타임이 없으면 공식 Node.js v24.21.0 win-x64 ZIP을 SHA-256 검증 후 배치한다.
- 에이전트, 인증 프로브, 설치 명령과 Skills CLI를 일시 중단 상태로 Windows Job Object에 넣은 뒤 실행한다. Job에서 breakaway를 허용하지 않으며, 강제 중지와 guard 소멸 시 자손도 종료한다. 런타임 관리자도 Job 핸들을 보존하며, task 취소 뒤에도 Job 전체 종료를 확인하고 확인 실패 시 기존 설치본을 유지해 재시도한다. macOS의 process group·libproc 자손 정리는 유지한다.
- 파일 읽기는 말단 링크·reparse point를 거부하는 핸들을 사용하고, 파일 이동은 기존 대상을 원자적으로 거부한다. Git for Windows의 UTF-8 경로를 검증하며 변환할 수 없는 출력을 다른 경로로 대체하지 않는다.

## Windows 실제 환경의 후속 검증

이 단계의 산출물은 개발 중인 미서명 빌드다. Windows 인증 터미널, 알림, 외부 앱 연동, WebView2 탐색 연동, OS 단축키, 업데이트·배포는 후속 작업에서 다룬다. 미지원 API는 오류 또는 미지원 상태를 반환하며 성공으로 처리하지 않는다.

실제 환경에서 설치·실행·재시작, Claude/Codex 설치·인증·대화·재개·중지, Job 자손 종료, 공백·한글 Windows 경로, 링크·junction 보호, 파일 이동의 덮어쓰기 거부, Git/worktree와 저장 데이터 유지를 확인한다. macOS에서 Windows 테스트를 실행한 것으로 기록하지 않는다.

## 로컬 검증 기록

2026-11-05 macOS Apple Silicon에서 cargo-xwin 0.23.1, LLVM/LLD 23.1.5, NSIS 3.13으로 Windows x64 실행 파일과 NSIS 설치 파일을 생성했다. bundled SQLite와 TLS 암호화 네이티브 의존성도 실제 컴파일했다. macOS ARM64 앱 번들 빌드도 통과했다.

`pnpm validate`는 63개 파일의 516개 테스트를 통과했다. `scripts/validate-rust.sh`의 포맷·전체 대상 타입 검사·Clippy·전체 Rust 테스트는 372개 통과, 기존 제외 8개였다. `cargo xwin check --target x86_64-pc-windows-msvc --all-targets --locked`로 Windows 앱과 테스트 코드를 컴파일했으며, Windows용 테스트 실행과 앱 실행은 검증하지 않았다.
