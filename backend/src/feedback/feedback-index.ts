// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright © 2026 Andrea Genovese

import type { Feedback } from './feedback.entity';

/** Vector collection of feedback corrections. */
export const FEEDBACK_COLLECTION = 'feedback_memory';

/**
 * Text embedded for a feedback item (query side): the question that produced the rated
 * answer, else the answer, else the comment. Single source for the writer and re-embed.
 */
export function feedbackIndexText(f: Pick<Feedback, 'question' | 'answer' | 'comment'>): string {
  return f.question?.trim() || f.answer?.trim() || f.comment || '';
}
