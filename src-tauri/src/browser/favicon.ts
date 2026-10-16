// Read-only page metadata. No bridge, listeners, or page mutations are installed.
(() => {
  try {
    const icons = Array.from(document.querySelectorAll('link[rel~="icon" i][href]'))
      .filter((link) => !link.media || window.matchMedia(link.media).matches);
    const preferred = icons.findLast((link) => {
      const sizes = (link.getAttribute("sizes") || "").toLowerCase().split(/\s+/);
      return sizes.includes("any") || sizes.includes("32x32");
    });
    const icon = (preferred ?? icons.at(-1))?.href || new URL("/favicon.ico", window.location.href).href;
    return icon.length <= 65536 ? { url: window.location.href, icon } : null;
  } catch {
    return null;
  }
})()
