import { useTranslation } from 'react-i18next';
import Sidebar from '../components/layout/Sidebar';
import GlobalHeader from '../components/layout/GlobalHeader';
import ChatWindow from '../components/chat/ChatWindow';
import SettingsPage from './SettingsPage';
import { NotificationToasts } from '../components/notifications/NotificationToasts';
import { useStore } from '../store/useStore';
import { chatsApi } from '../api/chats';
import { useUserLanguage } from '../hooks/useUserLanguage';

export default function DashboardPage() {
  const activeChatId = useStore((s) => s.activeChatId);
  const activeView   = useStore((s) => s.activeView);
  useUserLanguage(); // apply the profile language to the whole app after login

  return (
    <div className="flex h-full overflow-hidden" style={{ backgroundColor: 'var(--bg-base)' }}>
      <Sidebar />

      {/* Right column: persistent header + content.
          min-w-0: without it, wide content (horizontal nav, tables) pushes
          the column beyond the viewport instead of staying internally scrollable. */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <GlobalHeader />

        <main className="flex-1 min-w-0 min-h-0 overflow-hidden flex flex-col">
          {activeView === 'settings' ? (
            <SettingsPage />
          ) : activeChatId ? (
            <ChatWindow chatId={activeChatId} />
          ) : (
            <WelcomeScreen />
          )}
        </main>
      </div>

      {/* Daemon notification toasts — visible in all views */}
      <NotificationToasts />
    </div>
  );
}

function WelcomeScreen() {
  const { t } = useTranslation('common');
  const user = useStore((s) => s.user);
  const setActiveChat = useStore((s) => s.setActiveChat);
  const createNewChat = async () => {
    try {
      const chat = await chatsApi.create({ title: t('nav.newChat') });
      setActiveChat(chat.id);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
    <div className="min-h-full flex flex-col items-center justify-center p-6 sm:p-8 text-center">
      <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center mb-6">
        <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      </div>

      <h1 className="text-3xl font-bold text-white mb-2">
        {t('dashboard.greeting', { name: user?.name?.split(' ')[0] })}
      </h1>
      <p className="text-gray-400 mb-8 max-w-md">
        {t('dashboard.intro')}
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-2xl w-full mb-8">
        {[
          { icon: '📊', title: t('dashboard.card1Title'), desc: t('dashboard.card1Desc') },
          { icon: '📄', title: t('dashboard.card2Title'), desc: t('dashboard.card2Desc') },
          { icon: '🏗️', title: t('dashboard.card3Title'), desc: t('dashboard.card3Desc') },
        ].map((item) => (
          <div key={item.title} className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-left hover:border-gray-700 transition-colors dark:bg-gray-900 dark:border-gray-800">
            <div className="text-2xl mb-2">{item.icon}</div>
            <div className="font-medium text-gray-100 mb-1">{item.title}</div>
            <div className="text-sm text-gray-500">{item.desc}</div>
          </div>
        ))}
      </div>

      <button onClick={createNewChat} className="btn-primary px-6 py-3 text-base">
        {t('dashboard.startChat')}
      </button>
    </div>
    </div>
  );
}
