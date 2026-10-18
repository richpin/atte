import { lazy } from "solid-js";

export const EditableFile = lazy(() =>
  import("./editable-file-view").then((module) => ({
    default: module.EditableFile,
  })),
);
