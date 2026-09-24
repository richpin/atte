Status: confirmed

# 사용자 입력 파일 첨부

## Problem Statement

Atte의 사용자 입력은 현재 메시지 본문 문자열만 담을 수 있다. 사용자는 입력창의 `+` 버튼으로 파일을 선택하거나 clipboard 이미지를 붙여넣어 에이전트에 컨텍스트로 전달할 수 없으며, ACP가 제공하는 image, audio, resource link 입력도 사용되지 않는다.

## Confirmed Decisions

- `사용자 입력 (User input)`은 사용자가 한 번 제출하는 메시지 본문과 첨부의 묶음이다. 메시지 본문 없이 첨부만으로도 제출할 수 있다.
- `첨부 (Attachment)`는 사용자 입력과 함께 에이전트에 전달되는 파일 항목이다. image와 audio는 선택 시점의 내용을 고정하는 `내용 첨부 (Content attachment)`이고, 그 밖의 regular file은 원본 위치를 전달하는 `경로 첨부 (Linked attachment)`다.
- `+` 버튼은 File, Image, Audio 선택지를 제공한다. File은 항상 경로 첨부이고, Image와 Audio는 각각 현재 에이전트가 해당 capability를 지원할 때만 메뉴에 표시되는 내용 첨부다. clipboard 붙여넣기는 이미지와 기존 텍스트 붙여넣기만 지원한다.
- image와 audio 내용 첨부는 선택 시점의 내용을 스냅샷한다. 이후 원본 파일이 수정·이동·삭제되어도 이미 만든 내용 첨부의 bytes는 바뀌지 않는다.
- File 선택지로 고른 regular file은 실제 MIME이 image나 audio여도 원본의 canonical `file://` URI를 `resource_link`로 전달한다. 경로 첨부는 원본의 변경·이동·삭제와 에이전트의 접근 가능 여부에 영향을 받으며 첨부 당시 내용 보존을 보장하지 않는다.
- composer는 메시지 본문과 첨부 목록을 분리해 표시한다. 첨부는 선택 순서대로 chip으로 표시하고 wire에서는 메시지 본문 뒤에 첨부 block을 보낸다.
- 에이전트가 응답 중이어도 첨부를 포함한 사용자 입력을 기존 대기열에 넣을 수 있다.
- File 선택지에서는 MIME 판별이나 파일 전체 읽기를 하지 않고 모든 regular file을 `resource_link`로 보낸다. Image와 Audio 선택지에서는 선택한 파일이 요청한 media인지 검증하기 위해 MIME을 판별한다.
- Image 선택지로 추가한 `image/*`는 ACP image content로 보내며 `resource_link`로 fallback하지 않는다.
- 에이전트가 image capability를 제공하지 않으면 Image 선택지를 `+` 메뉴에 표시하지 않는다. 사용자가 File 선택지로 고른 image 파일은 일반 경로 첨부로 보낸다.
- Atte는 에이전트별 image MIME allowlist를 하드코딩하지 않는다. 식별된 모든 `image/*`를 image content로 보내고, 특정 MIME을 거부한 에이전트 오류는 사용자 입력 실패로 표시한다.
- Audio 선택지로 추가한 `audio/*`는 ACP audio content로 보내며 `resource_link`로 fallback하지 않는다. 에이전트가 audio capability를 제공하지 않으면 Audio 선택지를 `+` 메뉴에 표시하지 않는다. 사용자가 File 선택지로 고른 audio 파일은 일반 경로 첨부로 보낸다.
- Image와 Audio 선택지는 OS picker에서 해당 media 확장자만 보이도록 filter한다. 선택 뒤 magic bytes를 우선하고 확장자로 보완해 MIME을 다시 판별하며, 선택지와 다른 media로 판정된 파일은 추가하지 않고 파일별 오류를 표시한다.
- File 선택지로 고른 모든 regular file은 에이전트의 `embeddedContext` capability와 무관하게 `resource_link`로 보낸다.
- 경로 첨부는 첨부 시점의 내용 보장을 깨거나 에이전트의 파일 접근 범위 때문에 읽기에 실패할 수 있더라도, 첨부 전송을 시도할 수 있는 사용자 경험을 우선한다.
- Atte는 이미지를 직접 decode·재인코딩·리사이징하거나 메타데이터를 제거하지 않는다.
- Atte는 첨부 개수, 첨부 byte, 입력 총량과 이미지 차원에 앱 자체 상한을 두지 않는다.
- ACP prompt 요청이 연결에 성공적으로 기록된 뒤 Rust가 관리하는 image/audio snapshot bytes는 삭제한다. 동기 전송 실패 시에는 삭제하지 않는다. 경로 첨부는 snapshot bytes를 만들지 않는다.
- 전송 전 draft는 현재 메시지 본문 draft와 마찬가지로 스레드 전환 중에만 메모리에 유지하고 앱 종료 시 버린다. 제출되어 대기 메시지가 된 image/audio snapshot과 모든 첨부 metadata만 앱 관리 저장소와 SQLite queue에 영속화한다.
- 이번 범위에서는 첨부 중복을 제거하지 않는다. 같은 파일을 한 사용자 입력에 여러 번 추가하면 추가한 횟수와 순서대로 모두 유지한다.
- 첨부 chip에는 basename만 표시한다. canonical 전체 경로는 ACP payload와 Rust 내부에만 두고 UI와 tooltip에는 노출하지 않는다.
- draft에서는 개별 첨부를 제거할 수 있지만 첨부 순서를 변경할 수 없다. draft chip에만 제거용 `x`를 표시한다. sent 사용자 입력의 chip은 `x`와 클릭 동작이 없는 read-only 표시다. 본문이 있는 queued 입력은 첨부를 따로 표시하지 않고 현재처럼 본문만 표시한다. 본문이 전혀 없는 첨부-only queued 입력은 빈 항목 대신 `x`와 클릭 동작이 없는 read-only 첨부 chip을 표시한다. queued 입력은 기존 동작과 같이 입력 전체만 취소할 수 있다.
- clipboard에 image File과 길이가 1 이상인 `text/plain`이 함께 있으면 이미지는 제외하고 공백을 포함한 텍스트를 그대로 삽입한다. `text/plain`이 빈 문자열이고 image File이 있으면 image-only clipboard로 처리한다. 텍스트만 있으면 기존 텍스트 붙여넣기를 수행하며 `text/html`은 혼합 여부 판정이나 삽입에 사용하지 않는다.
- image-only clipboard를 붙여넣을 때 현재 에이전트가 image capability를 제공하지 않으면 이미지를 추가하지 않고 지원하지 않는다는 오류를 표시한다. clipboard image를 임시 파일이나 `resource_link`로 변환하지 않는다.
- 파일 선택이나 붙여넣기 단계에서 일부 파일의 읽기·검증이 실패하면 실패한 파일만 추가하지 않고 파일별 오류를 표시한다. 기존 본문과 정상적으로 추가된 첨부는 그대로 유지하고 전송할 수 있다.
- 메시지 본문이 없는 첫 사용자 입력은 첫 첨부의 파일명을 최대 60자로 잘라 스레드 제목으로 사용한다.
- 여러 첨부 중 하나라도 읽기·검증·변환에 실패하면 사용자 입력 전체를 보내지 않는다.
- queued 입력의 첨부 변환이나 ACP 전송이 실패하면 해당 입력을 `failed` 상태로 queue에 보존하고 자동 queue 진행을 멈춘다. 사용자가 실패한 입력을 재시도하거나 삭제하면 다음 입력의 진행을 재개한다.
- draft 또는 queue에 Image/Audio 내용 첨부가 있는 동안 재연결된 에이전트가 해당 capability를 더 이상 제공하지 않으면, 원본 경로 존재 여부와 관계없이 지원하지 않는 내용 첨부를 별도 알림 없이 제거한다. `resource_link`로 바꾸거나 capability가 돌아올 때까지 snapshot을 보존하지 않는다.
- capability 소실로 queued 입력의 마지막 첨부가 제거되고 메시지 본문도 비어 있으면 해당 queued 입력 전체를 삭제하고 다음 입력으로 queue 진행을 계속한다. 메시지 본문이나 다른 첨부가 남으면 남은 사용자 입력만 정상 전송한다.
- 에이전트가 image/audio capability를 광고했지만 실제 prompt에서 특정 MIME이나 입력을 거부하면 자동 재전송하지 않는다. 해당 사용자 입력을 실패 처리하고 media를 `resource_link`로 바꾸지 않는다.
- 경로 첨부 chip은 basename을 감싼 형태로 표시하고 클릭 동작은 제공하지 않는다. draft에서는 제거용 `x`를 표시하고 queued와 sent에서는 표시하지 않는다. 경로로 전달됐으며 에이전트가 읽지 못할 수 있다는 상태와 접근 가능한 설명을 함께 제공한다.
- 경로 첨부는 사용자가 선택한 원본 regular file의 canonical `file://` URI를 사용한다. Atte가 관리하는 snapshot 경로는 링크로 사용하지 않는다.
- 파일시스템 snapshot 저장과 SQLite queue 갱신은 하나의 transaction으로 묶을 수 없으므로, 두 작업 사이의 비정상 종료로 orphan 파일이 생길 수 있다. 사용자가 스레드에 진입할 때 해당 스레드에 한해 SQLite queue가 참조하지 않는 image/audio snapshot을 제거한다. 앱 시작 시 전체 스레드를 검사하지 않으며, queued 또는 failed 입력이 참조하는 snapshot은 비정상 종료 뒤에도 유지한다.
- 경로 첨부는 queue에서 기다리는 동안 원본이 이동·삭제되어도 존재 여부를 다시 검사하지 않고 선택 당시 canonical URI를 그대로 `resource_link`로 보낸다.
- capability 소실로 draft나 queue에서 제거된 Image/Audio snapshot bytes는 즉시 삭제한다.

## Open Decisions

없음.

## Out of Scope

- 첨부 chip 클릭 및 앱 내부 preview
- MIME별 viewer, WebView 표시와 sandbox 격리
- preview를 위한 frontend byte/object URL cache와 eviction
- 전송 뒤 원본 파일을 다시 읽거나 OS 기본 앱으로 여는 동작
- ACP embedded resource 전송
- 입력창의 `@`를 통해 파일 내용을 직접 삽입하는 동작

preview 기능과 embedded resource 기반 `@` 파일 삽입은 첨부 전송과 별도의 후속 명세 및 구현 작업으로 다룬다.

## References

- [ACP 입력 파일 첨부 기술 조사](../../docs/research/acp-prompt-attachments.md)
