# Zed의 외부 ACP 스레드 목록과 기록 관리

확인일: 2026-09-18. 공식 `zed-industries/zed` 저장소의 main HEAD를 shallow clone하여 커밋 `74646bf29c1a3d1cdb178930d810ecc5a8a6bece`(2026-09-17T18:31:12Z)를 확인했다. 아래 링크는 해당 커밋에 고정했다. 코드 경로를 추적한 조사 결과이며 Atte의 확정 ADR이나 명세 변경은 아니다.

## 결론

Zed의 외부 ACP 에이전트 경로에서는 **앱이 스레드 본문 전체를 자신의 DB에 다시 보관하는 방식이 아니라, 스레드 목록용 메타데이터를 보관하고 본문은 에이전트에 연결하여 불러오는 방식**을 확인했다. Zed 자체 에이전트의 메시지 DB와 외부 ACP의 표시용 메모리 모델을 구별해야 한다. 외부 기록을 에이전트 없이 다시 읽을 수 있도록 하는 디스크 transcript fallback은 아래의 저장·복원 경로에서 찾지 못했다.

## 1. 앱에 저장하는 것은 목록과 연결에 필요한 메타데이터

`ThreadMetadata`의 주석은 native/ACP 공통의 가벼운 목록 데이터이며 클릭 시 적절한 load 경로로 안내하기 위한 것이라고 명시한다. 필드는 앱 thread ID, ACP session ID, agent ID, 제목과 사용자 지정 제목, 시간, 작업 폴더, 원격 연결 정보, archive 여부이다. 메시지나 도구 출력은 없다. SQLite `sidebar_threads`도 이 구조를 저장한다. 스레드 업데이트를 구독하는 경로는 이 메타데이터를 구성하여 저장한다. [타입](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_metadata_store.rs#L305-L330), [업데이트 저장](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_metadata_store.rs#L1264-L1355), [DB 스키마](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_metadata_store.rs#L1370-L1460)

외부 ACP 본문의 UI 모델 `AcpThread`에는 메모리의 `entries: Vec<AgentThreadEntry>`가 있다. `open_or_create_session`은 세션을 열 때 새 모델을 만들며, 같은 연결에 이미 살아 있는 모델이 있으면 이를 재사용한다. 따라서 본문을 전혀 보유하지 않는다는 뜻은 아니고, 실행 중 화면을 구성하기 위한 메모리와 영구 DB 복제를 구별한다. [메모리 모델](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/acp_thread/src/acp_thread.rs#L2292-L2320), [모델 생성과 재사용](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_servers/src/acp.rs#L1212-L1276)

## 2. 기존 에이전트 세션 목록은 ACP로 가져온다

외부 세션 import는 먼저 해당 에이전트의 연결을 확보하고 `session_list` 지원 여부를 확인한다. adapter는 ACP `ListSessionsRequest`에 cwd와 cursor를 전달한다. import 작업은 next cursor가 없어질 때까지 페이지를 읽고, 이미 알려진 세션을 제외한 뒤 `ThreadMetadata`만 생성한다. 새로 가져온 항목은 `archived: true`로 들어간다. 스레드 본문을 모두 import하는 코드가 아니다. [연결·지원 검사](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_import.rs#L689-L745), [ACP 요청](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_servers/src/acp.rs#L560-L599), [페이지 수집](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_import.rs#L793-L824), [메타데이터 변환](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_import.rs#L855-L889)

이는 이 경로에서 에이전트별 비공개 세션 파일 형식을 직접 파싱하지 않고 공통 ACP API를 사용한다는 증거다. 각 공급자 adapter 내부의 실제 저장 형식까지 조사한 것은 아니다.

## 3. 기록 화면을 열 때 연결하고 load를 우선한다

`ThreadView`는 에이전트 연결을 기다린 후 기존 session ID가 있으면 `supports_load_session()`을 우선 검사해 load를 호출한다. load가 없고 resume이 있으면 resume을 호출하면서 `resumed_without_history`를 설정한다. 둘 다 없으면 지원하지 않는다는 오류가 된다. **다음 사용자 메시지를 보낼 때까지 에이전트 연결을 미루는 설계가 아니다.** [복원 분기](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_view.rs#L1095-L1171)

resume만 되는 경우 UI는 이전 메시지를 볼 수 없지만 기존 맥락에서 계속할 수 있다는 안내를 표시한다. 저장 transcript로 그 공백을 메우지 않는다. [안내 UI](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_view/thread_view.rs#L11570-L11580)

load/resume adapter는 각각 ACP 요청을 보낸다. 공통 세션 생성 함수는 RPC를 기다리기 전에 세션을 등록해 load 도중 replay되는 `session/update`를 받을 수 있게 한다. 진행 중 요청도 별도로 등록하여 동시 load가 한 작업을 기다리도록 한다. 로컬 DB의 본문과 replay 본문을 병합하는 경로가 아니라, 새 메모리 모델에 에이전트가 보내는 기록을 구성하는 경로이다. [ACP load/resume](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_servers/src/acp.rs#L1752-L1835), [조기 replay·동시 요청 처리](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_servers/src/acp.rs#L1227-L1330)

## 4. 연결 실패와 오프라인 한계

연결 실패나 load 오류는 `LoadError` 상태로 전환하고 설치 실패, 프로세스 종료 등의 원인을 보여주며 Retry를 제공한다. 위 외부 복원 경로에는 실패 시 로컬 transcript를 여는 fallback이 없다. 따라서 **에이전트 프로세스를 사용할 수 없어도 목록 메타데이터는 남지만, 본문 복원을 보장하지 않는다**는 것이 이 코드에서 도출되는 한계다. 인터넷 오프라인과 로컬 에이전트 실행 불가는 같은 조건이 아니며, 네트워크 없이 load가 가능한지는 에이전트 구현에 달린다. [오류 전환](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_view.rs#L1509-L1523), [오류·재시도 화면](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_view.rs#L2729-L2772)

## 5. Zed 자체 에이전트의 DB와 혼동하지 않기

native `Thread::to_db()`는 실제 `messages`를 복제하여 `DbThread`를 만들고 `ThreadStore::save_thread`가 저장한다. 이는 Zed 자신이 에이전트인 경우의 원본 저장이다. 외부 ACP의 메타데이터 저장과 다르다. UI의 draft/scroll 저장 함수도 `as_native_thread`일 때 native 모델을 갱신한다. 따라서 코드 검색에서 `save_thread`나 공통 모델의 persisted draft 주석을 찾았다는 것만으로 외부 에이전트 transcript도 중복 저장한다고 판단하면 안 된다. [native 직렬화](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent/src/thread.rs#L1919-L1950), [native 저장](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent/src/thread_store.rs#L62-L75), [UI 저장 분기](https://github.com/zed-industries/zed/blob/74646bf29c1a3d1cdb178930d810ecc5a8a6bece/crates/agent_ui/src/thread_view/thread_view.rs#L1087-L1103)

## Atte에 대한 제안과 명세 영향

다음은 위 관찰에서 도출한 제안이다.

- 스레드 본문의 영구 원본은 에이전트가 소유하고, Atte DB에는 앱 스레드 ID·에이전트 ID·ACP session ID·작업 폴더·제목·시각·목록 상태처럼 탐색과 재연결에 필요한 데이터만 보관한다. 별도로 Atte만 소유하는 미전송 입력 등의 UI 상태는 보존할 수 있다.
- `session/list` 지원 시 외부에서 생성된 스레드 목록을 가져오고, 미지원이면 Atte에서 생성하여 알고 있는 세션 목록만 제공한다. 공급자별 세션 파일 직접 파싱은 기본 경로로 추가하지 않는다.
- 본문을 선택하면 연결하고 `session/load`로 기록을 표시한다. `resume`만 있으면 기존 맥락의 재개는 가능하되 과거 본문은 볼 수 없다고 명확하게 표시한다. 둘 다 없으면 재개 불가 상태를 제공한다.
- 기존 계획의 전체 메시지·도구·승인 기록 영구 복제와 replay 병합은 제거할 수 있다. 실제 메모리의 큰 스레드 처리 문제는 별도로 남으므로 DB 비스레드 제거와 무한 스레드 메모리 비용 해결을 같은 주장으로 묶지 않는다.
- 부모 명세가 요구하는 “에이전트가 없거나 인증할 수 없어도 전체 기록 열람”은 metadata-only 구조로 보장할 수 없다. 해당 요구를 “목록은 항상 열람, 본문은 에이전트의 load 가능 여부에 따름”으로 바꾸어야 한다. 본문 전체 독립 열람을 반드시 유지하려면 별도의 사본이나 제한된 캐시가 필요하며, 이는 Zed 외부 ACP 경로와 다른 제품 선택이다.

이번 조사에서는 코드 실행, 실제 에이전트별 재개 테스트, DB 용량 측정은 수행하지 않았다. Zed main은 변경될 수 있으므로 이후 구현에서는 위 커밋과 실제 지원할 ACP adapter capability를 기준으로 검증해야 한다.
