import { Plus, RotateCcw, Search } from "lucide-solid";
import { useI18n } from "shared/i18n";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Markdown,
} from "shared/ui";
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  Show,
} from "solid-js";
import {
  installSkill,
  listSkills,
  readSkillDocument,
  removeSkill,
} from "../api/skills";
import type { SkillEntry, SkillTarget } from "../model/types";

export function SkillsPage(props: {
  active: boolean;
  projects: { folder: string; name: string }[];
}) {
  const { t, message } = useI18n();
  const [folder, setFolder] = createSignal<string>();
  const [search, setSearch] = createSignal("");
  const [adding, setAdding] = createSignal(false);
  const [source, setSource] = createSignal("");
  const [name, setName] = createSignal("");
  const [selected, setSelected] = createSignal<SkillEntry>();
  const [removing, setRemoving] = createSignal<SkillEntry>();
  const [busy, setBusy] = createSignal(false);
  const [operationMessage, setOperationMessage] = createSignal<{
    kind: "add" | "remove";
    text: string;
  }>();
  const [operationError, setOperationError] = createSignal<string>();
  const project = () =>
    props.projects.find((entry) => entry.folder === folder());
  const target = (): SkillTarget =>
    project()
      ? { scope: "project", folder: project()?.folder ?? "" }
      : { scope: "global" };
  createEffect(
    on(
      () => props.projects,
      (projects) => {
        if (folder() && !projects.some((entry) => entry.folder === folder())) {
          setFolder(undefined);
          setSelected(undefined);
          setRemoving(undefined);
        }
      },
    ),
  );
  const resourceTarget = () => (props.active ? target() : undefined);
  const [skills, { refetch }] = createResource(
    resourceTarget,
    async (selected) => {
      try {
        return { entries: await listSkills(selected), error: undefined };
      } catch (error) {
        return {
          entries: [] as SkillEntry[],
          error: message(error, "skills.loadFailed"),
        };
      }
    },
  );
  async function reload() {
    await refetch();
  }
  const documentTarget = () => {
    const skill = selected();
    return props.active && skill
      ? { target: target(), path: skill.path }
      : undefined;
  };
  const [document, { refetch: refetchDocument }] = createResource(
    documentTarget,
    async ({ target: selectedTarget, path }) => {
      try {
        return {
          value: await readSkillDocument(selectedTarget, path),
          error: undefined,
        };
      } catch (error) {
        return {
          value: undefined,
          error: message(error, "skills.documentFailed"),
        };
      }
    },
  );
  const filtered = createMemo(() => {
    const query = search().trim().toLocaleLowerCase();
    return (skills()?.entries ?? []).filter((skill) =>
      [
        skill.name,
        skill.description ?? "",
        ...skill.agents,
        skill.source ?? "",
        skill.sourceUrl ?? "",
      ].some((value) => value.toLocaleLowerCase().includes(query)),
    );
  });

  async function add() {
    const selected = target();
    if (busy() || !selected || !source().trim() || !name().trim()) return;
    setBusy(true);
    setOperationMessage(undefined);
    setOperationError(undefined);
    try {
      await installSkill(selected, source().trim(), name().trim());
      setOperationMessage({ kind: "add", text: t("skills.added") });
    } catch (error) {
      setOperationError(message(error, "skills.actionFailed"));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  async function remove() {
    const selected = target();
    const skill = removing();
    if (busy() || !selected || !skill) return;
    setBusy(true);
    setOperationMessage(undefined);
    setOperationError(undefined);
    try {
      await removeSkill(selected, skill.name);
      setOperationMessage({ kind: "remove", text: t("skills.removed") });
      setSelected(undefined);
      setRemoving(undefined);
    } catch (error) {
      setOperationError(message(error, "skills.actionFailed"));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  const scopeLabel = () => project()?.name ?? t("skills.global");
  const scopeLocation = () => project()?.folder ?? "";

  return (
    <div class="h-full overflow-y-auto px-6 pb-12">
      <div class="@container mx-auto max-w-4xl space-y-6 pt-6">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-sm text-muted-foreground">{t("skills.description")}</p>
          <div class="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={skills.loading || busy()}
              onClick={() => void reload()}
              aria-label={t("skills.refresh")}
            >
              <RotateCcw aria-hidden="true" class="size-4" />
              {t("skills.refresh")}
            </Button>
            <Button
              size="sm"
              disabled={busy()}
              onClick={() => {
                setAdding(true);
                setOperationError(undefined);
                setOperationMessage(undefined);
              }}
            >
              <Plus aria-hidden="true" class="size-4" />
              {t("skills.add")}
            </Button>
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <fieldset class="flex flex-wrap gap-1 rounded-xl border border-line p-1">
            <legend class="sr-only">{t("skills.scope")}</legend>
            <Button
              size="sm"
              variant={!project() ? "secondary" : "ghost"}
              aria-pressed={!project()}
              disabled={busy()}
              onClick={() => setFolder(undefined)}
            >
              {t("skills.global")}
            </Button>
            <For each={props.projects}>
              {(entry) => {
                const duplicate = () =>
                  props.projects.filter((item) => item.name === entry.name)
                    .length > 1;
                return (
                  <Button
                    size="sm"
                    variant={folder() === entry.folder ? "secondary" : "ghost"}
                    aria-pressed={folder() === entry.folder}
                    aria-label={
                      duplicate()
                        ? `${entry.name} · ${entry.folder}`
                        : entry.name
                    }
                    title={entry.folder}
                    disabled={busy()}
                    onClick={() => setFolder(entry.folder)}
                  >
                    {entry.name}
                  </Button>
                );
              }}
            </For>
          </fieldset>
        </div>
        <label class="relative block">
          <Search
            aria-hidden="true"
            class="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <span class="sr-only">{t("skills.search")}</span>
          <input
            class="h-10 w-full rounded-xl border border-input bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={search()}
            onInput={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("skills.search")}
          />
        </label>
        <Show when={operationError()}>
          {(error) => (
            <p role="alert" class="text-sm text-danger">
              {error()}
            </p>
          )}
        </Show>
        <Show
          when={
            operationMessage()?.kind === "remove"
              ? operationMessage()
              : undefined
          }
        >
          {(value) => (
            <p role="status" class="text-sm text-muted-foreground">
              {value().text}
            </p>
          )}
        </Show>
        <Show when={skills.loading}>
          <p role="status" class="text-sm text-muted-foreground">
            {t("skills.loading")}
          </p>
        </Show>
        <Show when={!skills.loading && skills()?.error}>
          <div role="alert" class="space-y-2 text-sm text-danger">
            <p>{skills()?.error}</p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              {t("common.retry")}
            </Button>
          </div>
        </Show>
        <Show
          when={!skills.loading && !skills()?.error && filtered().length === 0}
        >
          <p class="text-sm text-muted-foreground">
            {search() ? t("skills.noMatches") : t("skills.empty")}
          </p>
        </Show>
        <Show
          when={!skills.loading && !skills()?.error && filtered().length > 0}
        >
          <ul class="grid grid-cols-1 gap-4 @min-[640px]:grid-cols-2">
            <For each={filtered()}>
              {(skill) => (
                <li class="min-w-0">
                  <button
                    type="button"
                    aria-label={skill.name}
                    class="flex h-full min-h-32 w-full flex-col gap-2 rounded-2xl border border-line bg-input-surface p-5 text-left transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    disabled={busy()}
                    onClick={() => {
                      setSelected(skill);
                      setOperationError(undefined);
                      setOperationMessage(undefined);
                    }}
                  >
                    <span class="text-lg font-semibold break-words">
                      {skill.name}
                    </span>
                    <Show when={skill.description}>
                      {(description) => (
                        <span class="line-clamp-3 text-sm text-muted-foreground">
                          {description()}
                        </span>
                      )}
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <Dialog
        open={Boolean(selected())}
        onOpenChange={(open) => {
          if (!open && !busy() && !removing()) setSelected(undefined);
        }}
      >
        <DialogContent class="flex max-h-[min(47rem,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-xl flex-col overflow-hidden">
          <DialogHeader class="shrink-0">
            <DialogTitle class="text-xl font-semibold">
              {selected()?.name}
            </DialogTitle>
            <Show
              when={selected()?.description ?? document()?.value?.description}
            >
              {(description) => (
                <DialogDescription>{description()}</DialogDescription>
              )}
            </Show>
          </DialogHeader>
          <p class="shrink-0 break-all text-sm text-muted-foreground">
            {t("skills.path")}: {selected()?.path}
          </p>
          <section
            aria-label="SKILL.md"
            class="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-line bg-input-surface p-4"
          >
            <Show when={document.loading}>
              <p role="status" class="text-sm text-muted-foreground">
                {t("skills.documentLoading")}
              </p>
            </Show>
            <Show when={!document.loading && document()?.error}>
              <div role="alert" class="space-y-2 text-sm text-danger">
                <p>{document()?.error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refetchDocument()}
                >
                  {t("common.retry")}
                </Button>
              </div>
            </Show>
            <Show when={!document.loading && document()?.value}>
              {(value) => (
                <Markdown source={value().markdown} variant="agent" />
              )}
            </Show>
          </section>
          <Show when={operationError()}>
            {(error) => (
              <p role="alert" class="text-sm text-danger">
                {error()}
              </p>
            )}
          </Show>
          <DialogFooter class="shrink-0">
            <button
              type="button"
              disabled={busy()}
              class="rounded-lg bg-danger-soft px-3 py-1.5 text-sm text-danger hover:bg-danger/15 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:opacity-40"
              onClick={() => setRemoving(selected())}
            >
              {t("skills.uninstall")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={adding()}
        onOpenChange={(open) => {
          if (!open && busy()) return;
          setAdding(open);
        }}
      >
        <DialogContent class="gap-6">
          <DialogHeader class="space-y-3">
            <DialogTitle>
              {project()
                ? t("skills.addToProject", { name: project()?.name ?? "" })
                : t("skills.add")}
            </DialogTitle>
            <DialogDescription>
              {t("skills.installDescription")}
            </DialogDescription>
          </DialogHeader>
          <form
            class="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <label class="flex flex-col gap-2 text-sm">
              <span>{t("skills.source")}</span>
              <input
                required
                class="h-10 w-full rounded-xl border border-input bg-background px-3"
                value={source()}
                onInput={(event) => setSource(event.currentTarget.value)}
                placeholder="owner/repo"
              />
            </label>
            <label class="flex flex-col gap-2 text-sm">
              <span>{t("skills.name")}</span>
              <input
                required
                class="h-10 w-full rounded-xl border border-input bg-background px-3"
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
            <Show when={operationError()}>
              {(error) => (
                <p role="alert" class="text-sm text-danger">
                  {error()}
                </p>
              )}
            </Show>
            <Show when={operationMessage()}>
              {(value) => (
                <p role="status" class="text-sm text-muted-foreground">
                  {value().text}
                </p>
              )}
            </Show>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy()}
                onClick={() => setAdding(false)}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={busy() || !source().trim() || !name().trim()}
              >
                {busy() ? t("skills.working") : t("skills.add")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(removing())}
        onOpenChange={(open) => {
          if (!open && !busy()) setRemoving(undefined);
        }}
      >
        <DialogContent role="alertdialog">
          <DialogHeader>
            <DialogTitle>{t("skills.removeTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.removeDescription")}
            </DialogDescription>
          </DialogHeader>
          <p class="break-all text-sm">
            {removing()?.name} · {scopeLabel()}
            {scopeLocation() ? ` · ${scopeLocation()}` : ""}
          </p>
          <Show when={operationError()}>
            {(error) => (
              <p role="alert" class="text-sm text-danger">
                {error()}
              </p>
            )}
          </Show>
          <Show when={operationMessage()}>
            {(value) => (
              <p role="status" class="text-sm text-muted-foreground">
                {value().text}
              </p>
            )}
          </Show>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy()}
              onClick={() => setRemoving(undefined)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy()}
              onClick={() => void remove()}
            >
              {busy() ? t("skills.working") : t("skills.uninstall")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
