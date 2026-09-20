# SolidJS 스트리밍 스레드 상태 갱신 조사

조사일: 2026-09-20. 대상: `src/pages/thread/model/thread.ts`의 `textDelta` 처리와 `src/pages/thread/ui/Message.tsx`의 타임라인 렌더링. SolidJS 공식 문서와 고정 리비전 소스, Solid 기반 채팅 구현인 TanStack AI와 OpenCode의 고정 리비전 소스를 확인했다.

## 결론

현재의 얕은 불변 업데이트는 잘못된 구현이 아니다. 실제로 TanStack AI의 Solid 바인딩도 메시지 배열을 signal에 두고, text delta마다 배열을 `map`해 해당 메시지와 part만 새 객체로 만든 뒤 새 배열을 발행한다. 또한 즉시 발행을 기본값으로 두되 여러 chunk를 묶는 전략을 선택할 수 있게 한다. [TanStack AI `useChat`](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-solid/src/use-chat.ts#L64-L76), [메시지 갱신](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/message-updaters.ts#L25-L47), [chunk 전략](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/strategies.ts#L9-L61)

하지만 Atte처럼 서버가 `threadId`, `turnId`, delta를 주고 현재 마지막 turn만 바꾸는 경우에는 더 좁은 갱신이 가능하다. **권장 1단계는 하나의 `createStore<{ thread?: Thread }>`를 두고, full snapshot에는 `reconcile`, text delta에는 마지막 turn의 `response`만 path update하는 것**이다. 별도의 metadata/turns/permissions signal 여러 개로 쪼개거나 turn을 당장 정규화할 필요는 없다. Store 자체가 중첩 property별 reactive node를 만들고 property read 단위로 추적한다. [Solid `createStore`](https://docs.solidjs.com/reference/store-utilities/create-store#behavior), [Solid Stores](https://docs.solidjs.com/concepts/stores)

권장 2단계는 측정 결과 한 프레임에 여러 delta가 도착하거나 긴 응답의 DOM/Markdown 갱신이 병목일 때만, 인접 delta를 약 한 프레임 단위로 합쳐 store에 한 번 반영하는 것이다. OpenCode의 Solid UI는 이벤트를 16ms 주기로 flush하고 같은 message part/field의 연속 delta를 합친 다음, 한 `batch` 안에서 발행한다. 그 후 `createStore`의 해당 message/part 경로만 갱신한다. [OpenCode event coalescing](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L79-L139), [16ms flush와 batch](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L217-L251), [part delta store update](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L1190-L1230)

## 현재 구현에서 실제로 드는 비용

`createSignal<Thread>`는 기본적으로 이전 값과 새 값의 참조를 비교한다. 매 delta마다 새 `Thread`를 넣으므로 `thread()`를 읽은 모든 reactive scope가 알림을 받는다. 이는 React처럼 `ThreadPage` 컴포넌트 함수 전체를 다시 실행한다는 뜻은 아니다. Solid는 signal을 읽은 구체적인 JSX/effect 계산을 구독자로 연결하고 그 계산만 다시 평가한다. 다만 단일 `thread` signal 아래에서 `status`, `notice`, `permissions`, `queuedMessages`, `turns`를 읽는 계산들은 어떤 필드가 바뀌었는지 구분할 수 없다. [Solid fine-grained reactivity](https://docs.solidjs.com/advanced-concepts/fine-grained-reactivity), [Solid `createSignal`](https://docs.solidjs.com/reference/basic-reactivity/create-signal)

현재 delta 한 건의 상태 계산 비용은 다음과 같다.

- 새 `Thread` 껍데기, 새 `turns` 배열, 바뀐 `Turn`, 새 `response` 문자열을 만든다.
- `turns.map`이 모든 turn을 순회하므로 delta당 turn 수에 비례한다.
- 나머지 turn 객체의 참조는 재사용한다.
- 현재 `<Index>`도 새 배열을 받으면 index별 이전/새 item 참조를 비교한다. 동일 참조인 과거 turn은 item signal을 갱신하지 않고 바뀐 turn만 갱신하지만, 비교 루프 자체는 전체 배열을 지난다. Solid의 `indexArray` 구현도 각 index의 동일성을 검사한 뒤 달라진 index의 signal만 설정한다. [Solid `indexArray` 소스](https://github.com/solidjs/solid/blob/b25c557754f2ced0d86490e6dbfded9b1745b663/packages/solid/src/reactive/array.ts#L186-L250)

따라서 “모든 메시지 DOM을 다시 그린다”는 평가는 부정확하지만, “모든 turn을 스캔하고 `thread` 단위 구독자들을 깨운다”는 비용은 실제다.

문자열은 별개다. JavaScript 문자열 값은 불변이므로 최종 `response`를 문자열로 노출하는 한 `previous + delta`가 새 문자열 값을 만드는 것은 피할 수 없다. 엔진이 내부적으로 매번 전체 문자를 즉시 복사하는지는 구현 세부이므로 단순히 매 delta가 항상 응답 길이만큼 복사된다고 단정해서는 안 된다. 그러나 reactive commit, DOM text 갱신, 향후 Markdown parsing은 새 누적 문자열을 관찰하므로 아주 긴 응답에서는 별도 측정 대상이다.

## Solid 철학에 맞는 최소 구조

Store는 proxy를 통해 중첩 property read를 개별적으로 추적하고, setter의 path syntax로 특정 leaf만 갱신한다. 배열을 새로 만들어 통째로 교체하면 배열 또는 그 property를 읽는 계산을 넓게 깨우는 반면, index path 갱신은 그 index/leaf를 읽는 계산만 대상으로 한다. [Solid `createStore` 동작](https://docs.solidjs.com/reference/store-utilities/create-store#behavior), [배열 path update 비교](https://docs.solidjs.com/concepts/stores#appending-new-values)

Atte에는 다음 형태가 가장 작은 변경이다.

```ts
const [state, setState] = createStore<{ thread?: Thread }>({});
const thread = () => state.thread;

function applySnapshot(next: Thread) {
  setState("thread", reconcile(next));
}

function applyTextDelta(update: TextDelta) {
  const current = state.thread;
  if (!current) return;

  const turnIndex = current.turns.length - 1;
  // 현재 thread와 마지막 turn ID 검증은 먼저 수행한다.
  setState(
    "thread",
    "turns",
    turnIndex,
    "response",
    (response) => response + update.text,
  );
}
```

이 예시는 방향을 설명하기 위한 것으로, 실제 타입 narrowing과 `undefined` 처리는 구현 시 맞춰야 한다. 중요한 점은 다음과 같다.

1. 현재 프로토콜이 delta 대상은 마지막 turn이어야 한다고 이미 검증하므로 `turnId` predicate path나 `findIndex`를 매번 실행할 필요가 없다. `turns.length - 1`을 검증 후 사용하면 target 탐색도 상수 시간이다.
2. full snapshot은 `reconcile`로 기존 store와 맞춘다. 기본 `id` key로 배열 항목을 대응시키며, 동일 turn의 proxy identity를 유지하면서 바뀐 leaf를 갱신할 수 있다. 이는 snapshot 동기화용이며, 이미 target을 아는 text delta마다 전체 tree를 reconcile하는 용도가 아니다. [Solid `reconcile`](https://docs.solidjs.com/reference/store-utilities/reconcile#behavior)
3. `produce`는 복잡한 splice나 여러 nested write를 명령형으로 표현할 때 유용한 store modifier다. 단일 `response` leaf에는 path syntax가 더 직접적이다. `produce`도 현재 proxy state에 write하고 같은 state를 반환하는 도구이지, Immer처럼 매번 새 immutable tree를 만드는 도구가 아니다. [Solid `produce`](https://docs.solidjs.com/reference/store-utilities/produce#behavior)

`thread`를 metadata, turns, permissions, queued messages의 여러 독립 signal로 즉시 분해하는 것보다 wrapper store가 단순하다. 동일한 `Thread` 계약을 유지하면서도 `state.thread.status`, `state.thread.turns[i].response`, `state.thread.permissions`가 서로 다른 reactive dependency가 된다. ID 기반 임의 turn 갱신이 일반화되어 마지막 index라는 보장이 사라질 때만 `turnById`와 `turnOrder` 같은 정규화를 다음 단계로 고려한다.

## `<Index>`와 `<For>`

`<For>`는 item의 값 identity로 행을 추적하고, 같은 item이 이동하면 DOM을 재사용한다. `<Index>`는 위치를 고정하고 해당 index의 item을 accessor로 제공한다. [Solid `<For>`](https://docs.solidjs.com/reference/components/for#behavior), [Solid `<Index>`](https://docs.solidjs.com/reference/components/index-component#behavior)

현재처럼 매 delta마다 바뀐 `Turn` 객체만 새 객체로 만드는 구조에서 `<For>`로 단순 교체하면 오히려 그 turn의 identity가 매번 달라져 행을 새 항목으로 취급한다. 현재 `<Index>`는 대화 turn이 끝에만 추가되고 기존 순서가 바뀌지 않는 계약과 잘 맞으며, 과거 turn 객체의 참조 재사용도 활용한다. 따라서 이 리팩터링에서 `<Index>`를 유지하는 것이 안전하다.

Store path update 이후에는 `Turn` proxy identity가 유지되고 `turn().response`의 property read가 직접 reactive해지므로, `<Index>`의 행을 재생성하지 않고 text leaf만 갱신할 수 있다. 미래에 turn 삽입·삭제·재정렬이 생긴다면 그때 stable store item과 `<For>`의 item-identity semantics를 함께 선택한다.

## 확립된 프로젝트에서 보이는 두 패턴

### TanStack AI: 단순한 immutable snapshot + 선택적 발행 빈도 제어

TanStack AI의 `StreamProcessor`는 누적 text를 만든 뒤 `updateTextPart`로 메시지 배열 전체를 `map`하고, 해당 message와 parts만 복사한다. 이어 새 messages 배열을 Solid signal에 넣는다. 구조적으로 Atte의 현재 코드와 같다. [TanStack AI text 처리](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/processor.ts#L1397-L1413), [얕은 immutable update](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/message-updaters.ts#L25-L47), [signal 반영](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai-solid/src/use-chat.ts#L168-L174)

이 선택은 framework-neutral core가 완성된 `UIMessage[]` snapshot을 발행하기 쉽고 코드가 단순하다는 장점이 있다. 대신 긴 transcript에서 delta당 배열 scan과 coarse signal notification을 감수한다. TanStack AI는 default immediate 외에 N개 chunk batch, punctuation, word-boundary 발행 전략을 제공해 update 빈도를 조정한다. 즉 얕은 불변 업데이트도 실용적인 기본값이지만, 성능이 필요한 소비자는 frequency를 줄여야 한다는 trade-off다. [TanStack AI chunk strategies](https://github.com/TanStack/ai/blob/04bfd8c26ce337cca53f3f8d286f14ed0432a329/packages/ai/src/activities/chat/stream/strategies.ts#L9-L61)

### OpenCode: 구조화된 Solid store + leaf delta + frame 단위 coalescing

OpenCode는 session 정보, message, part, permission, question 등을 `createStore`의 별도 branch에 보관한다. full part update에는 binary search로 index를 찾고 `reconcile(part)`를 적용하며, delta에는 해당 message의 part만 `produce`로 갱신한다. [OpenCode session store](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L196-L210), [snapshot reconcile](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L1133-L1144), [delta leaf update](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-session.ts#L1212-L1230)

또한 수신 이벤트를 바로 UI에 모두 흘리지 않고 16ms 주기로 flush한다. 같은 대상의 연속 delta는 먼저 문자열 하나로 합치고, flush된 여러 이벤트는 `batch` 안에서 전달한다. 이는 Solid의 동기 `batch`와 transport/UI commit rate 제한을 별개의 층으로 다룬 사례다. [OpenCode coalescing](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L79-L139), [OpenCode flush](https://github.com/anomalyco/opencode/blob/ebb7b76eca82342642c78645109e865614533827/packages/app/src/context/server-sdk.tsx#L217-L251)

Atte에는 OpenCode의 전체 정규화 구조를 복제할 이유는 없지만, **snapshot은 reconcile하고 delta는 leaf에 적용한다**는 경계와 **필요할 때만 near-frame coalescing을 추가한다**는 두 원칙은 그대로 적용할 수 있다.

## 단계별 권고와 trade-off

| 단계 | 변경 | 얻는 것 | 비용·주의점 |
| --- | --- | --- | --- |
| 0 | 현 구현 유지 | 가장 단순하고 이미 정확함 | delta당 전체 turn scan, coarse `thread` 알림 |
| 1 (권장) | wrapper `createStore`, snapshot `reconcile`, last-turn response path update, `<Index>` 유지 | 과거 turn scan/객체 할당 제거, status·queue 등 무관한 구독자 격리 | snapshot/undefined 경계와 store proxy를 테스트해야 함 |
| 2 (측정 후) | 같은 turn의 delta를 최대 한 프레임 정도 coalesce | DOM/Markdown/scroll observer 호출 빈도 제한, 문자열 append 횟수 감소 | snapshot과 delta 순서를 보존하고, 종료·오류·thread 전환 전에 반드시 flush/폐기 규칙 필요 |
| 3 (요구가 생길 때) | `turnById` + `turnOrder`, part 단위 모델 | 임의 turn/part target을 상수 시간에 갱신 | 데이터 계약·snapshot reconcile·UI가 복잡해짐; 현재 마지막-turn-only 요구에는 과함 |

2단계를 구현할 때 가장 큰 함정은 frame buffer에 남아 있는 delta와 새 full snapshot의 적용 순서가 뒤바뀌는 것이다. full snapshot, stream 종료, 오류, 구독 해제, thread 전환에서는 pending delta를 먼저 flush할지 폐기할지 정책을 명시해야 한다.

## 검증 기준

리팩터링 전후에는 추측보다 다음을 계측한다.

1. 100개/1,000개 turn에서 1,000개 delta를 적용하는 reducer 시간과 allocation.
2. 과거 turn의 response/status/permission 관련 reactive 계산이 delta 한 건에 다시 실행되는 횟수.
3. 실제 WebView에서 긴 응답 스트리밍 중 frame time, long task, scroll `ResizeObserver` callback 횟수.
4. 다른 thread/turn ID, 이전 구독의 늦은 event, full snapshot과 pending delta 경합.
5. 마지막 turn만 갱신되고 과거 turn DOM과 `UserMessage`의 local expanded state가 보존되는지.

측정 결과 1단계만으로 충분하면 coalescing과 정규화는 추가하지 않는다. 병목이 문자열 자체가 아니라 Markdown parsing이나 scroll 측정에서 나타나면 state 구조보다 해당 소비 경로의 commit 빈도 또는 incremental rendering을 우선 최적화한다.
