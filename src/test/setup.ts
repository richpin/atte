Object.defineProperties(navigator, {
  language: { configurable: true, value: "ko-KR" },
  languages: { configurable: true, value: ["ko-KR", "ko", "en-US"] },
});

// JSDOM does not implement layout APIs used by contenteditable selection.
Range.prototype.getBoundingClientRect = () => new DOMRect();
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
document.elementFromPoint = () => document.body;
window.scrollTo = () => {};
