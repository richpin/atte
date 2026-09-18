# 로컬 DB 구조

현재 스키마: SQLite v4. Rust의 `Store`가 DB 접근과 트랜잭션을 소유하며 설치 관리와 대화 module이 같은 저장소를 공유한다. 파일 위치는 Tauri 앱 데이터 폴더의 `atte.sqlite`이며, macOS 기본 위치는 `~/Library/Application Support/com.atte.app/atte.sqlite`다. 별도 DB 서버는 없다.

## agents

Registry ID당 한 행에 목록 메타데이터와 현재 설치 정보를 함께 보관한다. 테이블 간 외래 키는 없다.

| 컬럼 | SQL 타입 | 의미 |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY NOT NULL | Registry 에이전트 ID |
| `registry_metadata` | TEXT, nullable | 이름·설명·아이콘·Registry 버전·배포 정보 JSON. 현재 Registry에 없으면 NULL |
| `installed_version` | TEXT, nullable | 실제 설치한 버전 |
| `artifact_path` | TEXT, nullable | 앱이 관리하는 설치 디렉터리 경로 |
| `launch_definition` | TEXT, nullable | 실행 정의 JSON: id, name, command, args, env |

설치 컬럼 세 개는 모두 NULL이거나 모두 값이 있어야 한다. 미설치 상태는 모두 NULL이다. 실제 파일 유무는 실행 가능 여부를 판단할 때 별도로 확인하므로 DB 기록만으로 설치 성공을 표시하지 않는다.

Registry 갱신은 `registry_metadata`만 트랜잭션으로 교체한다. 목록에서 사라져도 설치 정보가 있으면 행을 유지한다. 목록에도 없고 설치도 없는 행은 제거한다. 캐시 메타데이터 해석 실패가 유효한 설치 정보의 복원을 막지 않는다.

정상 설치에 대한 반복 설치 요청은 그대로 재사용한다. 배포 변경을 비교하는 `installation_source`는 없으며 자동 업데이트하지 않는다. 새 배포를 쓰려면 삭제 후 설치한다. 파일이 없거나 손상되어 재설치하는 경우에도 이전 연결과 남은 설치 파일을 먼저 정리한다.

## app_metadata

| 컬럼 | SQL 타입 | 의미 |
| --- | --- | --- |
| `key` | TEXT PRIMARY KEY NOT NULL | 메타데이터 이름 |
| `value` | TEXT NOT NULL | 값 |

현재 키는 `registry_fetched_at` 하나다. 마지막 정상 Registry 갱신의 Unix 초를 저장한다. 자동 갱신 시도는 메모리의 마지막 시도 시각으로 한 시간 간격을 제한하고, 재실행 시 저장된 정상 갱신 시각을 사용한다. 명시적 새로고침은 즉시 시도한다.

## 삭제와 실패 복구

대화 목록과 세션 참조는 설치 정보와 독립적으로 보존한다. 목록을 읽기 위해 에이전트 프로세스나 작업 폴더가 존재할 필요는 없다.

1. 삭제 위치가 앱의 설치 디렉터리인지 검사한다. 공용 `agents/runtime`과 외부 경로는 거부한다.
2. 새 대화 선택에서 제외하고 해당 에이전트의 모든 연결·작업을 종료한다. 프로세스 종료를 기다린 뒤 파일 삭제를 시작한다. 다른 에이전트는 영향을 받지 않는다.
3. 설치 디렉터리를 즉시 삭제한다. 심볼릭 링크는 대상을 따라가지 않고 링크 자체만 제거한다.
4. 성공하면 설치 컬럼을 NULL로 바꾼다. Registry에 남아 있는 행은 재설치를 위해 유지한다.

파일 삭제 실패 시 설치 정보는 남고 UI에서 삭제 재시도를 할 수 있다. 연결은 이미 종료되었을 수 있다. 파일 삭제 후 DB 반영 전 앱이 종료되면 다음 실행에서 설치 파일 없음으로 표시하며 삭제를 다시 시도하거나 재설치할 수 있다. 없는 경로의 삭제는 성공으로 취급한다. 별도 삭제 대기 테이블이나 재시작 시의 정상 삭제 작업은 없다.

삭제된 설치를 사용한 대화의 표시 내용은 현재 앱 메모리에 남고, 대화 메타데이터와 세션 참조는 DB에 남는다. 이전 실행 정의로 재연결하지 않으며 재설치 후 현재 설치 정의로 명시적으로 load/resume을 재시도한다. 에이전트의 기존 세션이 사라졌거나 재개 미지원이면 실패 이유를 표시한다. 작업 폴더·공용 Node·공급자 로그인 정보와 에이전트 소유 세션 기록은 삭제 대상으로 삼지 않는다.

## conversations

| 컬럼 | SQL 타입 | 의미 |
| --- | --- | --- |
| `id` | TEXT PRIMARY KEY NOT NULL | Atte가 발급한 대화 UUID |
| `metadata` | TEXT NOT NULL | `ConversationMetadata` JSON: 제목, 작업 폴더, 고정 에이전트 ID, 원격 세션 ID, 생성·수정 Unix 초, 마지막 상태·오류, 중단 여부와 대화 ID |
| `queued_messages` | TEXT NOT NULL DEFAULT '[]' | 제출 순서의 `{id, text}` JSON 배열 |

