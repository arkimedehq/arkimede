// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {Box, Text, useApp, useInput, useStdout} from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {chatsApi} from '../api/chats.js';
import {ApiError} from '../api/http.js';
import {messagesApi} from '../api/messages.js';
import type {CliConfig} from '../config.js';
import type {Chat, Message} from '../types.js';
import {previewInput, renderMarkdown} from '../ui/render.js';
import {dbg} from './debug.js';
import SettingsPanel from './SettingsPanel.js';

/** One display row group in the messages pane. */
type Item =
    | {kind: 'user'; text: string; author?: string}
    | {kind: 'assistant'; text: string; live?: boolean}
    | {kind: 'agent'; agent: string; role?: string | null; text: string}
    | {kind: 'status'; text: string}
    | {kind: 'error'; text: string};

const SIDEBAR_WIDTH = 30;
const MAX_RENDERED_ITEMS = 120;

function historyToItems(messages: Message[]): Item[] {
    const items: Item[] = [];
    for (const msg of messages) {
        if (msg.role === 'user') {
            items.push({kind: 'user', text: msg.content, author: msg.authorName});
        } else if (msg.role === 'assistant') {
            for (const call of msg.toolCalls ?? []) {
                items.push({kind: 'status', text: `${call.ok === false ? '✗' : '⚙'} ${call.name} ${previewInput(call.input)}`});
            }
            items.push({kind: 'assistant', text: renderMarkdown(msg.content)});
        } else {
            items.push({kind: 'status', text: msg.content});
        }
    }
    return items;
}

function ItemView({item}: {item: Item}): React.JSX.Element {
    switch (item.kind) {
        case 'user':
            return (
                <Box flexDirection="column" marginTop={1}>
                    <Text color="green" bold>
                        › {item.author ? `${item.author}` : 'you'}
                    </Text>
                    <Text>{item.text}</Text>
                </Box>
            );
        case 'assistant':
            return (
                <Box flexDirection="column" marginTop={1}>
                    <Text color="cyan" bold>
                        ● assistant{item.live ? ' …' : ''}
                    </Text>
                    <Text>{item.text}</Text>
                </Box>
            );
        case 'agent':
            return (
                <Box flexDirection="column" marginTop={1}>
                    <Text color="magenta" bold>
                        ◆ {item.agent}
                        {item.role ? <Text dimColor> · {item.role}</Text> : null}
                    </Text>
                    <Text>{item.text}</Text>
                </Box>
            );
        case 'status':
            return <Text dimColor>{item.text}</Text>;
        case 'error':
            return <Text color="red">⚠ {item.text}</Text>;
    }
}

function ChatList(props: {
    chats: Chat[];
    activeId: string;
    selected: number;
    focused: boolean;
    height: number;
}): React.JSX.Element {
    const {chats, activeId, selected, focused, height} = props;
    // Keep the selected row inside the visible window.
    const visibleRows = Math.max(height - 4, 1);
    const start = Math.max(0, Math.min(selected - visibleRows + 1, chats.length - visibleRows));
    return (
        <Box
            flexDirection="column"
            width={SIDEBAR_WIDTH}
            flexShrink={0}
            borderStyle="round"
            borderColor={focused ? 'green' : 'gray'}
            paddingX={1}
            overflow="hidden"
        >
            <Text bold color={focused ? 'green' : undefined}>
                Chats <Text dimColor>({chats.length})</Text>
            </Text>
            {chats.slice(start, start + visibleRows).map((chat, i) => {
                const index = start + i;
                const isSel = index === selected;
                const isActive = chat.id === activeId;
                const label = (chat.title || '(untitled)').slice(0, SIDEBAR_WIDTH - 6);
                return (
                    <Text
                        key={chat.id}
                        color={isSel && focused ? 'black' : isActive ? 'cyan' : undefined}
                        backgroundColor={isSel && focused ? 'green' : undefined}
                        wrap="truncate"
                    >
                        {isActive ? '● ' : '  '}
                        {label}
                    </Text>
                );
            })}
            <Box marginTop={1} flexDirection="column">
                <Text dimColor>[n] new chat</Text>
                <Text dimColor>[s] settings</Text>
            </Box>
        </Box>
    );
}

