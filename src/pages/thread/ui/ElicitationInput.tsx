import { ArrowRight, Check, CircleHelp, X } from "lucide-solid";
import { useI18n } from "shared/i18n";
import { TextField, TextFieldInput, TextFieldLabel } from "shared/ui";
import { For, type JSX, Show } from "solid-js";
import type { ElicitationRequest, FormField, FormValues } from "../model/types";

function choices(field: FormField) {
  return (
    field.oneOf ??
    field.items?.anyOf ??
    (field.enum ?? field.items?.enum)?.map((value) => ({
      const: value,
      title: value,
    }))
  );
}

export function ElicitationInput(props: {
  request: ElicitationRequest;
  agentName: string;
  values: FormValues;
  errors: Record<string, string>;
  disabled: boolean;
  headerActions?: JSX.Element;
  onChange: (name: string, value: FormValues[string] | undefined) => void;
  onAnswer: (action: "accept" | "decline" | "cancel") => void;
}) {
  const { t } = useI18n();
  return (
    <section aria-label={t("thread.elicitation.title")}>
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="flex min-w-0 items-center gap-2 text-xs text-muted">
          <CircleHelp aria-hidden="true" class="size-4 shrink-0" />
          {props.agentName} · {t("thread.elicitation.title")}
        </p>
        <div class="flex shrink-0 items-center gap-2">
          {props.headerActions}
          <button
            type="button"
            aria-label={t("thread.elicitation.cancel")}
            title={t("thread.elicitation.cancel")}
            disabled={props.disabled}
            class="grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-menu-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40"
            onClick={() => props.onAnswer("cancel")}
          >
            <X aria-hidden="true" class="size-4" />
          </button>
        </div>
      </div>
      <h2 class="whitespace-pre-wrap break-words text-sm font-medium">
        {props.request.message}
      </h2>
      <Show when={props.request.schema.description}>
        <p class="mt-2 whitespace-pre-wrap text-xs text-muted">
          {props.request.schema.description}
        </p>
      </Show>
      <div class="mt-4 flex flex-col gap-4">
        <For each={Object.entries(props.request.schema.properties)}>
          {([name, field]) => {
            const required = () =>
              props.request.schema.required?.includes(name) ?? false;
            const label = () =>
              `${field.title || name}${required() ? " *" : ""}`;
            const error = () =>
              props.errors[
                `/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`
              ];
            const id = `${props.request.id}-${name}`;
            return (
              <fieldset
                disabled={props.disabled}
                class="min-w-0"
                aria-describedby={error() ? `${id}-error` : undefined}
                aria-invalid={!!error()}
              >
                <Show
                  when={field.type === "boolean" || choices(field)}
                  fallback={
                    <TextField
                      value={String(props.values[name] ?? "")}
                      onChange={(value) => props.onChange(name, value)}
                      validationState={error() ? "invalid" : "valid"}
                      disabled={props.disabled}
                      required={required()}
                    >
                      <TextFieldLabel>{label()}</TextFieldLabel>
                      <TextFieldInput
                        type={
                          field.type === "number" || field.type === "integer"
                            ? "number"
                            : "text"
                        }
                        step={field.type === "integer" ? 1 : "any"}
                        min={field.minimum}
                        max={field.maximum}
                        minLength={field.minLength}
                        maxLength={field.maxLength}
                        aria-describedby={error() ? `${id}-error` : undefined}
                      />
                    </TextField>
                  }
                >
                  <legend class="mb-2 text-sm font-medium">{label()}</legend>
                  <div class="flex flex-col gap-2">
                    <For
                      each={
                        field.type === "boolean"
                          ? [
                              {
                                const: "true",
                                title: t("thread.elicitation.yes"),
                              },
                              {
                                const: "false",
                                title: t("thread.elicitation.no"),
                              },
                            ]
                          : choices(field)
                      }
                    >
                      {(choice, index) => {
                        const checked = () =>
                          field.type === "array"
                            ? ((
                                props.values[name] as string[] | undefined
                              )?.includes(choice.const) ?? false)
                            : field.type === "boolean"
                              ? props.values[name] === (choice.const === "true")
                              : props.values[name] === choice.const;
                        return (
                          <label class="relative block">
                            <input
                              type={
                                field.type === "array" ? "checkbox" : "radio"
                              }
                              name={id}
                              value={choice.const}
                              required={field.type !== "array" && required()}
                              class="peer sr-only"
                              checked={checked()}
                              aria-describedby={
                                error() ? `${id}-error` : undefined
                              }
                              aria-invalid={!!error()}
                              onChange={(event) => {
                                if (field.type === "array") {
                                  const previous =
                                    (props.values[name] as
                                      | string[]
                                      | undefined) ?? [];
                                  props.onChange(
                                    name,
                                    event.currentTarget.checked
                                      ? [...previous, choice.const]
                                      : previous.filter(
                                          (value) => value !== choice.const,
                                        ),
                                  );
                                } else
                                  props.onChange(
                                    name,
                                    field.type === "boolean"
                                      ? choice.const === "true"
                                      : choice.const,
                                  );
                              }}
                            />
                            <span class="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-sm hover:bg-menu-hover peer-checked:bg-menu-hover peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:cursor-not-allowed peer-disabled:opacity-40">
                              <span
                                aria-hidden="true"
                                class="grid size-7 shrink-0 place-items-center rounded-md border border-line bg-panel text-xs text-muted"
                              >
                                {index() + 1}
                              </span>
                              <span class="min-w-0 flex-1 break-words">
                                {choice.title}
                              </span>
                              <Show when={checked()}>
                                <Show
                                  when={field.type === "array"}
                                  fallback={
                                    <ArrowRight
                                      aria-hidden="true"
                                      class="size-4 shrink-0 text-muted"
                                    />
                                  }
                                >
                                  <Check
                                    aria-hidden="true"
                                    class="size-4 shrink-0 text-muted"
                                  />
                                </Show>
                              </Show>
                            </span>
                          </label>
                        );
                      }}
                    </For>
                    <Show
                      when={!required() && props.values[name] !== undefined}
                    >
                      <button
                        type="button"
                        class="self-start text-xs text-muted underline"
                        onClick={() => props.onChange(name, undefined)}
                      >
                        {t("thread.elicitation.clear")}
                      </button>
                    </Show>
                  </div>
                </Show>
                <Show when={field.description}>
                  <p class="mt-1 text-xs text-muted">{field.description}</p>
                </Show>
                <Show when={error()}>
                  <p
                    id={`${id}-error`}
                    role="alert"
                    class="mt-1 text-xs text-response-warning"
                  >
                    {error()}
                  </p>
                </Show>
              </fieldset>
            );
          }}
        </For>
      </div>
      <Show when={Object.keys(props.errors).length}>
        <p role="alert" class="mt-3 text-xs text-response-warning">
          {Object.values(props.errors).join("\n")}
        </p>
      </Show>
      <div class="mt-4 ml-auto grid w-full max-w-40 grid-cols-2 gap-2 text-sm">
        <button
          type="button"
          disabled={props.disabled}
          class="min-h-10 rounded-lg border border-line px-2 py-2 hover:bg-menu-hover disabled:opacity-40"
          onClick={() => props.onAnswer("decline")}
        >
          {t("thread.elicitation.decline")}
        </button>
        <button
          type="submit"
          disabled={props.disabled}
          class="min-h-10 rounded-lg bg-primary px-2 py-2 text-primary-foreground disabled:opacity-40"
        >
          {t("thread.elicitation.submit")}
        </button>
      </div>
    </section>
  );
}
