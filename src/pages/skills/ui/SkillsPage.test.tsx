import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { I18nProvider } from "shared/i18n";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SkillsPage } from "./SkillsPage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const projects = [
  { folder: "/tmp/project", name: "project" },
  { folder: "/tmp/other/project", name: "project" },
];
const skill = {
  name: "review-work",
  description: "Review code carefully.",
  path: "/tmp/project/.agents/skills/review-work",
  scope: "project",
  agents: ["Codex", "Claude Code"],
  source: "owner/repo",
  sourceUrl: null,
  sourceType: "git",
};

function renderPage(items = projects) {
  return render(() => (
    <I18nProvider>
      <SkillsPage active projects={items} />
    </I18nProvider>
  ));
}

beforeEach(() => {
  localStorage.setItem("atte.locale", "en");
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_skills") return [skill];
    if (command === "read_skill_document")
      return {
        description: skill.description,
        markdown: "# Guide\n\n**Review** files.",
      };
    if (command === "install_skill") return [{ status: "installed" }];
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("shows two-column cards with descriptions and filters by description", async () => {
  const { container } = renderPage();
  await screen.findByRole("button", { name: "review-work" });
  expect(container.querySelector("ul.grid")?.className).toContain(
    "@min-[640px]:grid-cols-2",
  );
  expect(screen.getByText(skill.description)).toBeTruthy();
  expect(screen.queryByText("Codex, Claude Code")).toBeNull();
  fireEvent.input(screen.getByRole("textbox", { name: "Search skills" }), {
    target: { value: "carefully" },
  });
  expect(screen.getByRole("button", { name: "review-work" })).toBeTruthy();
  fireEvent.input(screen.getByRole("textbox", { name: "Search skills" }), {
    target: { value: "missing" },
  });
  expect(screen.getByText("No matching skills.")).toBeTruthy();
});

it("uses sidebar source folders for project scope and installation", async () => {
  renderPage();
  await screen.findByText("review-work");
  const projectButton = screen.getByRole("button", {
    name: "project · /tmp/project",
  });
  expect(projectButton).toHaveProperty("title", "/tmp/project");
  fireEvent.click(projectButton);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("list_skills", {
      target: { scope: "project", folder: "/tmp/project" },
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Add skill" }));
  expect(
    screen.getByRole("heading", { name: "Add skill to project" }),
  ).toBeTruthy();
  expect(screen.queryByText("All supported agents")).toBeNull();
  fireEvent.input(screen.getByRole("textbox", { name: "Source" }), {
    target: { value: "owner/repo" },
  });
  fireEvent.input(screen.getByRole("textbox", { name: "Skill name" }), {
    target: { value: "review-work" },
  });
  const submit = screen.getAllByRole("button", { name: "Add skill" }).at(-1);
  if (submit) fireEvent.click(submit);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("install_skill", {
      target: { scope: "project", folder: "/tmp/project" },
      source: "owner/repo",
      name: "review-work",
    }),
  );
  await waitFor(() =>
    expect(screen.getAllByText("Skill installation finished.")).toHaveLength(1),
  );
});

it("shows Markdown details and confirms uninstall before reloading", async () => {
  renderPage([]);
  fireEvent.click(await screen.findByRole("button", { name: "review-work" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("read_skill_document", {
      target: { scope: "global" },
      path: skill.path,
    }),
  );
  expect(await screen.findByText("Guide")).toBeTruthy();
  expect(screen.getByText("Review").closest("strong")).toBeTruthy();
  expect(screen.getByText(`Path: ${skill.path}`)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
  await screen.findByRole("alertdialog");
  expect(screen.getByText("review-work · Global")).toBeTruthy();
  const confirm = screen.getAllByRole("button", { name: "Uninstall" }).at(-1);
  if (confirm) fireEvent.click(confirm);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("remove_skill", {
      target: { scope: "global" },
      name: "review-work",
    }),
  );
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "list_skills"),
    ).toHaveLength(2),
  );
});

it("ignores a late document response after another card opens", async () => {
  const second = {
    ...skill,
    name: "write-work",
    path: "/tmp/project/.agents/skills/write-work",
  };
  let finishFirst: (value: unknown) => void = () => {};
  const first = new Promise<unknown>((resolve) => {
    finishFirst = resolve;
  });
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "list_skills") return [skill, second];
    if (command === "read_skill_document") {
      if ((args as { path: string }).path === skill.path) return first;
      return { description: second.description, markdown: "# Second guide" };
    }
    return undefined;
  });
  renderPage([]);
  fireEvent.click(await screen.findByRole("button", { name: "review-work" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(invoke)
        .mock.calls.some(([command]) => command === "read_skill_document"),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "write-work" }));
  expect(await screen.findByText("Second guide")).toBeTruthy();
  finishFirst({ description: skill.description, markdown: "# Old guide" });
  expect(screen.queryByText("Old guide")).toBeNull();
});

it("retries a failed document read without closing the detail dialog", async () => {
  let reads = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_skills") return [skill];
    if (command === "read_skill_document") {
      reads += 1;
      if (reads === 1) throw new Error("File unavailable");
      return { description: skill.description, markdown: "# Restored guide" };
    }
    return undefined;
  });
  renderPage([]);
  fireEvent.click(await screen.findByRole("button", { name: "review-work" }));
  expect(await screen.findByText("File unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Restored guide")).toBeTruthy();
  expect(reads).toBe(2);
});

it("keeps a successful uninstall result separate from a failed list reload", async () => {
  let loads = 0;
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_skills") {
      loads += 1;
      if (loads > 1) throw new Error("Reload unavailable");
      return [skill];
    }
    if (command === "read_skill_document")
      return { description: skill.description, markdown: "# Guide" };
    return undefined;
  });
  renderPage([]);
  fireEvent.click(await screen.findByRole("button", { name: "review-work" }));
  await screen.findByText("Guide");
  fireEvent.click(screen.getByRole("button", { name: "Uninstall" }));
  await screen.findByRole("alertdialog");
  const confirm = screen.getAllByRole("button", { name: "Uninstall" }).at(-1);
  if (confirm) fireEvent.click(confirm);
  await waitFor(() => expect(loads).toBe(2));
  expect(screen.getByText("Skill uninstall finished.")).toBeTruthy();
  expect(await screen.findByText("Reload unavailable")).toBeTruthy();
});

it("returns to Global when the sidebar project disappears", async () => {
  const [available, setAvailable] = createSignal(projects);
  render(() => (
    <I18nProvider>
      <SkillsPage active projects={available()} />
    </I18nProvider>
  ));
  await screen.findByText("review-work");
  fireEvent.click(
    screen.getByRole("button", { name: "project · /tmp/project" }),
  );
  setAvailable([]);
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Global" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
});
