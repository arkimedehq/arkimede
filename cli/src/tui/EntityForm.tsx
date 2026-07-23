// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

// Generic create/edit form used by the settings tabs. Field navigation:
// ↑/↓ or Tab (Enter in a text field also advances), ←/→ or Space cycles an
// enum field, Enter on [Save] submits, Esc cancels. All values are strings;
// the caller's onSubmit maps them to an API payload and may throw an Error
// to display a validation/server message.

import {Box, Text, useInput} from 'ink';
import Spinner from 'ink-spinner';
import TextInput from 'ink-text-input';
import React, {useState} from 'react';

export type FieldDef = {
    id: string;
    label: string;
    /** Hide the field depending on the current values (e.g. per-type config). */
    visibleIf?: (values: Record<string, string>) => boolean;
} & (
    | {kind: 'text'; mask?: string; placeholder?: string}
    | {kind: 'enum'; options: readonly string[]}
);

export default function EntityForm(props: {
    title: string;
    fields: FieldDef[];
    initial: Record<string, string>;
    onSubmit: (values: Record<string, string>) => Promise<void>;
    onCancel: () => void;
}): React.JSX.Element {
    const {title, fields, initial, onSubmit, onCancel} = props;
    const [values, setValues] = useState<Record<string, string>>(() => {
        const seed: Record<string, string> = {};
        for (const field of fields) {
            seed[field.id] = initial[field.id] ?? (field.kind === 'enum' ? field.options[0] : '');
        }
        return seed;
    });
    const [focused, setFocused] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const visible = fields.filter((field) => field.visibleIf?.(values) ?? true);
    // Focus order: visible fields, then the Save row.
    const focusCount = visible.length + 1;
    const focusIndex = Math.min(focused, focusCount - 1);
    const focusedField = focusIndex < visible.length ? visible[focusIndex] : null;
    const move = (delta: number) => setFocused((focusIndex + delta + focusCount) % focusCount);

    const cycle = (field: Extract<FieldDef, {kind: 'enum'}>, delta: number) => {
        const index = field.options.indexOf(values[field.id]);
        const next = field.options[(Math.max(index, 0) + delta + field.options.length) % field.options.length];
        setValues((prev) => ({...prev, [field.id]: next}));
    };

    const submit = () => {
        setBusy(true);
        setError(null);
        void onSubmit(values).catch((err: unknown) => {
            setBusy(false);
            setError(err instanceof Error ? err.message : String(err));
        });
    };

    useInput((char, key) => {
        if (busy) return;
        if (key.escape) {
            onCancel();
            return;
        }
        if (key.downArrow || (key.tab && !key.shift)) move(1);
        else if (key.upArrow || (key.tab && key.shift)) move(-1);
        else if (focusedField?.kind === 'enum') {
            if (key.leftArrow) cycle(focusedField, -1);
            if (key.rightArrow || char === ' ') cycle(focusedField, 1);
            if (key.return) move(1);
        } else if (focusedField === null && (key.return || char === ' ')) {
            submit();
        }
    });

    return (
        <Box flexDirection="column">
            <Text bold color="yellow">
                {title}
            </Text>
            <Box marginTop={1} flexDirection="column">
                {visible.map((field, index) => {
                    const isFocused = focusIndex === index && !busy;
                    return (
                        <Box key={field.id}>
                            <Box width={16}>
                                <Text color={isFocused ? 'yellow' : undefined} dimColor={!isFocused}>
                                    {field.label}
                                </Text>
                            </Box>
                            {field.kind === 'enum' ? (
                                <Text color={isFocused ? 'yellow' : undefined}>
                                    {isFocused ? '‹ ' : '  '}
                                    {values[field.id] || field.options[0]}
                                    {isFocused ? ' ›' : ''}
                                </Text>
                            ) : (
                                <TextInput
                                    value={values[field.id]}
                                    onChange={(value) => setValues((prev) => ({...prev, [field.id]: value}))}
                                    onSubmit={() => move(1)}
                                    focus={isFocused}
                                    mask={field.mask}
                                    placeholder={field.placeholder ?? ''}
                                />
                            )}
                        </Box>
                    );
                })}
            </Box>
            <Box marginTop={1}>
                {busy ? (
                    <Text color="yellow">
                        <Spinner type="dots" /> saving…
                    </Text>
                ) : (
                    <Text
                        backgroundColor={focusedField === null ? 'green' : undefined}
                        color={focusedField === null ? 'black' : 'green'}
                    >
                        {' Save '}
                    </Text>
                )}
            </Box>
            {error ? <Text color="red">⚠ {error}</Text> : null}
            <Box marginTop={1}>
                <Text dimColor>↑/↓ Tab: fields │ ←/→: cycle values │ Enter on Save: submit │ Esc: cancel</Text>
            </Box>
        </Box>
    );
}
