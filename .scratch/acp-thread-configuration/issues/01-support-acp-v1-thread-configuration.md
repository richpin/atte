# 01: ACP v1 스레드 설정을 end-to-end로 지원한다

**What to build:** 에이전트가 ACP v1 `configOptions`로 제공한 스레드 설정을 연결·복원·작업 상태 전반에서 표시하고 변경할 수 있게 한다. 사용자는 입력창 하단에서 모델·추론 수준·동작 모드를 바로 선택하고, 그 밖의 지원 설정은 스레드 설정 popover에서 사용할 수 있다. Atte는 에이전트가 제공한 이름, 설명, 순서, 선택지와 현재값을 그대로 따르며 특정 에이전트의 설정을 하드코딩하지 않는다.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] ACP 초기화에서 boolean config option 지원을 광고하고, 새 스레드의 초기 전체 configuration snapshot을 스레드 구독으로 전달한다.
- [ ] load와 resume으로 복원한 스레드도 에이전트가 응답한 전체 configuration snapshot을 사용하며 Atte의 별도 기본값을 적용하지 않는다.
- [ ] idle과 active turn 중 받은 `config_option_update`를 해당 스레드의 전체 snapshot 교체로 반영하고 다른 스레드의 update는 격리한다.
- [ ] flat select, grouped select, boolean을 opaque ID와 typed value를 보존하는 범용 도메인 모델로 전달한다.
- [ ] `model`, `thought_level`, `mode` category는 입력창 하단의 compact control로 제공하고 나머지 또는 알 수 없는 category는 스레드 설정 popover에서 제공한다.
- [ ] 에이전트가 제공한 option 순서, 이름, 설명과 그룹을 보존하며 select와 boolean control을 키보드 및 screen reader로 조작할 수 있다.
- [ ] 사용자가 설정을 선택하면 프롬프트 전송과 독립된 mutation command가 정확한 config ID와 값을 에이전트에 전달하고, 성공 응답의 전체 snapshot이 구독을 통해 UI에 반영된다.
- [ ] mutation command는 snapshot을 반환하지 않고 성공 또는 실패만 반환하며, 프런트엔드가 command 응답으로 별도의 thread configuration 상태를 만들지 않는다.
- [ ] config options가 없으면 설정 UI를 표시하지 않고, ACP 세션이 연결 중일 때 이전 연결의 값을 현재 설정처럼 표시하지 않는다.
- [ ] 알 수 없는 future option kind는 연결이나 스레드를 실패시키지 않고 해당 control만 생략하며 다른 지원 옵션은 계속 사용할 수 있다.
- [ ] deprecated ACP modes, agent별 하드코딩, 자동 permission 응답, 설정 기본값 저장 또는 데이터베이스 변경을 추가하지 않는다.
- [ ] deterministic ACP fixture를 사용하는 Rust 통합 테스트가 초기화, new/load/resume, agent update, 설정 변경 round trip과 스레드 격리를 검증한다.
- [ ] SolidJS 앱 수준 테스트가 compact control, popover, grouped select, boolean, 설명, 접근성, 연결 상태와 subscription 기반 갱신을 사용자 관점에서 검증한다.
