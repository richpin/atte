# 문서 안내

## 기능 동작

- [에이전트 설치본 실행](features/agent-execution.md)
- [Files 탭](features/files.md)
- [Git 패널](features/git-history.md)
- [데스크톱 알림](features/notifications.md)
- [Worktree와 스레드](features/worktrees.md)

## 기술 참조

- [로컬 DB 구조](reference/database.md)
- [SolidJS 구현 규칙](reference/solid.md)
- [Tauri 구현 규칙](reference/tauri.md)
- [아키텍처 결정 기록](adr/)

## 플랫폼과 배포

- Windows: [빌드](platforms/windows/build.md), [작업 흐름](platforms/windows/workflows.md), [검증 절차](platforms/windows/validation.md)
- 배포: [macOS](releases/macos.md), [Windows](releases/windows.md)

## 검증 기록

- [ACP 에이전트 설치·실행 검증 — 2026-11-10](testing/acp-agents-2026-11-10.md)

## 에이전트 작업 지침

- [도메인 문서 사용](agents/domain.md)
- [로컬 이슈 트래커](agents/issue-tracker.md)

기능의 동작·수명 규칙은 `features/`, 기술별 구현 규칙·데이터 구조는 `reference/`, 플랫폼별 빌드·검증 절차는 `platforms/`, 배포 절차는 `releases/`, 날짜가 있는 검증 결과는 `testing/`에 둔다. 설계 결정은 `adr/`, 코딩 에이전트의 작업 지침은 `agents/`, 문서 이미지는 `images/`에 둔다. `research/`는 Git에서 제외하는 임시 조사 자료다.
