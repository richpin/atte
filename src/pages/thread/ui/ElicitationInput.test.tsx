import { cleanup, render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import { ThemeProvider } from "shared/theme";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { formAnswer, formDefaults } from "../model/elicitation";
import type { ElicitationRequest, FormValues } from "../model/types";
import { ElicitationInput } from "./ElicitationInput";

const request: ElicitationRequest = {
  kind: "elicitation",
  id: "question",
  message: "Choose an approach",
  toolCallId: null,
  schema: {
    properties: {
      name: { type: "string", title: "Name", default: "initial" },
      count: { type: "integer", title: "Count", default: 2 },
      safe: { type: "boolean", title: "Safe" },
      strategy: {
        type: "string",
        title: "Strategy",
        oneOf: [
          { const: "safe", title: "Careful" },
          { const: "fast", title: "Quick" },
        ],
        default: "safe",
      },
      checks: {
        type: "array",
        title: "Checks",
        items: {
          anyOf: [
            { const: "unit", title: "Unit tests" },
            { const: "integration", title: "Integration tests" },
          ],
        },
      },
    },
  },
};

beforeEach(() => localStorage.setItem("atte.locale", "en"));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(disabled = false, errors: Record<string, string> = {}) {
  const answer = vi.fn();
  const [values, setValues] = createSignal<FormValues>(formDefaults(request));
  render(() => (
    <ThemeProvider>
      <I18nProvider>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            answer(formAnswer(request, values()));
          }}
        >
          <ElicitationInput
            request={request}
            agentName="Fixture Agent"
            values={values()}
            errors={errors}
            disabled={disabled}
            onChange={(name, value) =>
              setValues((previous) => {
                const next = { ...previous };
                if (value === undefined) delete next[name];
                else next[name] = value;
                return next;
              })
            }
            onAnswer={(action) => answer({ action })}
          />
        </form>
      </I18nProvider>
    </ThemeProvider>
  ));
  return { answer, values };
}

it("renders defaults and returns typed choices only after explicit submission", async () => {
  const { answer, values } = setup();
  expect(screen.getByText(/Fixture Agent/)).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
    "value",
    "initial",
  );
  expect(screen.getByRole("radio", { name: "Careful" })).toHaveProperty(
    "checked",
    true,
  );
  expect(values().safe).toBeUndefined();
  expect(answer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("radio", { name: "No" }));
  await userEvent.click(screen.getByRole("radio", { name: "Quick" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "Unit tests" }));
  await userEvent.clear(screen.getByRole("spinbutton", { name: "Count" }));
  await userEvent.type(screen.getByRole("spinbutton", { name: "Count" }), "3");
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    action: "accept",
    values: {
      name: "initial",
      count: 3,
      safe: false,
      strategy: "fast",
      checks: ["unit"],
    },
  });
});

it("keeps decline and dismiss distinct and prevents every action when disabled", async () => {
  const { answer } = setup();
  await userEvent.click(screen.getByRole("button", { name: "Decline" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Dismiss question" }),
  );
  expect(answer.mock.calls).toEqual([
    [{ action: "decline" }],
    [{ action: "cancel" }],
  ]);
  cleanup();
  const disabled = setup(true);
  await userEvent.click(screen.getByRole("button", { name: "Submit" }));
  await userEvent.click(screen.getByRole("button", { name: "Decline" }));
  await userEvent.click(
    screen.getByRole("button", { name: "Dismiss question" }),
  );
  expect(disabled.answer).not.toHaveBeenCalled();
  expect(
    screen.getByRole("textbox", { name: "Name" }).closest("fieldset")?.disabled,
  ).toBe(true);
});

it("associates field errors with inputs and supports keyboard selection and submission", async () => {
  const { answer } = setup(false, { "/name": "Use a longer name" });
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name.getAttribute("aria-describedby")).toContain(
    "question-name-error",
  );
  expect(document.getElementById("question-name-error")?.textContent).toBe(
    "Use a longer name",
  );
  const choice = screen.getByRole("radio", { name: "Careful" });
  choice.focus();
  await userEvent.keyboard("{ArrowDown}");
  expect(screen.getByRole("radio", { name: "Quick" })).toHaveProperty(
    "checked",
    true,
  );
  name.focus();
  await userEvent.keyboard("{Enter}");
  expect(answer).toHaveBeenCalledExactlyOnceWith({
    action: "accept",
    values: { name: "initial", count: 2, strategy: "fast" },
  });
});
