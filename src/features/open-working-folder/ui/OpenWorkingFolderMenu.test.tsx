import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { I18nProvider } from "shared/i18n";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ToastHost,
} from "shared/ui";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenWorkingFolderMenu } from "./OpenWorkingFolderMenu";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const applications = [
  {
    id: "native-finder-choice",
    name: "Finder",
    icon: "data:image/png;base64,finder",
  },
  { id: "native-xcode-choice", name: "Xcode", icon: null },
];
let failImage = false;

beforeEach(() => {
  failImage = false;
  vi.stubGlobal(
    "Image",
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => (failImage ? this.onerror?.() : this.onload?.()));
      }
    },
  );
  localStorage.setItem("atte.locale", "en");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  invoke.mockImplementation((command: string) =>
    Promise.resolve(
      command === "list_working_folder_apps" ? applications : undefined,
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invoke.mockReset();
  localStorage.clear();
});

function setup() {
  const [threadId, setThreadId] = createSignal<string | undefined>("thread-a");
  render(() => (
    <I18nProvider>
      <DropdownMenu>
        <DropdownMenuTrigger>Thread menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem disabled>Reconnect</DropdownMenuItem>
          <OpenWorkingFolderMenu threadId={threadId()} />
        </DropdownMenuContent>
      </DropdownMenu>
      <ToastHost />
    </I18nProvider>
  ));
  return { setThreadId };
}

async function openSubmenu() {
  await userEvent.click(
    await screen.findByRole("button", { name: "Thread menu" }),
  );
  const trigger = await screen.findByRole("menuitem", { name: "Open in" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  return trigger;
}

it("loads installed apps after Reconnect with original-color icons and opens the current thread", async () => {
  const { setThreadId } = setup();
  expect(invoke).not.toHaveBeenCalled();
  await openSubmenu();
  const finder = await screen.findByRole("menuitem", { name: "Finder" });
  const cursor = screen.getByRole("menuitem", { name: "Xcode" });
  expect(
    screen.queryByRole("menuitem", { name: "Visual Studio Code" }),
  ).toBeNull();
  expect(screen.queryByRole("menuitem", { name: "Zed" })).toBeNull();
  await waitFor(() => expect(finder.querySelector("img")).toBeTruthy());
  const image = finder.querySelector("img");
  expect(image?.getAttribute("src")).toBe(applications[0].icon);
  expect(image?.className).not.toContain("invert");
  expect(cursor.querySelector("svg")).toBeTruthy();
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual(["Reconnect", "Open in", "Finder", "Xcode"]);
  expect(invoke).toHaveBeenCalledWith("list_working_folder_apps", {
    threadId: "thread-a",
  });
  setThreadId("thread-b");
  await userEvent.click(await screen.findByRole("menuitem", { name: "Xcode" }));
  expect(invoke).toHaveBeenCalledWith("list_working_folder_apps", {
    threadId: "thread-b",
  });
  expect(invoke).toHaveBeenCalledWith("open_working_folder", {
    threadId: "thread-b",
    target: "native-xcode-choice",
  });
});

it("shows loading, retries discovery in place, and refreshes on reopening", async () => {
  let resolve!: (value: typeof applications) => void;
  invoke.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  setup();
  await openSubmenu();
  expect(await screen.findByText("Loading applications…")).toBeTruthy();
  resolve(applications);
  expect(await screen.findByRole("menuitem", { name: "Finder" })).toBeTruthy();
  await userEvent.keyboard("{Escape}{Escape}");
  invoke.mockRejectedValueOnce("discoveryFailed");
  await openSubmenu();
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: "Could not load applications. Retry",
    }),
  );
  expect(await screen.findByRole("menuitem", { name: "Xcode" })).toBeTruthy();
  expect(
    invoke.mock.calls.filter(
      ([command]) => command === "list_working_folder_apps",
    ),
  ).toHaveLength(3);
});

it("uses the generic icon when an application image fails", async () => {
  failImage = true;
  setup();
  await openSubmenu();
  const finder = await screen.findByRole("menuitem", { name: "Finder" });
  await waitFor(() => expect(finder.querySelector("svg")).toBeTruthy());
});

it("opens the first app with the keyboard and reports a missing folder", async () => {
  invoke.mockImplementation((command: string) =>
    command === "open_working_folder"
      ? Promise.reject("folderMissing")
      : Promise.resolve(applications),
  );
  setup();
  await openSubmenu();
  const finder = await screen.findByRole("menuitem", { name: "Finder" });
  finder.focus();
  await userEvent.keyboard("{Enter}");
  expect(invoke).toHaveBeenCalledWith("open_working_folder", {
    threadId: "thread-a",
    target: "native-finder-choice",
  });
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The working folder could not be found.",
  );
});

it("hides the feature on other platforms without querying applications", async () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  setup();
  await userEvent.click(screen.getByRole("button", { name: "Thread menu" }));
  expect(screen.queryByRole("menuitem", { name: "Open in" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("shows an empty state when macOS returns no handlers", async () => {
  invoke.mockResolvedValue([]);
  setup();
  await openSubmenu();
  const item = await screen.findByRole("menuitem", {
    name: "No applications available for this project",
  });
  expect(item.hasAttribute("data-disabled")).toBe(true);
});

it("discards stale discovery when the selected thread changes", async () => {
  let resolve!: (value: typeof applications) => void;
  invoke.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { setThreadId } = setup();
  await openSubmenu();
  expect(await screen.findByText("Loading applications…")).toBeTruthy();
  invoke.mockResolvedValueOnce([
    { id: "another-native-id", name: "Other IDE", icon: null },
  ]);
  setThreadId("thread-b");
  expect(
    await screen.findByRole("menuitem", { name: "Other IDE" }),
  ).toBeTruthy();
  resolve(applications);
  await waitFor(() =>
    expect(screen.queryByRole("menuitem", { name: "Xcode" })).toBeNull(),
  );
  await userEvent.click(screen.getByRole("menuitem", { name: "Other IDE" }));
  expect(invoke).toHaveBeenCalledWith("open_working_folder", {
    threadId: "thread-b",
    target: "another-native-id",
  });
});
