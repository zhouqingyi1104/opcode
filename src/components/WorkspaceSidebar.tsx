import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Search,
  RefreshCw,
  Plus,
  Loader2,
  Trash2,
  Pencil,
  AlertTriangle,
} from "lucide-react";
import { api, type Project, type Session } from "@/lib/api";
import { useTabState } from "@/hooks/useTabState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type PendingDelete =
  | { kind: "project"; project: Project; sessionCount: number }
  | { kind: "session"; project: Project; session: Session };

interface WorkspaceSidebarProps {
  className?: string;
}

function relativeTime(timestampMs: number): string {
  if (!timestampMs) return "";
  const diff = Date.now() - timestampMs;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月`;
  return `${Math.floor(months / 12)}年`;
}

function sessionLabel(session: Session): string {
  // A name the user gave the session always wins over its opening line.
  const named = session.custom_title?.replace(/\s+/g, " ").trim();
  if (named) {
    return named.length > 42 ? `${named.slice(0, 42)}…` : named;
  }

  const first = session.first_message?.replace(/\s+/g, " ").trim();
  if (first) {
    return first.length > 42 ? `${first.slice(0, 42)}…` : first;
  }
  return `会话 ${session.id.slice(0, 8)}`;
}

function sessionTime(session: Session): number {
  if (session.message_timestamp) {
    const parsed = Date.parse(session.message_timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return session.created_at ? session.created_at * 1000 : 0;
}

function projectName(project: Project): string {
  const parts = project.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || project.path;
}

/**
 * Left-hand workspace tree: projects, expandable to their sessions.
 *
 * Mirrors the navigation model people expect from Claude Code / Cursor: pick a
 * project, pick a conversation, instead of hunting through horizontal tabs.
 */
export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = ({ className }) => {
  const {
    tabs,
    activeTabId,
    createProjectsTab,
    createChatTab,
    updateTab,
    switchToTab,
    findTabBySessionId,
    canAddTab,
    closeTab,
  } = useTabState();

  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});
  const [sessionErrors, setSessionErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Session currently being renamed inline, plus its draft title. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** Guards against saving twice when Enter is followed by blur. */
  const renameCommittingRef = useRef<string | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeSessionId = activeTab?.sessionId;
  const activeProjectPath = activeTab?.initialProjectPath;

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const list = await api.listProjects();
      setProjects(list);
      // Expand the project that owns the active session so it is visible.
      if (activeProjectPath) {
        const owner = list.find((p) => p.path === activeProjectPath);
        if (owner) {
          setExpanded((prev) => new Set(prev).add(owner.id));
        }
      }
    } catch (err) {
      console.error("[WorkspaceSidebar] Failed to load projects:", err);
    } finally {
      setLoadingProjects(false);
    }
  }, [activeProjectPath]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const loadSessions = useCallback(async (project: Project) => {
    setLoadingSessions((prev) => ({ ...prev, [project.id]: true }));
    setSessionErrors((prev) => {
      const next = { ...prev };
      delete next[project.id];
      return next;
    });
    try {
      const sessions = await api.getProjectSessions(project.id);
      const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a));
      setSessionsByProject((prev) => ({ ...prev, [project.id]: sorted }));
    } catch (err) {
      console.error("[WorkspaceSidebar] Failed to load sessions:", err);
      // Leave the list unset so the row offers a retry instead of pretending
      // the project has no conversations.
      setSessionErrors((prev) => ({
        ...prev,
        [project.id]: typeof err === "string" ? err : "加载失败",
      }));
    } finally {
      setLoadingSessions((prev) => ({ ...prev, [project.id]: false }));
    }
  }, []);

  /**
   * Invariant: an expanded project always has its sessions requested.
   *
   * Expansion happens from more than one place - the user clicking, and the
   * startup path that auto-expands whichever project owns the active session.
   * Driving the fetch from `expanded` instead of from the click handler means
   * neither path can leave a project showing "暂无会话" while it is actually
   * just never having been asked.
   *
   * Projects with a recorded error are skipped so a failure is not retried in a
   * loop; the row offers an explicit 重试 for that case.
   */
  useEffect(() => {
    for (const projectId of expanded) {
      if (sessionsByProject[projectId] || loadingSessions[projectId]) continue;
      if (sessionErrors[projectId]) continue;
      const project = projects.find((p) => p.id === projectId);
      if (project) void loadSessions(project);
    }
  }, [expanded, projects, sessionsByProject, loadingSessions, sessionErrors, loadSessions]);

  const toggleProject = useCallback(
    (project: Project) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(project.id)) {
          next.delete(project.id);
        } else {
          next.add(project.id);
        }
        return next;
      });
      // The effect above takes care of loading on expand.
    },
    []
  );

  const openSession = useCallback(
    (project: Project, session: Session) => {
      const existing = findTabBySessionId(session.id);
      if (existing) {
        switchToTab(existing.id);
        return;
      }

      const title = projectName(project);
      const patch = {
        type: "chat" as const,
        title,
        sessionId: session.id,
        sessionData: session,
        initialProjectPath: session.project_path || project.path,
      };

      if (canAddTab()) {
        const id = createChatTab(project.id, title, session.project_path || project.path);
        updateTab(id, patch);
      } else if (activeTabId) {
        updateTab(activeTabId, patch);
      }
    },
    [activeTabId, canAddTab, createChatTab, findTabBySessionId, switchToTab, updateTab]
  );

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    setDeleteError(null);

    try {
      if (pendingDelete.kind === "project") {
        const projectId = pendingDelete.project.id;
        await api.deleteProject(projectId);

        setProjects((prev) => prev.filter((p) => p.id !== projectId));
        setExpanded((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          return next;
        });
        setSessionsByProject((prev) => {
          const next = { ...prev };
          delete next[projectId];
          return next;
        });

        // Chat tabs pointed at that history no longer have anything to show.
        for (const tab of tabs) {
          if (tab.type === "chat" && tab.initialProjectPath === pendingDelete.project.path) {
            void closeTab(tab.id, true);
          }
        }
      } else {
        const sessionId = pendingDelete.session.id;
        const projectId = pendingDelete.project.id;
        await api.deleteSession(sessionId);

        setSessionsByProject((prev) => ({
          ...prev,
          [projectId]: (prev[projectId] ?? []).filter((s) => s.id !== sessionId),
        }));

        const openTab = findTabBySessionId(sessionId);
        if (openTab) {
          void closeTab(openTab.id, true);
        }
      }

      setPendingDelete(null);
    } catch (err) {
      const detail = typeof err === "string" ? err : err instanceof Error ? err.message : "";
      setDeleteError(detail || "删除失败");
    } finally {
      setIsDeleting(false);
    }
  }, [closeTab, findTabBySessionId, pendingDelete, tabs]);

  // Rename failures are transient: show the reason, then get out of the way.
  useEffect(() => {
    if (!renameError) return;
    const timer = window.setTimeout(() => setRenameError(null), 6000);
    return () => window.clearTimeout(timer);
  }, [renameError]);

  const startRename = useCallback((session: Session) => {    setRenameError(null);
    setRenamingId(session.id);
    // Seed with the untruncated source, never with the "..." preview.
    setRenameDraft(session.custom_title ?? session.first_message ?? "");
  }, []);

  const commitRename = useCallback(
    async (projectId: string, session: Session) => {
      // Enter triggers a save, which unmounts the input and fires blur; this
      // guard keeps the second call from writing the same title again.
      if (renameCommittingRef.current === session.id) return;
      renameCommittingRef.current = session.id;

      const title = renameDraft.trim();
      const previous = session.custom_title ?? "";
      setRenamingId(null);

      if (title === previous) {
        renameCommittingRef.current = null;
        return;
      }

      const apply = (value: string | undefined) =>
        setSessionsByProject((prev) => ({
          ...prev,
          [projectId]: (prev[projectId] ?? []).map((s) =>
            s.id === session.id ? { ...s, custom_title: value } : s
          ),
        }));

      apply(title || undefined); // optimistic
      try {
        await api.renameSession(session.id, title);
      } catch (err) {
        const detail = typeof err === "string" ? err : err instanceof Error ? err.message : "";
        setRenameError(detail || "重命名失败");
        apply(previous || undefined);
      } finally {
        renameCommittingRef.current = null;
      }
    },
    [renameDraft]
  );

  const filtered = useMemo(() => {    const q = query.trim().toLowerCase();
    if (!q) return projects;

    return projects.filter((project) => {
      if (projectName(project).toLowerCase().includes(q)) return true;
      if (project.path.toLowerCase().includes(q)) return true;
      const sessions = sessionsByProject[project.id] ?? [];
      return sessions.some((s) => sessionLabel(s).toLowerCase().includes(q));
    });
  }, [projects, query, sessionsByProject]);

  return (
    <>
    <aside
      className={cn(
        "flex h-full w-[264px] min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-muted/20",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 text-caption font-medium uppercase tracking-wide text-muted-foreground">
          工作区
        </span>
        <button
          type="button"
          title="搜索"
          onClick={() => setSearchOpen((v) => !v)}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Search className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="刷新"
          onClick={() => {
            setSessionsByProject({});
            void loadProjects();
          }}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loadingProjects && "animate-spin")} />
        </button>
        <button
          type="button"
          title="新建标签页"
          onClick={() => createProjectsTab()}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {searchOpen && (
        <div className="px-2 pb-2">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索项目或会话"
            className="w-full rounded border border-border bg-background px-2 py-1 text-caption outline-none focus:border-primary/60"
          />
        </div>
      )}

      {renameError && (
        <div className="mx-2 mb-1 rounded bg-destructive/10 px-2 py-1 text-caption text-destructive">
          {renameError}
        </div>
      )}

      {/* Tree */}
      <div className="scrollbar-thin h-0 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1 pb-6">
        {loadingProjects && projects.length === 0 && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {!loadingProjects && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-caption text-muted-foreground">
            {query ? "没有匹配的项目" : "还没有项目"}
          </p>
        )}

        {filtered.map((project) => {
          const isExpanded = expanded.has(project.id);
          const sessions = sessionsByProject[project.id] ?? [];
          const isLoadingSessions = loadingSessions[project.id];
          const isProjectActive =
            !!activeProjectPath &&
            (activeProjectPath === project.path ||
              activeProjectPath.replace(/\\/g, "/") === project.path.replace(/\\/g, "/"));

          return (
            <div key={project.id} className="group/project">
              <div
                className={cn(
                  "flex w-full items-center gap-0.5 rounded transition-colors",
                  "hover:bg-accent/60",
                  isProjectActive && !isExpanded && "bg-accent/40"
                )}
              >
                <button
                  type="button"
                  onClick={() => toggleProject(project)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                >
                  <motion.span
                    animate={{ rotate: isExpanded ? 90 : 0 }}
                    transition={{ duration: 0.15 }}
                    className="text-muted-foreground"
                  >
                    <ChevronRight className="h-3 w-3" />
                  </motion.span>
                  {isExpanded ? (
                    <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary" />
                  ) : (
                    <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body-small">
                    {projectName(project)}
                  </span>
                  <span className="shrink-0 text-caption text-muted-foreground group-hover/project:hidden">
                    {relativeTime((project.most_recent_session ?? project.created_at) * 1000)}
                  </span>
                </button>
                <button
                  type="button"
                  title="删除该项目的历史记录"
                  aria-label="删除该项目的历史记录"
                  onClick={() =>
                    setPendingDelete({
                      kind: "project",
                      project,
                      sessionCount: sessions.length,
                    })
                  }
                  className={cn(
                    "mr-1 hidden shrink-0 rounded p-1 transition-colors group-hover/project:block",
                    "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  )}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>

              {/* Sessions are rendered without a height animation on purpose:
                  animating height:"auto" leaves an explicit pixel height behind
                  if the animation is interrupted (hovering a row changes layout),
                  and the overflow-hidden wrapper then clips the tail of the list
                  so the outer scroller can never reach it. */}
              {isExpanded && (
                <div className="pl-6">
                    {isLoadingSessions && (
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        <span className="text-caption text-muted-foreground">加载中…</span>
                      </div>
                    )}

                    {!isLoadingSessions && sessionErrors[project.id] && (
                      <div className="px-2 py-1.5">
                        <p className="text-caption text-destructive">会话加载失败</p>
                        <button
                          type="button"
                          onClick={() => void loadSessions(project)}
                          className="mt-1 text-caption text-primary underline"
                        >
                          重试
                        </button>
                      </div>
                    )}

                    {!isLoadingSessions && !sessionErrors[project.id] && sessions.length === 0 && (
                      <p className="px-2 py-1.5 text-caption text-muted-foreground">暂无会话</p>
                    )}

                    {sessions.map((session) => {
                      const isActive = session.id === activeSessionId;

                      if (renamingId === session.id) {
                        return (
                          <div
                            key={session.id}
                            className="flex w-full items-center gap-1.5 rounded bg-accent/60 px-2 py-1"
                          >
                            <MessageSquare className="h-3 w-3 shrink-0 text-primary" />
                            <input
                              autoFocus
                              value={renameDraft}
                              onChange={(event) => setRenameDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  void commitRename(project.id, session);
                                } else if (event.key === "Escape") {
                                  event.preventDefault();
                                  setRenamingId(null);
                                }
                              }}
                              onBlur={() => void commitRename(project.id, session)}
                              placeholder="留空则恢复默认标题"
                              maxLength={120}
                              className="min-w-0 flex-1 rounded border border-primary/60 bg-background px-1 py-0.5 text-caption outline-none"
                            />
                          </div>
                        );
                      }

                      return (
                        <div
                          key={session.id}
                          className={cn(
                            "group/session flex w-full items-center gap-0.5 rounded transition-colors",
                            isActive ? "bg-accent text-foreground" : "hover:bg-accent/50"
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => openSession(project, session)}
                            className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
                          >
                            <MessageSquare
                              className={cn(
                                "h-3 w-3 shrink-0",
                                isActive ? "text-primary" : "text-muted-foreground"
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate text-caption">
                              {sessionLabel(session)}
                            </span>
                            <span className="shrink-0 text-caption text-muted-foreground group-hover/session:hidden">
                              {relativeTime(sessionTime(session))}
                            </span>
                          </button>
                          <button
                            type="button"
                            title="重命名该会话"
                            aria-label="重命名该会话"
                            onClick={() => startRename(session)}
                            className={cn(
                              "hidden shrink-0 rounded p-1 transition-colors group-hover/session:block",
                              "text-muted-foreground hover:bg-accent hover:text-foreground"
                            )}
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            title="删除该会话"
                            aria-label="删除该会话"
                            onClick={() =>
                              setPendingDelete({ kind: "session", project, session })
                            }
                            className={cn(
                              "mr-1 hidden shrink-0 rounded p-1 transition-colors group-hover/session:block",
                              "text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                            )}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>

    {/* Deletion confirmation (project or single session) */}
    <Dialog
      open={!!pendingDelete}
      onOpenChange={(open) => {
        if (!open && !isDeleting) {
          setPendingDelete(null);
          setDeleteError(null);
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </div>
            <DialogTitle>
              {pendingDelete?.kind === "project" ? "删除该项目的历史？" : "删除这个会话？"}
            </DialogTitle>
          </div>
          <DialogDescription className="pt-2">
            {pendingDelete?.kind === "project" ? (
              <>
                <span className="font-medium text-foreground">
                  {projectName(pendingDelete.project)}
                </span>{" "}
                的 {pendingDelete.sessionCount} 个会话记录将被永久删除。
              </>
            ) : (
              <>
                会话{" "}
                <span className="font-medium text-foreground">
                  {pendingDelete ? sessionLabel(pendingDelete.session) : ""}
                </span>{" "}
                的记录将被永久删除。
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">源码文件不会被删除</span>
          ，只移除 <code className="px-1">~/.claude/projects</code> 下的对话记录；对应的用量与成本统计也会一起消失。
        </div>

        {deleteError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
            {deleteError}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setPendingDelete(null);
              setDeleteError(null);
            }}
            disabled={isDeleting}
          >
            取消
          </Button>
          <Button variant="destructive" onClick={confirmDelete} disabled={isDeleting}>
            {isDeleting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                删除中…
              </>
            ) : (
              "永久删除"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
};
