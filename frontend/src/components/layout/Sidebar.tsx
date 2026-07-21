import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { it } from 'date-fns/locale';
import { useStore } from '../../store/useStore';
import { projectsApi } from '../../api/projects';
import { chatsApi } from '../../api/chats';
import ProjectModal from '../projects/ProjectModal';
import {
  MessageSquare, FolderOpen, Plus, ChevronDown, ChevronRight,
  Trash2, Settings, LogOut, PanelLeftClose, PanelLeft, Pencil,
  Sun, Moon, Monitor, Users,
} from 'lucide-react';
import { APP_NAME } from '../../config/app.config';
import { useTheme, type ThemePreference } from '../../hooks/useTheme';

// `id` also serves as the i18n key: t(`theme.${id}`)
const THEME_OPTIONS: { id: ThemePreference; icon: React.ElementType }[] = [
  { id: 'light', icon: Sun },
  { id: 'auto',  icon: Monitor },
  { id: 'dark',  icon: Moon },
];

export default function Sidebar() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user, logout, sidebarOpen, setSidebarOpen, activeChatId, setActiveChat, activeProjectId, setActiveProject, activeView, setActiveView } = useStore();
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [showProjectModal, setShowProjectModal] = useState(false);
  const [editProject, setEditProject] = useState<any>(null);
  const { preference: theme, setPreference: setTheme } = useTheme();

  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: projectsApi.list });
  const { data: allChats = [] } = useQuery({ queryKey: ['chats'], queryFn: () => chatsApi.list() });

  // On mobile the sidebar is an overlay: after navigating it must be closed,
  // otherwise it stays on top of the content.
  const closeIfMobile = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false);
  };

  const createChat = useMutation({
    mutationFn: (projectId?: string) => chatsApi.create({ projectId }),
    onSuccess: (chat) => { setActiveChat(chat.id); closeIfMobile(); qc.invalidateQueries({ queryKey: ['chats'] }); },
  });

  const deleteChat = useMutation({
    mutationFn: (id: string) => chatsApi.delete(id),
    onSuccess: (_, id) => {
      if (activeChatId === id) setActiveChat(null);
      qc.invalidateQueries({ queryKey: ['chats'] });
    },
  });

  // On mobile the sidebar starts closed: if open (desktop default) it would cover
  // the content as an overlay right at load time.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) setSidebarOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleProject = (id: string) => {
    setExpandedProjects((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const freeChats = allChats.filter((c) => !c.projectId);

  if (!sidebarOpen) {
    return (
      <div className="w-12 bg-gray-900 border-r border-gray-800 flex flex-col items-center py-3 gap-2">
        <button onClick={() => setSidebarOpen(true)} className="btn-ghost p-2">
          <PanelLeft size={18} />
        </button>
        <button onClick={() => createChat.mutate(undefined)} className="btn-ghost p-2">
          <Plus size={18} />
        </button>
      </div>
    );
  }

  return (
    <>
      {/* Backdrop: on mobile the sidebar is an overlay; tap outside = close */}
      <div
        className="fixed inset-0 bg-black/50 z-30 md:hidden"
        onClick={() => setSidebarOpen(false)}
      />
      <aside className="w-64 bg-gray-900 border-r border-gray-800 flex flex-col h-full
        fixed inset-y-0 left-0 z-40 md:static md:z-auto md:inset-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">AI</span>
            </div>
            <span className="font-semibold text-gray-100 text-sm">{APP_NAME}</span>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="btn-ghost p-1.5">
            <PanelLeftClose size={16} />
          </button>
        </div>

        {/* New Chat */}
        <div className="px-3 py-2">
          <button
            onClick={() => createChat.mutate(undefined)}
            className="w-full flex items-center gap-2 text-sm text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg px-3 py-2 transition-colors"
          >
            <Plus size={16} />
            {t('nav.newChat')}
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">

          {/* Projects */}
          <div className="mt-2">
            <div className="flex items-center justify-between px-2 mb-1">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t('nav.projects')}</span>
              <button
                onClick={() => { setEditProject(null); setShowProjectModal(true); }}
                className="text-gray-500 hover:text-gray-300 p-1 rounded"
              >
                <Plus size={13} />
              </button>
            </div>

            {projects.map((project) => {
              const isExpanded = expandedProjects.has(project.id);
              const shared = !!project.userId && project.userId !== user?.id;

              return (
                <div key={project.id}>
                  <div
                    className="group flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-gray-800 cursor-pointer"
                    onClick={() => toggleProject(project.id)}
                  >
                    <div
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: project.color || '#3b82f6' }}
                    />
                    {isExpanded ? <ChevronDown size={13} className="text-gray-500" /> : <ChevronRight size={13} className="text-gray-500" />}
                    <span className="text-sm text-gray-300 flex-1 truncate">{project.name}</span>
                    {shared && <Users size={12} className="text-gray-500 flex-shrink-0" />}
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); createChat.mutate(project.id); }}
                        className="text-gray-500 hover:text-gray-200 p-0.5 rounded"
                      >
                        <MessageSquare size={12} />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); setEditProject(project); setShowProjectModal(true); }}
                        className="text-gray-500 hover:text-gray-200 p-0.5 rounded"
                      >
                        <Pencil size={12} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <ProjectChatList
                      projectId={project.id}
                      currentUserId={user?.id}
                      activeChatId={activeChatId}
                      onSelect={setActiveChat}
                      onDelete={(id) => deleteChat.mutate(id)}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {/* Free chats */}
          {freeChats.length > 0 && (
            <div className="mt-3">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider px-2 block mb-1">{t('nav.recentChats')}</span>
              {freeChats.map((chat) => (
                <ChatItem
                  key={chat.id}
                  chat={chat}
                  isActive={activeChatId === chat.id}
                  onSelect={() => { setActiveChat(chat.id); closeIfMobile(); }}
                  onDelete={() => deleteChat.mutate(chat.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t border-gray-800 p-3 space-y-2.5">

          {/* Theme toggle — segmented control */}
          <div className="flex items-center gap-1 bg-gray-800 dark:bg-gray-800 rounded-lg p-0.5"
               style={{ background: 'var(--bg-surface-2)' }}>
            {THEME_OPTIONS.map(({ id, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTheme(id)}
                title={t(`theme.${id}`)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-xs
                  transition-all duration-150
                  ${theme === id
                    ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400 shadow-sm font-medium'
                    : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300'
                  }`}
              >
                <Icon size={12} />
                <span className="hidden xl:inline">{t(`theme.${id}`)}</span>
              </button>
            ))}
          </div>

          {/* User row */}
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-700 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.name?.[0]?.toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-200 truncate">{user?.name}</div>
              <div className="text-xs text-gray-500 truncate">{user?.email}</div>
            </div>
            <button
              onClick={() => { setActiveView(activeView === 'settings' ? 'chat' : 'settings'); closeIfMobile(); }}
              className={`p-1.5 rounded-lg transition-colors flex-shrink-0 ${
                activeView === 'settings'
                  ? 'text-blue-400 bg-blue-900/30'
                  : 'text-gray-500 hover:text-gray-300 hover:bg-gray-800'
              }`}
              title={t('nav.settings')}
            >
              <Settings size={15} />
            </button>
            <button
              onClick={logout}
              className="text-gray-500 hover:text-gray-300 p-1.5 rounded-lg hover:bg-gray-800 flex-shrink-0"
              title={t('nav.logout')}
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {showProjectModal && (
        <ProjectModal
          project={editProject}
          onClose={() => setShowProjectModal(false)}
          onSaved={() => { setShowProjectModal(false); qc.invalidateQueries({ queryKey: ['projects'] }); }}
        />
      )}
    </>
  );
}

/** Compact token format: 1234 → 1.2k, 1200000 → 1.2M. */
function fmtTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/**
 * List of a project's chats. Queries the backend by `projectId`, so that in a
 * project shared with the team the colleagues' chats also appear (which the
 * backend exposes to all members). Others' chats are marked read-only.
 */
function ProjectChatList({
  projectId, currentUserId, activeChatId, onSelect, onDelete,
}: {
  projectId: string;
  currentUserId?: string;
  activeChatId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { data: chats = [], isLoading } = useQuery({
    queryKey: ['chats', projectId],
    queryFn: () => chatsApi.list(projectId),
  });

  if (isLoading) return <p className="text-xs text-gray-600 pl-8 py-1">{t('actions.loading')}</p>;
  if (!chats.length) return <p className="text-xs text-gray-600 pl-8 py-1">{t('nav.noChats')}</p>;

  return (
    <>
      {chats.map((chat) => {
        const foreign = !!chat.authorId && !!currentUserId && chat.authorId !== currentUserId;
        return (
          <ChatItem
            key={chat.id}
            chat={chat}
            isActive={activeChatId === chat.id}
            onSelect={() => onSelect(chat.id)}
            onDelete={() => onDelete(chat.id)}
            indent
            foreign={foreign}
            authorName={foreign ? chat.authorName : null}
          />
        );
      })}
    </>
  );
}

function ChatItem({
  chat, isActive, onSelect, onDelete, indent = false, foreign = false, authorName = null,
}: {
  chat: any; isActive: boolean; onSelect: () => void; onDelete: () => void;
  indent?: boolean; foreign?: boolean; authorName?: string | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const showTokenCount = useStore((s) => (s.user as any)?.showTokenCount ?? false);
  const inTok  = chat.totalInputTokens  ?? 0;
  const outTok = chat.totalOutputTokens ?? 0;
  const total  = inTok + outTok;
  const unread = !!chat.unread && !isActive;

  // Opening the chat marks it read (clears the sidebar badge).
  const handleSelect = () => {
    onSelect();
    if (chat.unread) {
      chatsApi.markRead(chat.id)
        .then(() => qc.invalidateQueries({ queryKey: ['chats'] }))
        .catch(() => undefined);
    }
  };

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
        isActive ? 'bg-gray-700/80 text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
      } ${indent ? 'ml-5' : ''}`}
      onClick={handleSelect}
      title={foreign && authorName ? t('nav.chatOf', { name: authorName }) : undefined}
    >
      {unread
        ? <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-400" title={t('nav.unread')} />
        : <MessageSquare size={13} className="flex-shrink-0 opacity-60" />}
      <span className={`text-sm flex-1 truncate ${unread ? 'font-semibold text-gray-100' : ''}`}>{chat.title}</span>
      {foreign && authorName && (
        <span className="flex-shrink-0 text-[10px] text-gray-500 group-hover:hidden truncate max-w-[60px]">
          {authorName.split(' ')[0]}
        </span>
      )}
      {showTokenCount && total > 0 && (
        <span
          className="flex-shrink-0 text-[10px] font-mono text-gray-500 group-hover:hidden tabular-nums"
          title={`Token — input: ${inTok.toLocaleString()} · output: ${outTok.toLocaleString()}`}
        >
          {fmtTokensCompact(total)}
        </span>
      )}
      {!foreign && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="hidden group-hover:block text-gray-600 hover:text-red-400 p-0.5"
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  );
}
