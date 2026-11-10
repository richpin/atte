# 에이전트 설치본 실행

Registry의 배포 방식과 설치된 파일의 실행 방식은 구분한다. `npx` 배포는 npm으로 파일을 준비한다는 의미이며, 그 실행 파일이 JavaScript라는 보장은 없다. Grok Build와 Factory Droid는 Unix에서 설치 스크립트가 npm 진입점을 네이티브 바이너리로 교체한다.

## 실행 규칙

| 실행 방식 | 진입점과 환경 |
| --- | --- |
| `direct` | Registry 압축 배포가 지정한 실행 파일을 직접 실행한다. Unix 스크립트와 Windows `.cmd`·`.bat`도 OS·Rust 표준 프로세스 실행 규약을 따른다. |
| `node` | Registry가 명시적으로 `cmd: node`를 지정한 경우, 호환 Node를 준비하고 설치본의 스크립트를 인수로 전달한다. |
| `npm` | 설치 후 npm이 만든 Unix `node_modules/.bin/<명령>` 또는 Windows `<명령>.cmd`를 직접 실행한다. 호환 Node 디렉터리와 해당 `.bin`을 PATH에 제공한다. |

npm 명령 선택은 npm의 규칙을 따른다. 단일 bin 또는 같은 대상을 가리키는 별칭만 있으면 그 명령을 사용하고, 여러 대상이면 scope를 제외한 패키지명과 일치하는 명령을 사용한다. 선택이 모호하면 설치에 실패한다. 파일 확장자나 에이전트 ID로 인터프리터를 추측하지 않으며 래퍼·shebang 인수·심볼릭 링크를 유지한다.

패키지 메타데이터, 진입점과 링크 대상은 설치본 내부에 존재해야 한다. 링크 대상 검증에는 canonical 경로를 사용하지만 저장·실행에는 npm의 원래 진입점 경로를 사용한다. 실행 시 다른 설치본·시스템 동명 명령을 검색하거나 패키지를 추가 다운로드하지 않는다. Node 자체의 재탐색과 관리 런타임 준비는 기존 정책을 따른다.

실행 정의 해석은 ACP 인증·로그아웃, 터미널 로그인, 스레드 연결·Reconnect에서 공유한다. 작업 폴더·Registry 인수·환경변수와 ACP stdin/stdout을 보존하고, Unix 프로세스 그룹 및 Windows Job Object로 자손까지 정리한다. Windows batch 인수 처리는 Rust 표준 라이브러리에 맡기며 셸 명령 문자열을 별도로 조합하지 않는다.

## 기존 설치본 복원

불변 `installation.json`의 `sourceIdentity`가 npm이면 설치된 패키지에서 npm 진입점을 다시 구한다. 과거에 저장된 `node` 정의도 이 규칙으로 정상화한다. 활성·대기 설치본 모두 같은 해석을 사용하며 기존 manifest를 덮어쓰거나 DB schema v1에 마이그레이션을 추가하지 않는다.

잘못된 manifest나 누락·외부 링크가 있는 설치본은 실행 가능한 설치본으로 등록하지 않는다. 활성 설치 선택은 수리·삭제를 위해 보존하고, 유효하지 않은 대기 설치본은 승격하지 않는다. 설치 검증 실패는 기존 활성 설치본을 대체하지 않는다.

## 구현 근거

- [npm bin 규약](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#bin)
- [npm 명령 선택](https://github.com/npm/cli/blob/latest/workspaces/libnpmexec/lib/get-bin-from-manifest.js)
- [npm Windows shim](https://github.com/npm/cmd-shim/blob/main/lib/index.js)
- [Rust Windows batch 실행](https://github.com/rust-lang/rust/blob/1.85.0/library/std/src/process.rs#L114-L129)
