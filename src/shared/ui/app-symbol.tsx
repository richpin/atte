import type { JSX } from "solid-js";

export function AppSymbol(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      <title>Atte</title>
      <path d="M6 6.5C4.5 5 7.5 4 6 2M12 5.5C10.5 4 13.5 3 12 1M18 6.5C16.5 5 19.5 4 18 2" />
      <path d="m12 7.5 6.5 3.75v7.5L12 22.5l-6.5-3.75v-7.5L12 7.5Z" />
      <path d="m5.5 11.25 6.5 3.75 6.5-3.75M12 15v7.5" />
    </svg>
  );
}
