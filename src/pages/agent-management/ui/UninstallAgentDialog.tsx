import { AlertDialog } from "@kobalte/core/alert-dialog";

export function UninstallAgentDialog(props: {
  name: string;
  disabled: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialog.Trigger
        disabled={props.disabled}
        aria-label={`${props.name} 삭제`}
        class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
      >
        삭제
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay class="fixed inset-0 z-40 bg-black/40" />
        <AlertDialog.Content class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,90vw)] -translate-x-1/2 -translate-y-1/2 space-y-4 rounded-2xl border border-line bg-panel p-6 text-ink shadow-xl">
          <AlertDialog.Title class="font-semibold">
            {props.name}을 삭제할까요?
          </AlertDialog.Title>
          <AlertDialog.Description class="text-sm text-muted">
            이 에이전트의 모든 연결과 진행 중인 작업을 종료하고 설치 파일을
            삭제합니다. 스레드 내용, 작업 폴더와 로그인 정보는 유지됩니다.
          </AlertDialog.Description>
          <div class="flex justify-end gap-3 text-sm">
            <AlertDialog.CloseButton
              aria-label="취소"
              class="rounded-lg border border-line px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
            >
              취소
            </AlertDialog.CloseButton>
            <AlertDialog.CloseButton
              aria-label="삭제 확인"
              class="rounded-lg bg-accent px-4 py-2 text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent"
              onClick={props.onConfirm}
            >
              삭제 확인
            </AlertDialog.CloseButton>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog>
  );
}
