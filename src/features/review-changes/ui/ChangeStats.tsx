export function ChangeStats(props: {
  additions: number | null;
  deletions: number | null;
}) {
  return (
    <span class="inline-flex shrink-0 gap-2 font-mono text-xs tabular-nums">
      <span class="text-response-success">
        {props.additions === null ? "—" : `+${props.additions}`}
      </span>
      <span class="text-danger">
        {props.deletions === null ? "—" : `−${props.deletions}`}
      </span>
    </span>
  );
}
