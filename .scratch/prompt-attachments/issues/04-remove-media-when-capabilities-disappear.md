# 04: capability 소실 시 미디어 첨부를 정리한다

**What to build:** 재연결된 에이전트가 image 또는 audio capability를 더 이상 제공하지 않으면 지원하지 않는 내용 첨부를 draft와 queue에서 조용히 제거하여, 현재 capability로 실제 전송할 수 있는 사용자 입력만 남긴다.

**Blocked by:** [03: 이미지와 오디오를 내용 첨부로 전송한다](./03-send-images-and-audio-as-content-attachments.md).

**Status:** done

- [x] 최신 capability가 적용되면 `+` 메뉴에서 지원하지 않는 Image 또는 Audio 선택지가 사라진다.
- [x] capability가 사라진 media의 draft 첨부를 별도 notice나 오류 없이 제거하고 관련 snapshot bytes도 즉시 삭제한다.
- [x] capability가 사라진 media의 queued 첨부를 원본 경로 확인이나 resource link 변환 없이 제거하고 관련 snapshot bytes도 즉시 삭제한다.
- [x] queued 입력에 메시지 본문이나 다른 첨부가 남으면 남은 사용자 입력만 정상 전송한다.
- [x] queued 입력이 완전히 비면 해당 입력을 삭제하고 다음 입력의 queue 진행을 계속한다.
- [x] 지원이 유지되는 media와 모든 경로 첨부는 capability reconciliation의 영향을 받지 않는다.
- [x] draft, 일부가 남는 queued 입력, 완전히 비는 queued 입력과 snapshot 정리를 자동화된 테스트로 검증한다.

## Comments

- 연결된 세션의 최신 capability를 적용할 때 대기 입력을 영속적으로 정리한 뒤 해당 snapshot을 삭제하고, 비어 사라진 실패 입력 뒤의 queue를 진행한다.
- 구독된 capability 변경으로 draft media를 정리하고 선택 도중 capability가 사라진 결과도 즉시 반환한다.
- `pnpm validate`, `cargo test --locked`, `cargo clippy --all-targets --all-features --locked -- -D warnings`로 검증했다.