메타데이터 저장 interface는 본문을 포함하지 않는 `ConversationMetadata`만 받고 `metadata`만 갱신한다. 큐 저장은 `queued_messages`만 갱신하며, 대화 행이 아직 없으면 메타데이터와 함께 생성한다. 전송된 메시지 본문·도구 출력·승인 이력·실행 핸들·인증 정보는 이 테이블에 저장하지 않는다. 제목은 첫 메시지의 앞 60자를 사용한다. 대화 생성과 상태 변경 시 메타데이터를 저장하고, 응답 텍스트 delta는 메모리에만 반영한다. 저장 오류는 현재 대화 상태의 `storageError`로 표시한다.

재실행 시 메타데이터로 목록을 만들고 연결 상태는 `disconnected`로 복원한다. 이전 실행 중·승인 대기·중단 처리 상태는 중단 여부로 남기며 승인 조작이나 prompt를 되살리지 않는다. 사용자가 대화를 선택하면 `session/load`를 우선 사용하고 전체 replay 성공 후 메모리의 본문을 교체한다. 실패한 부분 replay는 표시하지 않는다. `resume`만 지원하면 본문 없이 기존 맥락을 이어간다는 안내를 표시한다. 에이전트 부재 시 전체 본문을 읽을 수 있는 디스크 사본은 없다.

### 대화 행의 대기열

각 대화 행의 `queued_messages` 컬럼에 미전송 입력을 보관한다. Rust 대화 상태의 잠금 안에서 추가·삭제·전송을 위한 제거를 직렬화하고, 저장 성공 후 메모리와 UI에 반영한다. 배열 순서가 FIFO이며 별도 순서 번호나 전송 상태 테이블은 없다. 빈 대기열은 `[]`로 저장하고 대화 행은 유지한다.

현재 turn의 `end_turn` 응답에서만 다음 항목을 제거 저장한 뒤 전송한다. 취소 의도가 있거나 비정상 종료한 turn은 다음 항목을 보내지 않는다. 전송 시도 기록·결과 불명 상태·자동 재삽입·자동 재전송은 없다. 제거 저장과 실제 전송 사이의 비정상 종료에서는 해당 항목이 유실될 수 있다. 남은 대기열은 재실행·load/resume 이후에도 유지하며 복원 자체로 전송하지 않는다. 이 데이터는 Atte 소유 입력이며 에이전트 대화 본문의 사본이 아니다.

## 초기 스키마와 버전

agents 중심 구조가 첫 제품 스키마 v1이다. 새 DB는 `001_agents.sql`, `002_conversations.sql`, `003_queued_messages.sql`, `004_conversation_queue_column.sql`을 순서대로 적용해 v4로 초기화한다. v4는 기존 `conversation_queues`의 메시지 배열을 해당 대화 행으로 옮긴 후 큐 테이블을 제거한다. 기존 DB는 현재 버전 이후의 마이그레이션만 적용하며 설치 산출물·버전·Registry 메타데이터·대화 메타데이터를 보존한다. 초기화와 마이그레이션은 하나의 트랜잭션이고 `PRAGMA user_version = 4`을 기록한다. 지원 버전보다 새 DB는 열지 않는다.

제품 스키마 도입 전 개발용 v1–v4 변환 경로는 제거했다. 당시 agents-only 개발용 v4를 백업·구조 확인 후 v1로 맞추던 일회성 절차는 현재 제품 v4에 적용하지 않는다. 현재 v4에는 대화와 대기열 컬럼이 있으며 버전 번호를 낮추지 않는다. 옛 installations 기반 개발 DB는 제품 스키마와 호환되지 않는다.

정의: [v1 SQL](../src-tauri/migrations/001_agents.sql), [v2 SQL](../src-tauri/migrations/002_conversations.sql), [v3 SQL](../src-tauri/migrations/003_queued_messages.sql), [v4 SQL](../src-tauri/migrations/004_conversation_queue_column.sql), [저장소](../src-tauri/src/storage.rs), [대화 interface](../src-tauri/src/conversation.rs), [삭제 처리](../src-tauri/src/agent_management/removal.rs).

## 새로고침과 설치의 갱신 범위

| 동작 | registry_metadata | launch_definition 및 설치 컬럼 |
| --- | --- | --- |
| Registry 새로고침 성공 | 검증된 최신 항목으로 교체 | 유지 |
| 새로고침 실패 | 이전 값 유지 | 유지 |
| 설치 성공 | 유지 | 실제 설치 결과로 기록 |
| 정상 설치에 대한 중복 설치 요청 | 유지 | 기존 값 유지 |
| 삭제 성공 | Registry에 있는 항목이면 유지 | NULL로 비움 |

목록 갱신은 모든 행의 Registry 메타데이터를 비운 뒤 받은 항목들을 ID 기준으로 반영하며, 이 과정 전체와 갱신 시각 저장이 하나의 트랜잭션이다. Registry에서 빠진 항목은 설치되어 있으면 메타데이터 없이 남고, 미설치이면 행을 삭제한다. 새로고침은 실행 중인 프로세스나 기존 대화의 실행 정의를 바꾸지 않는다. 예를 들어 Registry의 패키지가 2.0으로 바뀌어도 설치된 1.0은 그대로 실행하며, 2.0을 쓰려면 삭제 후 설치한다.
