import { expect, it } from "vitest";
import { matchingFiles, mentionQuery } from "./file-mentions";
import {
  documentPosition,
  promptDocument,
  promptValue,
  textOffset,
} from "./prompt-document";

it("activates after any @ and keeps selected chips literal", () => {
  expect(mentionQuery("hello @src/", 11, 11)).toEqual({
    query: "src/",
    start: 6,
    end: 11,
  });
  expect(mentionQuery("hello@example.com", 17, 17)).toEqual({
    query: "example.com",
    start: 5,
    end: 17,
  });
  expect(mentionQuery("prefix@src/", 11, 11)).toEqual({
    query: "src/",
    start: 6,
    end: 11,
  });
  expect(mentionQuery("@a", 1, 2)).toBeUndefined();
  expect(
    mentionQuery("@a", 2, 2, [
      { id: "a", path: "a", start: 0, end: 2, order: 0 },
    ]),
  ).toBeUndefined();
  expect(mentionQuery("@path with spaces", 17, 17)?.query).toBe(
    "path with spaces",
  );
});

it("ranks filename matches before directory matches, ignoring case", () => {
  expect(
    matchingFiles(["foo/z.txt", "x/afoo", "foo", "x/FooBar", "y/foo"], "FOO"),
  ).toEqual(["foo", "y/foo", "x/FooBar", "x/afoo", "foo/z.txt"]);
});

it("round trips multiline text and repeated chips with UTF-16 offsets", () => {
  const value = "😀 @src/한글.ts\nagain @src/한글.ts";
  const path = "src/한글.ts";
  const second = value.lastIndexOf("@");
  const mentions = [
    { id: "first", path, start: 3, end: 13, order: 0 },
    { id: "second", path, start: second, end: second + 10, order: 1 },
  ];
  const doc = promptDocument(value, mentions);
  expect(promptValue(doc)).toEqual({ value, mentions, commands: [] });
  for (const offset of [0, 2, 3, 13, second, second + 10])
    expect(textOffset(doc, documentPosition(doc, offset))).toBe(offset);
  expect(doc.child(1).type.name).toBe("mention");
});

it("does not reopen completion from an existing chip when typing after it", () => {
  expect(
    mentionQuery("@src/a.ts following text", 24, 24, [
      { id: "chip", path: "src/a.ts", start: 0, end: 9, order: 0 },
    ]),
  ).toBeUndefined();
});
