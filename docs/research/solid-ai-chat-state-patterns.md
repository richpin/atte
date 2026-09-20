# SolidJS 기반 AI 대화 앱의 스트리밍 상태 관리 패턴

조사일: 2026-09-20

## 질문과 결론

질문은 SolidJS를 사용하는 오픈소스 AI 대화 앱이 메시지 스트리밍 상태와 순서 정보를 어떻게 관리하는지, 특히 `revision`을 대화 객체 안에 두는지가 일반적인지다.

결론부터 말하면 **`Thread.revision`과 같은 전역 순번을 대화 도메인 객체에 넣는 것이 SolidJS 생태계의 공통 패턴은 아니다.** 조사한 구현은 다음 세 방향으로 나뉜다.

1. OpenCode는 메시지와 part를 ID 기반 Store로 정규화하고, ordered event stream과 snapshot/live 경합 제어로 일관성을 유지한다. 전역 revision이나 gap 검사는 없다.
2. TanStack AI는 Solid 쪽에는 완성된 `UIMessage[]`를 signal로 발행하지만, 재연결·중복 제거용 순번은 대화 모델이 아니라 전송 adapter의 SSE/NDJSON offset으로 관리한다.
3. Jockey는 session별 `seq`를 별도 `Map`에서 추적한다. gap을 기록하고 stale run을 token으로 거르지만, `seq`를 `AppSession` 안에 저장하지 않는다.

따라서 `revision`을 영속적인 `Thread` 데이터로 취급할 필요는 없다. Atte는 명령 응답과 구독을 병합하는 대신, 초기 스냅샷을 포함한 Thread 구독 하나만 화면 상태의 공급원으로 사용하기로 했다. 구독이 실패하면 변경 명령을 막고 새 구독의 스냅샷으로 다시 동기화하므로 별도의 프런트엔드 revision cursor도 두지 않는다.

## 비교 요약

| 프로젝트 | Solid 반응 상태 | delta 반영 | snapshot 반영 | 중복·누락·역전 대응 | 순서 정보의 위치 |
| --- | --- | --- | --- | --- | --- |
| OpenCode | session/message/part별 `createStore` | 대상 part/field 경로만 `produce` | ID key의 `reconcile` | ordered stream, touched/tombstone, 완료 값으로 교정; 전역 gap 검사는 없음 | 별도 revision 없음 |
| TanStack AI | `UIMessage[]`를 `createSignal` | core가 해당 message/part만 얕게 복사하고 배열 snapshot 발행 | `MESSAGES_SNAPSHOT`을 기존 tool state와 병합 | durable transport면 offset 중복 제거 및 `Last-Event-ID` 재개 | transport adapter의 offset |
| Jockey | `AppSession[]` `createStore` | session index 경로를 `produce`; 프레임 단위 문자열 병합 | 초기 session load 중심 | session별 `seq` gap 경고, run token으로 stale event 차단 | 비반응형 `Map`, session 밖 |

## OpenCode: 정규화 Store와 ID 기반 이벤트 병합

조사 기준은 OpenCode `dev`의 고정 리비전 `ebb7b76eca82342642c78645109e865614533827`이다.

OpenCode는 하나의 거대한 session 객체를 매 delta마다 교체하지 않는다. session 정보, message 배열, message별 part 배열, status 등을 Store의 별도 branch에 둔다. 예를 들면 `info[sessionID]`, `message[sessionID]`, `part[messageID]`, `session_status[sessionID]` 형태다. [OpenCode session store](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L183-L207)

HTTP에서 받은 전체 메시지와 part 목록은 각각 ID를 key로 한 `reconcile`로 반영한다. 이 방식은 같은 ID의 Store 객체 identity를 보존하면서 실제로 바뀐 속성만 알린다. [메시지와 part snapshot reconcile](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L576-L637)

OpenCode가 별도 revision 없이도 snapshot과 live event의 역전을 막는 핵심은 요청 중 변경 추적이다. HTTP snapshot을 기다리는 동안 live event가 도착할 수 있으므로 `touchedMessages`, `touchedParts`, `removedMessages` 같은 집합을 기록하고, 나중에 도착한 snapshot이 이 최신 상태를 덮어쓰지 못하게 한다. [변경 추적 집합](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L140-L172), [snapshot/live 병합](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L640-L691)

개별 event도 전체 tree를 교체하지 않는다.