export default function App({cfg, initialChat}: {cfg: CliConfig; initialChat: Chat}): React.JSX.Element {
    const {exit} = useApp();
    const {stdout} = useStdout();
    const [rows, setRows] = useState(stdout.rows || 24);
    const [chats, setChats] = useState<Chat[]>([initialChat]);
    const [chat, setChat] = useState<Chat>(initialChat);
    const [items, setItems] = useState<Item[]>([]);
    const [input, setInput] = useState('');
    const [focus, setFocus] = useState<'input' | 'chats'>('input');
    const [view, setView] = useState<'chat' | 'settings'>('chat');
    const [selected, setSelected] = useState(0);
    const [streaming, setStreaming] = useState(false);
    const [scroll, setScroll] = useState(0);
    const abortRef = useRef<AbortController | null>(null);
    const itemsLenRef = useRef(0);
    itemsLenRef.current = items.length;

    useEffect(() => {
        const onResize = () => setRows(stdout.rows || 24);
        stdout.on('resize', onResize);
        return () => {
            stdout.off('resize', onResize);
        };
    }, [stdout]);

    const refreshChats = useCallback(async () => {
        try {
            const list = await chatsApi.list(cfg);
            setChats(list);
            return list;
        } catch {
            return null;
        }
    }, [cfg]);

    const openChat = useCallback(
        async (target: Chat) => {
            setChat(target);
            setScroll(0);
            try {
                const messages = await messagesApi.list(cfg, target.id);
                setItems(historyToItems(messages));
            } catch (err) {
                setItems([{kind: 'error', text: err instanceof Error ? err.message : String(err)}]);
            }
        },
        [cfg],
    );

    dbg('App: render pass');

    // Initial load: chat list + history of the initial chat.
    useEffect(() => {
        dbg('App: mount effect running');
        void refreshChats().then((list) => {
            if (list) setSelected(Math.max(0, list.findIndex((c) => c.id === initialChat.id)));
        });
        void openChat(initialChat);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const newChat = useCallback(async () => {
        try {
            const created = await chatsApi.create(cfg);
            setChats((prev) => [created, ...prev]);
            setSelected(0);
            await openChat(created);
        } catch (err) {
            setItems((prev) => [...prev, {kind: 'error', text: err instanceof Error ? err.message : String(err)}]);
        }
    }, [cfg, openChat]);

    const send = useCallback(
        async (text: string) => {
            const content = text.trim();
            if (!content || streaming) return;
            setInput('');
            setScroll(0);
            setItems((prev) => [...prev, {kind: 'user', text: content}]);
            setStreaming(true);
            const controller = new AbortController();
            abortRef.current = controller;

            // Text between tool events forms one "segment": streamed raw, then
            // re-rendered as Markdown when the segment (or the turn) completes.
            let segment = '';
            let live = false;
            const endSegment = () => {
                if (!live) return;
                const rendered = renderMarkdown(segment);
                setItems((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last?.kind === 'assistant' && last.live) next[next.length - 1] = {kind: 'assistant', text: rendered};
                    return next;
                });
                live = false;
                segment = '';
            };
            const pushItem = (item: Item) => {
                endSegment();
                setItems((prev) => [...prev, item]);
            };
            const appendChunk = (content: string) => {
                segment += content;
                const textNow = segment;
                setItems((prev) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (live && last?.kind === 'assistant' && last.live) {
                        next[next.length - 1] = {kind: 'assistant', text: textNow, live: true};
                    } else {
                        next.push({kind: 'assistant', text: textNow, live: true});
                    }
                    return next;
                });
                live = true;
            };

            try {
                await messagesApi.stream(
                    cfg,
                    chat.id,
                    content,
                    {
                        onChunk: appendChunk,
                        onToolCall: (call) => pushItem({kind: 'status', text: `⚙ ${call.name} ${previewInput(call.input)}`}),
                        onToolResult: (name, ok) => pushItem({kind: 'status', text: `${ok ? '✓' : '✗'} ${name}`}),
                        onFile: (name, _rel, downloadUrl) =>
                            pushItem({kind: 'status', text: `📄 ${name}${downloadUrl ? ` → ${cfg.baseUrl}${downloadUrl}` : ''}`}),
                        onAgentStep: (step) =>
                            pushItem({kind: 'agent', agent: step.agent, role: step.role, text: renderMarkdown(step.output)}),
                        onMemoryProposal: (proposals) =>
                            pushItem({kind: 'status', text: `☆ ${proposals.length} memory proposal(s) — review in the web UI`}),
                        onError: (message, code) => pushItem({kind: 'error', text: `${code ? `[${code}] ` : ''}${message}`}),
                        onDone: (_id, inputTokens, outputTokens) =>
                            pushItem({kind: 'status', text: `[tokens ↑${inputTokens ?? '–'} ↓${outputTokens ?? '–'}]`}),
                    },
                    controller.signal,
                );
                endSegment();
            } catch (err) {
                endSegment();
                if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
                    setItems((prev) => [...prev, {kind: 'status', text: '⏹ generation stopped'}]);
                } else if (err instanceof ApiError && err.status === 401) {
                    setItems((prev) => [...prev, {kind: 'error', text: 'Session expired. Run `arkimede login` again.'}]);
                } else {
                    setItems((prev) => [...prev, {kind: 'error', text: err instanceof Error ? err.message : String(err)}]);
                }
            } finally {
                abortRef.current = null;
                setStreaming(false);
                void refreshChats();
            }
        },
        [cfg, chat.id, streaming, refreshChats],
    );

    useInput((char, key) => {
        dbg(`App: key received ${JSON.stringify(char)}`);
        // While the settings panel is open it owns the keyboard.
        if (view === 'settings') return;
        if (key.escape) {
            if (abortRef.current) abortRef.current.abort();
            else if (focus === 'chats') setFocus('input');
            return;
        }
        if (key.tab) {
            setFocus((f) => (f === 'input' ? 'chats' : 'input'));
            return;
        }
        if (key.pageUp) setScroll((s) => Math.min(s + 5, Math.max(itemsLenRef.current - 1, 0)));
        if (key.pageDown) setScroll((s) => Math.max(s - 5, 0));
        if (focus === 'input') {
            if (key.upArrow) setScroll((s) => Math.min(s + 1, Math.max(itemsLenRef.current - 1, 0)));
            if (key.downArrow) setScroll((s) => Math.max(s - 1, 0));
            return;
        }
        // Sidebar focus.
        if (key.upArrow) setSelected((s) => Math.max(0, s - 1));
        if (key.downArrow) setSelected((s) => Math.min(chats.length - 1, s + 1));
        if (key.return) {
            const target = chats[selected];
            if (target) {
                void openChat(target);
                setFocus('input');
            }
        }
        if (char === 'n') {
            void newChat();
            setFocus('input');
        }
        if (char === 's') setView('settings');
        if (char === 'q') exit();
    });

    const visible = items.slice(0, items.length - scroll).slice(-MAX_RENDERED_ITEMS);

    if (view === 'settings') {
        return (
            <Box flexDirection="column" width="100%" height={rows}>
                <SettingsPanel
                    cfg={cfg}
                    onClose={() => {
                        setView('chat');
                        setFocus('input');
                    }}
                />
                <Box paddingX={1} flexShrink={0}>
                    <Text dimColor wrap="truncate">
                        {cfg.user?.email ?? '?'} @ {cfg.baseUrl} │ Esc: close settings │ Ctrl+C: quit
                    </Text>
                </Box>
            </Box>
        );
    }

    return (
        <Box flexDirection="column" width="100%" height={rows}>
            <Box flexGrow={1}>
                <ChatList chats={chats} activeId={chat.id} selected={selected} focused={focus === 'chats'} height={rows - 5} />
                <Box
                    flexDirection="column"
                    flexGrow={1}
                    borderStyle="round"
                    borderColor={focus === 'input' ? 'cyan' : 'gray'}
                    paddingX={1}
                    overflow="hidden"
                >
                    <Text bold color="cyan" wrap="truncate">
                        {chat.title || '(untitled)'}
                        <Text dimColor> — {chat.id}</Text>
                        {scroll > 0 ? <Text color="yellow"> ↑{scroll}</Text> : null}
                    </Text>
                    <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
                        {visible.map((item, i) => (
                            <ItemView key={`${items.length - scroll}-${i}`} item={item} />
                        ))}
                    </Box>
                </Box>
            </Box>
            <Box borderStyle="round" borderColor={streaming ? 'yellow' : 'green'} paddingX={1} flexShrink={0}>
                {streaming ? (
                    <Text color="yellow">
                        <Spinner type="dots" /> streaming — Esc to stop{' '}
                    </Text>
                ) : (
                    <Text color="green" bold>
                        ›{' '}
                    </Text>
                )}
                <TextInput
                    value={input}
                    onChange={setInput}
                    onSubmit={(value) => void send(value)}
                    focus={focus === 'input'}
                    placeholder={streaming ? '' : 'type a message…'}
                />
            </Box>
            <Box paddingX={1} flexShrink={0}>
                <Text dimColor wrap="truncate">
                    {cfg.user?.email ?? '?'} @ {cfg.baseUrl} │ Tab: chats │ ↑/↓ PgUp/PgDn: scroll │ Esc: stop │ Ctrl+C: quit
                </Text>
            </Box>
        </Box>
    );
}
