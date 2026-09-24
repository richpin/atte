# 03: 이미지와 오디오를 내용 첨부로 전송한다

**What to build:** 에이전트 capability에 맞춰 사용자가 파일 picker나 clipboard에서 이미지와 오디오의 선택 시점 내용을 첨부하고, ACP image 또는 audio content로 직접·대기 전송할 수 있게 한다. 내용 첨부 snapshot은 전송 완료 전까지 안전하게 보존하고 이후 정리한다.

**Blocked by:** [02: 파일을 경로 첨부로 전송한다](./02-send-files-as-linked-attachments.md).

**Status:** done

- [x] 현재 에이전트가 image capability를 제공할 때만 Image 선택지를, audio capability를 제공할 때만 Audio 선택지를 `+` 메뉴에 표시한다.
- [x] Image와 Audio picker는 해당 media 확장자로 선택 범위를 좁히고, 선택 후 magic bytes 우선·확장자 보완 방식으로 요청한 media인지 다시 검증한다.
- [x] 잘못된 media 파일은 추가하지 않고 파일별 오류를 표시하며, 같은 선택에서 정상인 파일과 기존 draft는 유지한다.
- [x] Image 또는 Audio로 선택한 파일은 선택 시점 bytes를 snapshot하며 앱 자체 크기·개수·차원 제한, 중복 제거, decode, 재인코딩, resize 또는 metadata 제거를 적용하지 않는다.
- [x] image-only clipboard는 image 내용 첨부로 추가하고, image File과 길이가 1 이상인 `text/plain`이 함께 있으면 이미지를 제외하고 공백을 포함한 텍스트를 그대로 삽입한다.
- [x] clipboard 판정과 삽입에는 `text/html`을 사용하지 않으며, image capability가 없을 때 image-only clipboard를 붙여넣으면 임시 파일을 만들지 않고 오류를 표시한다.
- [x] ACP prompt에는 메시지 본문 뒤에 선택 순서대로 image, audio와 resource link block이 배치된다.
- [x] 에이전트가 광고한 capability와 달리 특정 MIME이나 prompt를 거부하면 입력을 실패 처리하고 resource link로 자동 재전송하지 않는다.
- [x] 응답 중 제출한 image/audio snapshot과 metadata는 queue 및 앱 관리 저장소에 영속화되고, 실패한 입력이 참조하는 snapshot은 재시도를 위해 유지된다.
- [x] ACP prompt 요청이 성공적으로 기록되거나 사용자가 queued 입력을 삭제하면 더 이상 필요한 곳이 없는 snapshot bytes를 제거한다.
- [x] 파일시스템 저장과 SQLite queue 갱신 사이에 비정상 종료가 발생해도, 스레드 진입 시 해당 스레드에서 queue가 참조하지 않는 image/audio orphan snapshot만 제거한다.
- [x] 앱 시작 시 모든 스레드의 snapshot을 전역 검사하지 않고, 다른 스레드 및 queued/failed 입력이 참조하는 snapshot은 보존한다.
- [x] 전송된 입력과 다시 불러온 스레드 이력에는 bytes나 preview 없이 basename 기반 read-only Image/Audio chip이 표시된다.
- [x] snapshot 수명, clipboard 분기, picker 검증, ACP content block과 queue 복원을 자동화된 테스트로 검증한다.

## Comments

- ACP capability 전파, picker/clipboard snapshot, ordered content blocks, queue/retry 수명 관리, basename chip을 구현했다.
- 직접 전송 중인 media와 dispatch 중인 queued media도 SQLite에 참조를 유지해 비정상 종료 후 복원되며, 성공 응답 뒤 snapshot을 즉시 정리한다.
- `pnpm validate`, `cargo clippy --all-targets --all-features --locked -- -D warnings`, `cargo test --locked`로 검증했다.
