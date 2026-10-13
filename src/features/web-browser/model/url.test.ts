import { expect, it } from "vitest";
import { normalizeWebAddress } from "./url";

it.each([
  ["https://example.com/docs", "https://example.com/docs"],
  [" example.com ", "https://example.com/"],
  ["example.com:8080/path", "https://example.com:8080/path"],
  ["localhost:3000", "http://localhost:3000/"],
  ["127.0.0.1:8000", "http://127.0.0.1:8000/"],
  ["[::1]:9000", "http://[::1]:9000/"],
  ["http://example.com", "http://example.com/"],
])("normalizes %s into %s", (value, expected) => {
  expect(normalizeWebAddress(value)).toBe(expected);
});

it.each([
  "",
  "search terms",
  "javascript:alert(1)",
  "file:///tmp/test",
  "tauri://localhost",
  "https://",
  "https://[invalid]",
])("rejects %s", (value) => {
  expect(normalizeWebAddress(value)).toBeUndefined();
});
