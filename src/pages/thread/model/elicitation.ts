import type {
  ElicitationAnswer,
  ElicitationRequest,
  FormValues,
} from "./types";

export function formDefaults(request: ElicitationRequest): FormValues {
  return Object.fromEntries(
    Object.entries(request.schema.properties).flatMap(([name, field]) =>
      field.default === undefined
        ? []
        : [
            [
              name,
              typeof field.default === "number"
                ? String(field.default)
                : field.default,
            ],
          ],
    ),
  );
}

export function formAnswer(
  request: ElicitationRequest,
  draft: FormValues,
): ElicitationAnswer {
  const values: Record<string, string | number | boolean | string[]> =
    Object.create(null);
  for (const [name, value] of Object.entries(draft)) {
    const field = request.schema.properties[name];
    if (!field) continue;
    if (
      value === "" &&
      (field.type === "number" ||
        field.type === "integer" ||
        !request.schema.required?.includes(name))
    )
      continue;
    if (
      Array.isArray(value) &&
      !value.length &&
      !request.schema.required?.includes(name)
    )
      continue;
    values[name] =
      field.type === "number" || field.type === "integer"
        ? Number(value)
        : value;
  }
  return { action: "accept", values };
}
