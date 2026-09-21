# Stage immutable agent installations and drain runtimes before activation

Atte는 Registry 에이전트 업데이트를 `agents/<agent-id>/<installation-id>/`의 불변 설치본으로 완성·검증하고, 기존 `agents` 행의 active 설치 정보와 단일 `pending_artifact_path`를 SQLite의 유일한 selector로 사용한다. 새 설치본이 준비되면 해당 에이전트에서 새 turn을 시작하지 않고 진행 중인 turn만 마친 뒤 모든 구버전 프로세스를 종료·reap한 다음 active를 원자적으로 전환한다. 이 구조는 실행 중 파일을 교체하거나 같은 에이전트의 새 작업을 서로 다른 버전으로 시작하지 않으면서도, 앱 재시작을 기다리지 않고 업데이트를 적용하기 위한 선택이다.

설치본별 테이블·행, `current` symlink와 역할 manifest는 만들지 않는다. 각 설치본의 `installation.json`은 승격·비교·실행에 필요한 최소 불변 정보만 담고, 전환 후 구버전과 crash로 남은 미참조 디렉터리는 별도 best-effort 정리로 제거한다.
