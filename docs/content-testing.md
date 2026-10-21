# ACP 콘텐츠 수동 확인

macOS와 Node.js 22.18 이상에서 저장소 루트에서 실행한다.

```sh
pnpm dev:content
```

실제 앱과 기존 Rust stdio 테스트 에이전트를 사용한다. API 키와 모델 호출은 필요 없다. 별도 앱 식별자 `com.atte.content-demo`, 개발 서버 포트 1424, 독립된 데이터 폴더 `~/Library/Application Support/com.atte.content-demo`를 사용한다. 평소 사용하는 앱의 대화·설치 설정은 변경하지 않는다. 첫 실행 시 Rust 컴파일에 시간이 걸릴 수 있다.

1. 열린 **Atte Content Test** 창에서 **ACP 콘텐츠 확인 — 여기에 메시지를 보내세요** 대화를 연다.
2. 아무 메시지나 보낸다. 프롬프트를 해석하지 않고 매번 같은 테스트 콘텐츠를 실제 ACP 이벤트로 보낸다.
3. 오디오 재생을 누른다. 1초짜리 440Hz 알림음이 들려야 한다. 자동 재생하지 않으며 저장한 WAV도 재생할 수 있어야 한다.
4. **Web link test** 링크를 누른다. Web 탭에 Example Domain이 표시되어야 한다. 외부 사이트를 여는 이 단계에는 네트워크 연결이 필요하다.
5. **Local file test** 링크를 누른다. Files 탭에 테스트 작업 폴더의 `preview.html` 원문이 표시되어야 한다. HTML 웹페이지를 실행하는 동작은 아니다. 프로젝트 외부의 파일 링크와 내부의 미지원 파일 형식은 OS 기본 앱으로 열린다.
6. 텍스트 리소스에서 원문 펼치기·내용 복사·저장을 확인한다.
7. **ACP tool content test** 도구 상세가 접힌 상태에서도 결과가 보이는지, 앞 설명 → 오디오 → 웹 링크 → 로컬 파일 링크 → 뒤 설명 순서를 확인한다.
8. 오디오 재생 중 다른 화면으로 이동하면 재생이 멈추는지 확인한다.
9. 앱을 닫고 터미널 실행도 종료한 다음 같은 명령으로 다시 연다. 같은 대화를 열면 ACP replay로 내용과 순서가 복원되어야 한다. 복원 후에도 열기·재생·저장을 확인한다.

이 테스트 에이전트는 미리 만든 대화 하나를 확인하기 위한 것이다. 여러 테스트 대화를 동시에 만들지 않는다. 테스트 데이터는 다음 실행의 복원 검증을 위해 보존한다. 완전히 초기화하려면 테스트 앱과 실행 명령을 종료하고 위의 전용 데이터 폴더만 삭제한다.

자동 검증:

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked --test acp_session manual_content_demo
pnpm test src/pages/thread/ui/ResponseContent.test.tsx
```

자동 테스트는 실제 ACP 수신과 replay, WAV 헤더·샘플, 링크 URI와 파일 생성, 표시·수명주기를 검사한다. 스피커 출력과 네이티브 저장 대화상자는 수동으로 확인한다.
