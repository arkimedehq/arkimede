// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import { useStore } from './store/useStore';
import './i18n';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000 * 30, retry: 1 } },
});

// Cross-user cache guard: the QueryClient outlives the auth session, so any
// change of the authenticated identity (logout, login as someone else) must
// drop every cached server response — otherwise the next user of the same
// browser sees the previous user's cached data (chat list, messages, files…)
// until a refetch happens to replace it.
let lastUserId = useStore.getState().user?.id ?? null;
useStore.subscribe((state) => {
  const userId = state.user?.id ?? null;
  if (userId !== lastUserId) {
    lastUserId = userId;
    queryClient.clear();
  }
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
