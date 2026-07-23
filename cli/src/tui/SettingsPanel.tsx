// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import {Box, Text, useInput} from 'ink';
import React, {useState} from 'react';
import type {CliConfig} from '../config.js';
import {
    DataSourcesTab,
    LlmTab,
    McpTab,
    ProfileTab,
    SkillsTab,
    ToolsTab,
    UsageTab,
    type TabProps,
} from './settingsTabs.js';

interface TabDef {
    id: string;
    label: string;
    component: (props: TabProps) => React.JSX.Element;
}

const TABS: TabDef[] = [
    {id: 'profile', label: 'Profile', component: ProfileTab},
    {id: 'llm', label: 'LLM', component: LlmTab},
    {id: 'tools', label: 'Tools', component: ToolsTab},
    {id: 'skills', label: 'Skills', component: SkillsTab},
    {id: 'data', label: 'Data', component: DataSourcesTab},
    {id: 'mcp', label: 'MCP', component: McpTab},
    {id: 'usage', label: 'Usage', component: UsageTab},
];

export default function SettingsPanel({cfg, onClose}: {cfg: CliConfig; onClose: () => void}): React.JSX.Element {
    const [active, setActive] = useState(0);
    // A tab in a modal state (form/confirm) owns the keyboard: no tab
    // switching or panel close until it unlocks.
    const [locked, setLocked] = useState(false);

    useInput((char, key) => {
        if (locked) return;
        if (key.escape || char === 'q') {
            onClose();
            return;
        }
        if (key.leftArrow) setActive((current) => (current + TABS.length - 1) % TABS.length);
        if (key.rightArrow || key.tab) setActive((current) => (current + 1) % TABS.length);
        const digit = Number.parseInt(char, 10);
        if (!Number.isNaN(digit) && digit >= 1 && digit <= TABS.length) setActive(digit - 1);
    });

    const ActiveTab = TABS[active].component;

    return (
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor="yellow" paddingX={1} overflow="hidden">
            <Box>
                <Text bold color="yellow">
                    Settings{' '}
                </Text>
                {TABS.map((tab, index) => (
                    <React.Fragment key={tab.id}>
                        {index === active ? (
                            <Text backgroundColor="yellow" color="black">
                                {` ${index + 1} ${tab.label} `}
                            </Text>
                        ) : (
                            <Text dimColor>{` ${index + 1} ${tab.label} `}</Text>
                        )}
                    </React.Fragment>
                ))}
            </Box>
            <Box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
                {/* key remounts the tab on switch so it re-fetches fresh data */}
                <ActiveTab key={TABS[active].id} cfg={cfg} onLockChange={setLocked} />
            </Box>
            {locked ? null : <Text dimColor>←/→ or 1-{TABS.length}: switch tab │ Esc: close</Text>}
        </Box>
    );
}