- `message.updated`는 ID 정렬 배열에서 이진 검색해 정확한 message index에 `reconcile(info)`를 적용한다. [message upsert](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L986-L1017)
- `message.part.updated`도 `part[messageID][partIndex]`만 `reconcile(part)`한다. [part upsert](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L1050-L1106)
- `message.part.delta`는 `partID`로 대상 part를 찾고 지정된 문자열 field에만 `produce`로 text를 이어 붙인다. [part delta](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L1146-L1187)
- V2 reducer도 text delta를 해당 assistant content에 누적하고, 완료 event에서는 서버가 보낸 전체 text를 최종 값으로 사용한다. [V2 text reducer](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session-v2-reducer.ts#L186-L200)

이벤트 빈도도 상태 모델 바깥에서 제어한다. 수신 event를 약 16ms 동안 모으고, 같은 part의 연속 전체 update는 마지막 것만 남기며, 같은 대상의 연속 delta는 문자열 하나로 합친다. 한 번의 flush는 Solid `batch()` 안에서 실행한다. [이벤트 coalescing](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L54-L131), [flush와 batch](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L203-L235)

OpenCode에는 Atte처럼 `incomingRevision === currentRevision + 1`을 검사하는 전역 gap 검사가 없다. 이는 `revision`이 불필요하다는 일반적인 증거가 아니라, OpenCode가 다음 계약을 선택했다는 뜻이다.

```text
ID 기반 entity store
+ event stream의 도착 순서
+ snapshot 요청 중 touched/tombstone 추적
+ 완료 event의 authoritative 전체 값
+ 연결 종료 후 재연결
```

즉 OpenCode는 수신 event log의 완전성을 전역 번호로 증명하기보다, ID별 최신 상태를 병합하고 이후 authoritative update로 교정한다.

## TanStack AI: UI snapshot과 transport offset의 분리

TanStack AI는 독립 앱이라기보다 Solid용 AI chat SDK이지만, 프레임워크 중립 core와 Solid UI 경계를 보여주는 좋은 비교 대상이다. 조사 기준은 고정 리비전 `04bfd8c26ce337cca53f3f8d286f14ed0432a329`이다.

Solid `useChat`은 messages, status, loading, queue, run ID 등을 각각 signal로 둔다. core `ChatClient`가 `onMessagesChange`로 새 `UIMessage[]`를 발행하면 이를 messages signal에 넣는다. 즉 이 구현은 message tree에 `createStore` path update를 직접 적용하지 않는다. [Solid `useChat` state](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-solid/src/use-chat.ts#L58-L84), [`onMessagesChange`](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-solid/src/use-chat.ts#L168-L180)

core processor는 `TEXT_MESSAGE_CONTENT`를 message ID에 연결하고 text를 누적한다. 발행할 때는 messages 배열을 `map`해 대상 message와 마지막 text part만 새 객체로 만들고 나머지 message 객체는 재사용한다. 이는 Atte가 리팩터링 전에 사용하던 얕은 불변 update와 같은 계열이다. [text delta accumulation](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/processor.ts#L1340-L1413), [message/part 얕은 update](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/message-updaters.ts#L18-L48)

전체 `MESSAGES_SNAPSHOT` event가 오면 그대로 덮어쓰지 않고, wire snapshot으로 재구성할 수 없는 기존 tool-call metadata를 ID 기반으로 병합한다. [snapshot reconcile](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/processor.ts#L1040-L1075)

순서와 중복 문제는 대화 객체의 revision이 아니라 transport adapter에서 다룬다. durable SSE/NDJSON event의 offset을 `seen` 집합과 `lastEventId`로 추적하고, 이미 본 offset은 버린다. 연결이 끊기면 `Last-Event-ID`로 마지막 offset 이후부터 재개한다. offset이 없는 비내구성 stream은 자동 재개하지 않는다. [reconnect tracker와 dedup](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-client/src/connection-adapters.ts#L143-L218), [resumable stream](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-client/src/connection-adapters.ts#L755-L840)

여기서 얻을 수 있는 중요한 경계는 다음과 같다.

```text
UIMessage
└─ 사용자에게 보여줄 대화 상태

lastEventId / seen offsets
└─ 전달 보장과 재연결을 위한 transport 상태
```

## Jockey: Store path update, run token, 외부 sequence cursor

Jockey는 Tauri, Rust, SolidJS 기반의 멀티 에이전트 앱이다. 조사 기준은 고정 리비전 `c7431a81469c77d0cc821dc39c0c8905399a22fa`이다.

Jockey는 `AppSession[]`를 `createStore`에 두고 session ID에서 index로 가는 `Map`을 별도로 유지한다. update는 해당 index에 `produce`를 적용하므로 전체 session 배열을 새로 만들지 않는다. [session Store와 index map](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/hooks/useSessionManager.ts#L8-L49)

stream text와 thought delta는 session별 buffer에 모았다가 `requestAnimationFrame`에서 한 번에 해당 session 경로에 반영한다. 완료할 때는 먼저 pending buffer를 flush하고, 최종 응답이 있으면 누적 text를 authoritative 최종 값으로 교체한다. [frame buffer와 path update](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/hooks/useStreamEngine.ts#L18-L104), [완료 전 flush와 최종 값](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/hooks/useStreamEngine.ts#L142-L187)

동시에 실행 세대가 뒤섞이는 문제는 `streamingRunToken`으로 막는다. 현재 stream을 소유한 token과 event의 run이 다르면 stale event를 버리고, 이전 실행의 늦은 완료도 새로운 stream을 지우지 못한다. [run token 검사](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/lib/acpEventBus.ts#L166-L179), [late completion 방지](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/hooks/useStreamEngine.ts#L142-L161)

Jockey의 `seq`는 `AppSession` 필드가 아니라 event bus 내부의 `lastSeqBySession: Map`에 있다. 연속되지 않으면 경고하지만 event 적용 자체를 막거나 자동 복구하지는 않는다. [session별 sequence 검사](https://github.com/recailai/jockey/blob/c7431a81469c77d0cc821dc39c0c8905399a22fa/src/lib/acpEventBus.ts#L180-L187)

따라서 Jockey는 Atte의 `revision` 의미를 다음 둘로 나눈 사례에 가깝다.

- run token: 어느 실행이 현재 stream을 소유하는가
- sequence cursor: 현재 stream에서 어디까지 받았는가

둘 다 대화의 영속 도메인 내용이 아니라 event 처리기의 런타임 상태다.

## Atte에 대한 판단

### 1. 상태 공급원을 하나로 제한한다

Atte의 기존 `revision`은 명령 응답과 구독이라는 두 상태 공급원의 도착 순서를 병합하기 위해 필요했다. 최종 설계에서는 변경 명령이 성공 또는 실패만 반환하고, Thread 구독이 초기 전체 스냅샷과 이후 변경을 모두 전달한다. 프런트엔드는 명령 응답으로 Thread를 직접 갱신하지 않는다.

한 구독 안에서는 백엔드가 event 순서를 보장한다. 구독 오류나 예상하지 못한 turn delta가 발생하면 프런트엔드는 변경 명령을 막고 재구독하며, 새 구독의 전체 스냅샷으로 상태를 다시 맞춘다. 재생 가능한 durable transport가 아니므로 offset cursor를 흉내 내지 않고, 확인 가능한 구독 실패를 복구 경계로 삼는다.

백엔드가 오래된 에이전트 실행 결과를 거부하기 위한 내부 `generation`은 유지한다. 이는 프런트엔드 전달 순서를 병합하던 `Thread.revision`과 목적이 다르다.

### 2. 성능 구조는 OpenCode/Jockey 방향과 일치한다

이번 Atte의 `createStore + reconcile + last-index path update`는 OpenCode와 Jockey에서 확인한 핵심 원칙과 일치한다.

- snapshot은 `reconcile`
- delta는 알고 있는 leaf 경로만 update
- 실행 전환은 thread/run identity로 stale event 차단
- 성능 측정에서 필요할 때만 frame 단위 delta coalescing 추가

다음 최적화는 실제 WebView 측정에서 delta commit 빈도가 병목으로 확인될 때만 OpenCode/Jockey식 frame coalescing을 추가하는 것이다. 현재 요구에는 전체 정규화나 별도의 전달 cursor가 필요하지 않다.

## 최종 권고

1. Thread 구독을 화면 상태의 단일 공급원으로 사용한다.
2. 변경 명령은 성공 또는 실패만 반환하고 Thread 스냅샷을 반환하지 않는다.
3. `Thread.revision`과 delta revision을 제거한다.
4. 구독 실패 중에는 기존 내용을 유지하되 변경 명령을 막고, 재구독 스냅샷으로 복구한다.
5. 백엔드 내부 `generation`은 stale agent run 방지용으로 유지한다.
6. durable replay transport를 도입할 때만 offset/cursor가 필요한지 다시 평가한다.

이 구조는 UI 상태와 명령 결과의 경합을 제거하고, OpenCode처럼 Solid Store의 leaf만 세밀하게 갱신한다. 상세한 선택과 재시도 정책은 ADR `0001-use-thread-subscription-as-the-single-state-source.md`에 기록한다.
