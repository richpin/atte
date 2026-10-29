# Issue tracker: Local Markdown

명세와 작업은 로컬 `.scratch/`의 Markdown 파일로 관리한다. 별도의 triage 절차나 라벨 매핑은 사용하지 않는다.

## Conventions

- 기능별 디렉터리: `.scratch/<feature-slug>/`
- 명세: `.scratch/<feature-slug>/spec.md`
- 작업: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- 독립적인 검증 작업은 내용이 작업 파일에 모두 담기면 별도 `spec.md`를 생략한다.
- 작업 번호는 01부터 시작하며, 작업마다 별도 파일을 만든다.
- 스킬이 `ready-for-agent` 라벨을 요구하면 문서 상단에 `Status: ready-for-agent`를 기록한다. 이는 구현에 착수할 만큼 명세가 정리됐다는 뜻이며, 자동 실행이나 구현 완료를 의미하지 않는다.
- 선행 작업이 있으면 `Blocked by:`에 해당 작업 파일의 상대 경로로 기록한다.
- 진행 기록과 논의는 파일 하단의 `## Comments`에 추가한다. 완료 시 검증 결과와 완료 사실을 남긴다.
- `.scratch/`는 Git에서 제외한다.
- 완료된 작업의 현재 규칙과 설계 결정은 `CONTEXT.md`와 `docs/`에 반영한 뒤 오래된 명세·논의·검증 기록을 삭제한다. 미완료 작업은 남은 내용만 유지한다.

## Skill operations

스킬의 “이슈 트래커에 게시”는 해당 경로에 파일을 작성하는 것을 뜻한다.
“작업 조회”는 지정된 작업 파일을 읽는 것을 뜻한다.
외부 이슈 트래커에는 게시하지 않는다. GitHub Issues로의 전환은 사용자가 요청할 때 진행한다.
