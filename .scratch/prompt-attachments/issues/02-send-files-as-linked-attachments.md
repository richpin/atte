# 02: 파일을 경로 첨부로 전송한다

**What to build:** 사용자가 `+` 메뉴의 File 선택지로 regular file을 추가하고, 메시지 본문과 함께 또는 첨부만으로 에이전트에 보낼 수 있게 한다. File로 선택한 항목은 실제 MIME과 관계없이 원본 위치를 가리키는 ACP resource link로 전달한다.

**Blocked by:** [01: 실패한 대기 입력을 보존하고 재시도한다](./01-preserve-and-retry-failed-queued-input.md).

**Status:** done

- [x] `+` 메뉴에서 File을 선택해 하나 이상의 regular file을 추가할 수 있으며, directory나 사용할 수 없는 경로는 추가되지 않고 파일별 오류가 표시된다.
- [x] File 선택은 파일 전체나 MIME을 읽지 않고 canonical `file://` URI와 표시 metadata만 보존한다.
- [x] 실제 MIME이 image 또는 audio인 파일도 File로 선택하면 resource link로 전달된다.
- [x] draft 첨부는 선택 순서대로 basename chip으로 표시되고 `x`로 개별 제거할 수 있으며, 같은 파일을 여러 번 추가해도 모두 유지된다.
- [x] chip과 tooltip은 전체 경로를 노출하거나 클릭 동작을 제공하지 않으며, 경로 전달이라 에이전트가 읽지 못할 수 있다는 접근 가능한 설명을 제공한다.
- [x] 메시지 본문 뒤에 선택 순서대로 resource link block이 배치되며, 메시지 본문 없이 첨부만으로도 전송할 수 있다.
- [x] 첫 사용자 입력에 메시지 본문이 없으면 첫 첨부의 basename을 최대 60자로 잘라 스레드 제목으로 사용한다.
- [x] 응답 중 제출한 경로 첨부와 metadata는 queue에 영속화되며, 원본이 이후 이동·삭제되어도 존재 여부를 다시 확인하지 않고 선택 당시 URI를 전송한다.
- [x] 본문이 있는 queued 입력은 기존처럼 본문만 표시하고, 첨부-only queued 입력은 `x` 없는 read-only chip으로 표시하며 입력 전체를 취소할 수 있다.
- [x] 전송된 입력과 다시 불러온 스레드 이력에는 클릭할 수 없는 read-only 첨부 chip이 표시된다.
- [x] 파일 선택 오류는 기존 draft를 손상시키지 않고, 전송 단계 실패는 사용자 입력 전체에 원자적으로 적용된다.
- [x] File 선택, ACP resource link payload, queue 복원과 이력 표시를 자동화된 테스트로 검증한다.

## Comments

- 2026-09-24: 구현 완료. WebView는 Rust 파일 선택기가 발급한 첨부 ID만 전송하며, canonical URI와 metadata는 Rust가 보관한다.
- 2026-09-24: 명세 리뷰 0건. 표준 리뷰에서 확인된 신뢰 경계, 도메인 문서, 테스트 분리, 선택 레지스트리 수명 문제를 반영했다.
- 2026-09-24: `pnpm validate`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test --locked` 통과. 후속 리뷰 수정은 집중 Rust/프런트엔드 테스트와 typecheck/lint로 재검증했다.
