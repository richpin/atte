import { ChangesReview } from "features/review-changes";
import { createWebTab } from "features/web-browser";
import {
  createFilesManager,
  FilesDialogs,
  type FilesManager,
  WorkspaceFiles,
} from "features/workspace-files";
import { FileDiff, FolderTree, GitBranch, Globe } from "lucide-solid";
import type { PreparedFileChange } from "shared/diff";
import { useI18n } from "shared/i18n";
import { Button } from "shared/ui";
import { createSignal, Show } from "solid-js";
import type { GitCommit } from "../api/git-history";
import { createThreadPanelModel as createModel } from "../model/thread-panel";
import { CommitReview } from "./git/CommitReview";
import { GitPanel } from "./git/GitPanel";

export function createThreadPanelModel(manager?: FilesManager) {
  const { t } = useI18n();
  const files = manager ?? createFilesManager(t);
  const openCommit = (
    threadId: string,
    repository: string,
    commit: GitCommit,
  ) => {
    model.openTab(threadId, {
      id: `commit:${repository}:${commit.oid}`,
      title: () => commit.oid.slice(0, 7),
      icon: FileDiff,
      content: (props) => (
        <CommitReview
          threadId={threadId}
          oid={commit.oid}
          visible={props.visible}
        />
      ),
    });
  };
  const openGit = (threadId: string, placeholder: string) => {
    model.openTab(threadId, {
      id: `git:${threadId}`,
      title: () => t("git.title"),
      icon: GitBranch,
      content: (props) => (
        <GitPanel
          threadId={threadId}
          visible={props.visible}
          onOpenCommit={(repository, commit) =>
            openCommit(threadId, repository, commit)
          }
        />
      ),
    });
    model.closeTab(threadId, placeholder);
  };
  const openFiles = (threadId: string, placeholder?: string) => {
    const fileModel = files.get(threadId);
    const id = `files:${threadId}`;
    model.openTab(threadId, {
      id,
      title: () => "Files",
      icon: FolderTree,
      beforeClose: async () => {
        if (!(await files.guard(threadId))) return false;
        files.forget(threadId);
        return true;
      },
      content: (props) => (
        <WorkspaceFiles
          model={fileModel}
          manager={files}
          visible={props.visible}
        />
      ),
    });
    if (placeholder) model.closeTab(threadId, placeholder);
  };
  const model = createModel((number, threadId) => {
    const web = createWebTab(threadId, {
      translate: t,
      startBlank: true,
      title: () => t("threadPanel.newTabTitle", { number }),
    });
    const [kind, setKind] = createSignal<"web">();
    return {
      ...web,
      title: () =>
        kind() ? web.title() : t("threadPanel.newTabTitle", { number }),
      content: (props: { active: boolean; visible: boolean }) => (
        <Show
          when={kind()}
          fallback={
            <div class="grid h-full place-content-center gap-4 p-6 text-center text-sm text-muted">
              <p>{t("threadPanel.newTabDescription")}</p>
              <Button
                variant="outline"
                onClick={() => openFiles(threadId, web.id)}
              >
                <FolderTree class="size-4" />
                Files
              </Button>
              <Button variant="outline" onClick={() => setKind("web")}>
                <Globe class="size-4" />
                {t("webBrowser.title")}
              </Button>
              <Button
                variant="outline"
                onClick={() => openGit(threadId, web.id)}
              >
                <GitBranch class="size-4" />
                {t("git.title")}
              </Button>
            </div>
          }
        >
          {web.content(props)}
        </Show>
      ),
    };
  });
  return {
    ...model,
    openFile: (threadId: string, path: string) => {
      openFiles(threadId);
      void files.get(threadId).open(path);
    },
    Guard: () => <FilesDialogs manager={files} />,
    confirmForget: (threadId: string) => files.guard(threadId),
    forget: (threadId: string) => {
      files.forget(threadId);
      model.forget(threadId);
    },
    openWebTab: (threadId: string, url: string) =>
      model.openTab(threadId, createWebTab(threadId, { url, translate: t })),
    openChangesTab: (
      threadId: string,
      turnId: string,
      files: PreparedFileChange[],
    ) => {
      model.openTab(threadId, {
        id: `changes:${turnId}`,
        title: () => t("diff.tabTitle"),
        icon: FileDiff,
        content: (props) => (
          <ChangesReview files={files} visible={props.visible} />
        ),
      });
    },
  };
}
