import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronRight,
  Folder,
  FolderOpen,
  MessageSquare,
  Search,
  RefreshCw,
  Plus,
  Loader2,
} from "lucide-react";
import { api, type Project, type Session } from "@/lib/api";
import { useTabState } from "@/hooks/useTabState";
import { cn } from "@/lib/utils";

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
  } = useTabState();

  const [projects, setProjects] = useState<Project[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [loadingSessions, setLoadingSessions] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);

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
    try {
      const sessions = await api.getProjectSessions(project.id);
      const sorted = [...sessions].sort((a, b) => sessionTime(b) - sessionTime(a));
      setSessionsByProject((prev) => ({ ...prev, [project.id]: sorted }));
    } catch (err) {
      console.error("[WorkspaceSidebar] Failed to load sessions:", err);
      setSessionsByProject((prev) => ({ ...prev, [project.id]: [] }));
    } finally {
      setLoadingSessions((prev) => ({ ...prev, [project.id]: false }));
    }
  }, []);

  const toggleProject = useCallback(
    (project: Project) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(project.id)) {
          next.delete(project.id);
        } else {
          next.add(project.id);
          if (!sessionsByProject[project.id]) {
            void loadSessions(project);
          }
        }
        return next;
      });
    },
    [loadSessions, sessionsByProject]
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;

    return projects.filter((project) => {
      if (projectName(project).toLowerCase().includes(q)) return true;
      if (project.path.toLowerCase().includes(q)) return true;
      const sessions = sessionsByProject[project.id] ?? [];
      return sessions.some((s) => sessionLabel(s).toLowerCase().includes(q));
    });
  }, [projects, query, sessionsByProject]);

  return (
    <aside
      className={cn(
        "flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-muted/20",
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

      {/* Tree */}
      <div className="flex-1 overflow-y-auto px-1 pb-2">
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
            <div key={project.id}>
              <button
                type="button"
                onClick={() => toggleProject(project)}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors",
                  "hover:bg-accent/60",
                  isProjectActive && !isExpanded && "bg-accent/40"
                )}
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
                <span className="shrink-0 text-caption text-muted-foreground">
                  {relativeTime((project.most_recent_session ?? project.created_at) * 1000)}
                </span>
              </button>

              <AnimatePresence initial={false}>
                {isExpanded && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden pl-6"
                  >
                    {isLoadingSessions && (
                      <div className="flex items-center gap-2 px-2 py-1.5">
                        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                        <span className="text-caption text-muted-foreground">加载中…</span>
                      </div>
                    )}

                    {!isLoadingSessions && sessions.length === 0 && (
                      <p className="px-2 py-1.5 text-caption text-muted-foreground">暂无会话</p>
                    )}

                    {sessions.map((session) => {
                      const isActive = session.id === activeSessionId;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          onClick={() => openSession(project, session)}
                          className={cn(
                            "group flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left transition-colors",
                            isActive ? "bg-accent text-foreground" : "hover:bg-accent/50"
                          )}
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
                          <span className="shrink-0 text-caption text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                            {relativeTime(sessionTime(session))}
                          </span>
                        </button>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </aside>
  );
};
