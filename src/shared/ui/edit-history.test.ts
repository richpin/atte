import { afterEach, expect, it, vi } from "vitest";
import { bindEditHistory } from "./edit-history";

afterEach(() => document.body.replaceChildren());

function command(target: HTMLElement, action: string) {
  return target.dispatchEvent(
    new CustomEvent("atte-edit-history", {
      detail: action,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

it("routes history from the focused shadow editor and consumes empty histories", () => {
  const host = document.createElement("div");
  const editor = document.createElement("div");
  host.attachShadow({ mode: "open" }).append(editor);
  document.body.append(host);
  const run = vi.fn();
  const stop = bindEditHistory(host, run);
  expect(command(editor, "undo")).toBe(false);
  expect(command(editor, "redo")).toBe(false);
  expect(run.mock.calls).toEqual([["undo"], ["redo"]]);
  stop();
  expect(command(editor, "undo")).toBe(true);
  expect(run).toHaveBeenCalledTimes(2);
});

it("leaves editor search fields to the native responder", () => {
  const host = document.createElement("div");
  const search = document.createElement("input");
  host.attachShadow({ mode: "open" }).append(search);
  document.body.append(host);
  const run = vi.fn();
  bindEditHistory(host, run);
  expect(command(search, "undo")).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

it("does not let an outer editor also consume an inner editor's command", () => {
  const outer = document.createElement("div");
  const inner = document.createElement("div");
  outer.append(inner);
  document.body.append(outer);
  const outerRun = vi.fn();
  const innerRun = vi.fn();
  bindEditHistory(outer, outerRun);
  bindEditHistory(inner, innerRun);
  expect(command(inner, "undo")).toBe(false);
  expect(innerRun).toHaveBeenCalledWith("undo");
  expect(outerRun).not.toHaveBeenCalled();
});
