import { onMount } from "solid-js";
import "./file-icon.css";

// Share the Files tree's lazy-loaded module rather than pulling it into app startup.
const loadIcons = () => import("@pierre/trees");
let icons: Promise<Awaited<ReturnType<typeof loadIcons>>> | undefined;
let resolver:
  | ReturnType<
      Awaited<ReturnType<typeof loadIcons>>["createFileTreeIconResolver"]
    >
  | undefined;

function iconLibrary() {
  icons ??= loadIcons().then((library) => {
    const sprite = document.createElement("div");
    sprite.hidden = true;
    // Trusted, bundled library SVG. The app shares one sprite across all file icons.
    sprite.innerHTML = library.getBuiltInSpriteSheet("complete");
    document.body.append(sprite);
    resolver = library.createFileTreeIconResolver({
      set: "complete",
      colored: true,
    });
    return library;
  });
  return icons;
}

export function hydrateFileIconElement(svg: SVGSVGElement, path: string) {
  if (
    svg.dataset.iconPath === path &&
    svg.querySelector("use")?.hasAttribute("href")
  )
    return;
  svg.dataset.iconPath = path;
  void iconLibrary().then(() => {
    if (svg.dataset.iconPath !== path) return;
    const icon = resolver?.resolveIcon("file-tree-icon-file", path);
    if (!icon) return;
    svg.dataset.iconToken = icon.token;
    svg.setAttribute("viewBox", icon.viewBox ?? "0 0 16 16");
    svg.querySelector("use")?.setAttribute("href", `#${icon.name}`);
  });
}

export function createFileIconElement(path: string, size = "size-4") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `file-type-icon ${size} shrink-0`);
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.append(document.createElementNS("http://www.w3.org/2000/svg", "use"));
  hydrateFileIconElement(svg, path);
  return svg;
}

export function FileIcon(props: { path: string; size?: string }) {
  let svg!: SVGSVGElement;
  onMount(() => {
    hydrateFileIconElement(svg, props.path);
  });
  return (
    <svg
      ref={svg}
      aria-hidden="true"
      class={`file-type-icon ${props.size ?? "size-4"} shrink-0`}
      viewBox="0 0 16 16"
    >
      <use />
    </svg>
  );
}
