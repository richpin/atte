# 첫 버전 인수 검증

검증일: 2026-09-18. 대상: macOS 26.6.2 / Apple Silicon, Tauri 2.11.5, ACP SDK 2.1.0, Codex ACP 1.12.0. 아래 자동 검증과 네이티브 화면 검증은 구분한다.

## 수명주기 설계 근거

- [Apple: Quit apps on Mac](https://support.apple.com/en-ae/guide/mac-help/mchl834d18c2/mac): 마지막 창 닫기는 앱 종료와 구분한다. 창은 파괴하고 구독을 해제하되 Rust 스레드 상태와 연결을 유지한다. Dock 재열기는 설정에서 새 창을 만들고 기존 스레드 선택 시 현재 상태와 후속 스트림을 구독한다.
- [Tauri RunEvent](https://docs.rs/tauri/2.11.5/tauri/enum.RunEvent.html): 마지막 창 파괴로 발생하는 `ExitRequested`는 macOS에서 막는다. 명시적인 프로그램 종료는 확인창 없이 정리 경로로 보낸다.
- [Tauri #12978](https://github.com/tauri-apps/tauri/issues/12978), [Apple applicationShouldTerminate](https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldterminate(_:)): Tauri 2.11.5/Tao 0.35.3의 기본 Quit 메뉴와 Dock 종료는 `ExitRequested`를 우회한다. 기존 Tao delegate를 유지하면서 미구현된 AppKit 표준 메서드를 추가한다. 비동기 정리가 끝나기 전에는 네이티브 종료를 취소하고 정리가 끝나면 `AppHandle::exit`로 나간다.
- 앱 종료 요청은 확인창 없이 미해결 승인과 active turn을 취소하고 메타데이터를 저장한다. 응답 완료를 기다리거나 이미 수행된 변경을 되돌리지 않는다. 미전송 큐는 보존한다.
- 인증·Registry 갱신 명령은 종료 신호를 받으면 future를 내려 관리 대상 프로세스 guard가 실행되게 한다. 설치·삭제는 이미 소유한 파일·프로세스 정리를 끝내도록 기다린다. 설치의 다운로드·하위 명령은 기존 timeout을 적용한다. 스레드는 ACP 취소 응답에 최대 1초를 허용하고 런타임 전체 정리에는 공통 5초 제한을 둔다.
- macOS 강제 정리는 직접 생성한 프로세스 그룹과 그 살아 있는 하위 프로세스에 한정한다. Codex MCP 서버처럼 별도 그룹을 만든 하위 프로세스도 포함한다. 부모부터 일시 정지한 뒤 libproc로 자식을 조회하고 아래에서 위로 종료하여 정리 도중 새 자식 생성과 부모 종료에 따른 추적 손실을 줄인다. 실제 정지 상태 확인은 전체 250ms로 제한하며 조회 실패·시간 초과 시 하위 프로세스 조회와 그룹 종료를 계속한다. [Apple libproc 구현](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c)의 `proc_listchildpids`는 PID 개수를 반환한다.

## 자동 검증

- `CHOKIDAR_USEPOLLING=1 pnpm validate`: Biome, FSD, TypeScript 검사 및 프론트엔드 40개 테스트 통과. 기본 FSD 실행은 환경의 파일 감시 제한으로 `EMFILE`이 발생해 polling으로 실행했다.
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`: 70개 통과, 실연결 4개 기본 제외.
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings`: 통과.
- `cargo +nightly fmt --manifest-path src-tauri/Cargo.toml -- --check`: 통과.
- `pnpm tauri build --bundles app`: production macOS 앱 빌드 통과.
- 기존 로그인 및 Registry로 설치된 Codex ACP 1.12.0을 `ATTE_CODEX_ACP`로 지정하고 `real_codex` 테스트 4개를 순차 실행하여 모두 통과했다. 각 테스트는 `tempfile`의 별도 임시 작업 폴더를 쓴다. 초기화, 연속 스트리밍, 동시 스레드·승인·취소 격리, 프로세스/Core 재시작 후 에이전트 본문 복원과 실제 맥락 재개를 확인했다. 샌드박스 내 첫 시도는 초기화 실패했고, 세션 저장과 네트워크 접근이 가능한 실행에서 통과했다.
- 새 `shutdown_stops_all_work_and_restores_queues_without_dispatch`: 같은 연결의 실행 중·승인 대기 스레드를 함께 종료하고, turn 취소·늦은 전송 거부·큐 영속 복원·load 후 자동 실행 억제를 확인한다.
- `restart_of_an_approval_wait_restores_only_metadata_without_replaying_the_decision`에 종료 직후 turn 종료 사유와 승인 해소 검증을 추가했다. 기존 코드의 `stop_reason: None`으로 실패를 확인한 뒤 수정했다.
- `shutdown_delivers_turn_and_permission_cancellation_before_reaping`: fixture가 `session/cancel`, pending/late permission의 cancelled 응답을 실제 수신했음을 검증한다. 강제 종료만 하던 코드에서 실패한 뒤 ACP 취소 유예를 추가하여 통과했다.
- `shutdown_reaps_descendants_that_create_their_own_process_group`: EOF를 무시하고 별도 그룹의 자식을 남기는 에이전트가 종료 후 남지 않는지 확인한다. 기존 그룹 종료만으로는 실패했고 macOS 하위 프로세스 정리 후 통과했다.

## 사용자 스토리별 근거

테스트 이름은 `src-tauri/tests/` 또는 `src/app/App.test.tsx`의 실제 테스트를 가리킨다. 아래 표의 자동 검증은 모두 실행했다. 화면 배치와 네이티브 OS 동작의 관찰 여부는 다음 절에 별도로 기록한다.

| 스토리 | 구현 | 자동 검증 근거 |
| --- | --- | --- |
| 1, 7 | ThreadPage, AgentManagementPage | `keeps the saved list accessible without agents and restores on selection only`, `returns from setup to the same thread and resumes only after an explicit retry` |
| 2, 3 | agent_management/registry, installer | `registry_selects_platform_binary_or_npm_and_excludes_other_agents`, `supported_binary_formats_preserve_registry_launch_metadata_and_restore` |
| 4, 5, 6 | 관리 화면·authentication | `connects the fixed agent and displays backend readiness separately from authentication`, `authentication_uses_advertised_metadata_without_provider_or_method_assumptions`, `retries a failed install and offers the installed agent without restarting` |
| 8, 9, 10 | create_for_agent, select_working_folder | `creates_a_local_draft_that_can_be_retrieved`, `keeps the existing thread's agent fixed when selecting a target for the next one` |
| 11, 12, 13, 14 | ThreadSidebar, ThreadPage | `groups threads by folder, collapses projects and creates within the selected folder`, `returns from project setup to create in the original folder` |
| 15 | agent_runtime, Transcript | `streams_ordered_turns_and_sends_followups_in_the_same_session`, `appends each text delta once and rejects updates for another thread`, 실제 Codex 스트리밍 |
| 16, 17, 18 | Transcript, ThreadPage의 메시지·헤더 배치 | `sends once, renders streaming text and completion, and admits the next message`; 정확한 배치는 화면 검증 대상 |
| 19, 20 | 목록 구독·관리 화면에서도 유지되는 스레드 페이지 | `list_subscription_tracks_background_thread_status`, `keeps streaming and the fixed thread while management is open` |
| 21, 22, 23, 37 | agent_runtime의 세션별 라우팅 | `shared_connection_isolates_sessions_permissions_and_cancellation`, 실제 Codex 동시 스레드 테스트 |
| 24 | cancel_turn | `cancels_only_the_active_turn_and_continues_the_same_session` |
| 25, 26 | send_message, complete_turn | `queues_followups_and_dispatches_them_in_fifo_order_after_completion`, `cancellation_intent_prevents_queue_dispatch_even_when_completion_wins_on_the_agent` |
| 27, 28, 29 | delete_queued_message, QueuedMessages | `queues input above the composer and preserves it after stopping until deleted`, `restores_queued_messages_in_order_and_keeps_the_thread_after_deletion` |
| 30, 31, 32, 33, 34 | PermissionPanel | `replaces the composer with agent choices and restores the draft after one decision`, `permission_preserves_agent_choices_and_answers_exactly_once`; 정렬은 화면 검증 대상 |
| 35, 36 | answer_permission, cancel_turn | `cancelling_permission_resolves_pending_and_late_requests_without_execution`, `unexpected_permission_requests_are_cancelled_without_blocking_setup` |
| 38, 39 | with_store, agent_runtime/replay | `restores_agent_history_after_restart_without_persisting_a_transcript`, 실제 Codex 재시작·본문·맥락 테스트 |
| 40 | load/resume capability 처리 | `resume_only_restores_context_with_an_explicit_no_history_notice`, `failed_restoration_keeps_the_reference_and_never_exposes_partial_replay` |
| 41 | 목록 저장과 인증의 분리 | `restores_the_list_without_an_installed_agent_or_a_working_folder`, `all_targets_authenticate_then_retry_the_same_thread_after_expiry` |
| 42, 43 | failed 상태·명시적 재시도 | `distinguishes_connection_failures_and_keeps_the_draft_for_explicit_retry`, `shows process exit after readiness without reconnecting automatically` |
| 44 | lifecycle::on_event, reopen, 구독 수명 | `resubscription_is_coherent_and_detaching_does_not_stop_a_turn`, `ignores updates after unmount and unsubscribes even when registration finishes late`; 창 조작은 네이티브 검증 대상 |
| 45 | lifecycle::request_quit, macos bridge | 실행·승인 대기 중 확인창 없는 종료는 네이티브 검증 대상 |
| 46 | shutdown, ProcessGroup, lifecycle 명령 추적 | `shutdown_reaps_the_adapter_and_stops_its_descendants`, `shutdown_waits_for_processes_being_removed`, `shutdown_stops_all_work_and_restores_queues_without_dispatch` |
| 47 | interrupted 저장, 큐 자동 실행 억제 | `restart_of_an_approval_wait_restores_only_metadata_without_replaying_the_decision`, `cancelled_queue_survives_restart_and_load_without_sending` |
| 48 | metadata, SQLite v1, 프로젝트별 목록 | `restores_queued_messages_in_order_and_keeps_the_thread_after_deletion`, `groups threads by folder, collapses projects and creates within the selected folder` |
| 49 | 전체 경로 | 실제 Codex 자동 검증 4개 통과; Registry 설치부터 종료·재실행까지 네이티브 연속 검증은 아래 기록 참조 |
| 50 | 공통 Registry·ACP·capability 경로 | `unknown_registry_agent_survives_offline_restart_and_registry_removal`, `all_targets_authenticate_then_retry_the_same_thread_after_expiry`; Claude·Antigravity 인증된 실사용은 사용자 후속 검증 |

## 네이티브 검증

기존 `com.atte.app`의 개발 데이터는 `user_version=4`이므로 현재 v1 전용 초기 스키마 정책에 따라 열 수 없다. 기존 데이터를 변경하지 않고 `/private/tmp/atte-08-config.json`으로 식별자 `com.atte.lifecycleacceptance`, 제품명 `Atte Acceptance`인 별도 production 앱을 빌드했다. 작업 폴더는 `/private/tmp/atte-08-lifecycle-work`다. 설치는 실제 Registry의 Codex ACP 1.12.0, 하위 Codex CLI 0.154.0이다.

최초 구현에서 확인한 흐름(5·6번의 종료 확인창은 이후 정책 변경으로 제거, 변경 후 검증은 아래 별도 기록):

1. 빈 목록에서 관리 화면 → 공식 Registry 로드 → Codex 설치 → ACP 연결 및 API Key/ChatGPT 인증 방법 안내. 기존 로그인으로 첫 메시지가 성공한 뒤 관리 화면의 인증 완료 상태를 확인했다.
2. 네이티브 폴더 선택창으로 별도 폴더를 지정하고 첫 스레드를 생성했다. `ATTE-08-NATIVE-7319` 응답과 작업 중 대기 메시지의 정상 완료 후 전송을 확인했다.
3. 실행 중 마지막 창을 닫아도 앱은 유지됐다. 다시 생성된 창의 목록에서 같은 스레드를 열어 진행 결과를 확인했다. 승인 대기 상태에서도 창 닫기 후 앱 inventory는 `isRunning: true`, 재열린 목록은 같은 승인 대기를 표시했다.
4. 승인 시나리오 재현을 위해 격리 앱의 Codex 실행 정의에만 `INITIAL_AGENT_MODE=read-only`를 지정했다. 사용자 공용 Codex 설정·로그인은 변경하지 않았다. 두 번째 스레드에서 `awaiting.txt` 쓰기 승인을 요청하고 대기 메시지를 남겼다. 승인 선택지·내용·폴더가 표시되며 자동 승인되지 않았다.
5. 승인 대기 중 Cmd+Q → 스레드 제목과 승인 대기가 표시된 네이티브 확인창 → 계속 작업. 승인 요청과 큐가 그대로 유지됐다. 별도 스레드에서 첫 marker를 재질문하여 실제 맥락 응답을 받았고, 응답 중 관리 화면 이동도 작업을 중단하지 않았다.
6. 다시 Cmd+Q → 작업 중단 후 종료. 앱 inventory의 `isRunning: false`와 격리된 Codex 경로를 사용하는 프로세스 부재를 확인했다.
7. 앱 재실행 → 두 스레드의 제목·프로젝트 목록 표시 → 중단된 스레드 선택 → 에이전트에서 본문 복원. 중단 안내, 보존된 대기 메시지, 승인 UI 해소, 새 입력이 가능한 상태를 확인했다. 대기 메시지와 중단된 작업은 자동 실행되지 않았다.
8. 실제 화면에서 사용자 말풍선, 에이전트 본문, 한 줄 헤더, 입력창 위 대기 메시지, 말줄임·펼침, 오른쪽 삭제 버튼, 프로젝트 +, 사이드바 닫기·열기를 확인했다. 진행 중 작업이 없을 때에는 확인 없이 종료됐다.
9. 격리 앱의 설치 폴더를 일시적으로 옮겨 설치 불가 상태를 재현했다. 재실행 후 두 스레드의 목록과 미전송 큐에 접근할 수 있었고, 선택한 스레드는 설치 필요 안내·관리 화면 이동·다시 연결 조작을 표시했다. 설치 폴더를 원래 위치로 복구하고 재실행해 Codex 선택 가능 및 스레드 선택 후 연결 시작까지 확인했다. Mac 잠금 해제 후 같은 앱에서 기존 스레드를 선택해 세션 준비 완료와 본문·중단 안내 복원을 최종 확인했다. 입력란에 검증 문구를 넣자 전송 버튼이 활성화됐으며, 전송하지 않고 지웠다. 기존 대기 메시지는 대기 영역에 그대로 남았고 자동 전송이나 승인 재실행은 발생하지 않았다. 설치 복구 후 사용자 선택에 따른 연결 완료까지 네이티브 검증을 통과했다.

최초 구현의 종료 확인창은 이후 사용자 결정으로 제거했다. 현재 종료 경로는 창을 다시 열거나 확인창을 표시하지 않고 정리를 시작한다.

Claude·Antigravity의 인증된 실사용, 실제 사용자 로그인 만료를 유발하는 검증은 수행하지 않았다. 공통 capability/인증 만료·재시도 경로는 Rust/프론트엔드 테스트로 확인했으며 두 에이전트의 인증된 실사용은 명세대로 사용자 후속 검증이다.

### 확인창 없는 종료 정책 재검증

- 변경 후 `sh scripts/validate-rust.sh`로 포맷·Clippy·Rust 테스트 70개가 통과했다. 종료 관련 공개 인터페이스 테스트 5개도 통과했다. 기존 실연결 4개와 프론트엔드 40개 통과 기록은 최초 구현 기준이며 이번에는 재실행하지 않았다.
- 격리 설정으로 production 앱을 다시 빌드했다. 새 스레드에서 Codex에 `sleep 90` 실행을 요청하고 응답 중 대기 메시지 `ATTE-08-NO-CONFIRM-QUEUE`를 추가했다. Cmd+Q 한 번으로 추가 확인 없이 종료됐고, 앱 inventory에서 앱이 사라졌으며 격리 Codex 경로와 `sleep 90` 프로세스가 남지 않았음을 확인했다.
- 재실행을 시도했으나 화면 제어 도구가 Mac 잠금을 보고했다. 변경된 앱에서 재실행 후 큐 보존 및 승인 대기 중 확인창 없는 종료의 네이티브 재검증은 대기 중이다. 해당 취소·복원 동작의 자동 테스트는 통과했다.

## 코드 리뷰

최초 구현은 Standards와 Spec을 별도 에이전트로 검토했다. 설치·삭제 중 정리 소유권 유지, ACP 취소 전달 후 종료, 설치 명령 timeout 시 하위 프로세스 정리 순서, SIGSTOP 전달 후 정지 상태 관찰에 관한 지적을 수정했다. 당시 최종 재검토에서 Standards 0건, Spec 0건이다. 이후 확인창 제거 변경은 종료 요청 중복 방지, 정리 시작 시 명령 차단, 기존 프로세스 정리 유지 및 명세 일치를 직접 검토했다.
