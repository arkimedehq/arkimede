/**
 * @file prompts.ts
 *
 * SINGLE HOME for every HARD-CODED, agent-facing prompt text in the backend.
 * A developer can tune the agent's wording here, in one place, without hunting
 * through the services.
 *
 * IN SCOPE (defined here): the base default, the system-prompt building blocks
 * (language line, memory/summary/feedback/date blocks), the built-in tool
 * descriptions, the background prompts (history summarizer, memory extraction),
 * and the multi-agent orchestration texts.
 *
 * OUT OF SCOPE (deliberately NOT here):
 *   - Runtime-editable prompts that live in the DB and have their own admin UI:
 *     `app_config.systemPrompt` (base), `users.systemPrompt`, `projects.systemPrompt`,
 *     `agents.systemPrompt`. Editing them here would have no effect.
 *   - Per-parameter `.describe()` texts of the tool schemas: they stay inline next
 *     to their Zod schema (tightly coupled).
 *   - DataSource schema-enrichment prompts (`datasources/schema-enrichment.service.ts`):
 *     admin-time DB introspection, coupled to their JSON output parsing.
 *
 * The strings are English (cross-provider system prompt: a single system message —
 * Anthropic accepts only one system, Gemini alternates roles).
 *
 * Human-readable companion (with file:line map): `docs/PROMPTS.md`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Base default (the REAL base prompt is `app_config.systemPrompt`, admin-editable)
// ─────────────────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = 'You are an AI assistant';

// ─────────────────────────────────────────────────────────────────────────────
// System-prompt building blocks (assembled in AgentService)
// ─────────────────────────────────────────────────────────────────────────────

/** Response-language directive (kept in the single system prompt, cross-provider). */
export function languageLine(langName: string): string {
  return `Always respond to the user in ${langName}, regardless of the language of the context or tool outputs.`;
}

/** Durable, confirmed user facts (cached prefix). */
export function userMemoryBlock(facts: string[]): string {
  return (
    `## Memory: what I know about the user\n` +
    `(Take these durable facts about the user into account; do not list them explicitly.)\n` +
    facts.map((f) => `- ${f}`).join('\n')
  );
}

/** Rolling summary of the older conversation (non-cached block). */
export function summaryBlock(summary: string): string {
  return (
    `## Context: summary of the previous conversation\n` +
    `(Use it as memory of the initial part of the chat; do not repeat it to the user.)\n\n${summary.trim()}`
  );
}

/** Corrections retrieved from past 👍/👎 feedback (non-cached block). */
export function feedbackBlock(
  hits: { rating: string; question: string; comment: string }[],
): string {
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
  const lines = hits.map((h) => {
    const verdict = h.rating === 'down' ? 'Error to avoid' : 'Appreciated behavior';
    return `- [${verdict}] On a similar question ("${clip(h.question, 200)}"):\n` +
           `  ${clip(h.comment, 500)}`;
  });
  return (
    `## Memory: corrections from past feedback\n` +
    `(Take these user corrections on similar answers into account; do not cite them explicitly.)\n\n` +
    lines.join('\n')
  );
}

/** Long-term notes retrieved for the current request (non-cached block). */
export function memoryBlock(notes: { content: string; context?: string | null }[]): string {
  return (
    `## Memory: notes about the user relevant now\n` +
    `(Long-term facts retrieved for this request; use them, do not cite them explicitly.)\n\n` +
    notes.map((n) => `- ${n.content}${n.context ? ` _(${n.context})_` : ''}`).join('\n')
  );
}

/** Absolute time reference (non-cached block; `nowIso` already formatted by the caller). */
export function nowBlock(nowIso: string, tz: string): string {
  return (
    `## Current date and time\n` +
    `It is now ${nowIso} (${tz}).\n` +
    `For any relative time reference ("in 3 minutes", "tomorrow at 8", "every morning") ` +
    `ALWAYS compute date and time starting from this instant. For automations (schedule_task) ` +
    `derive "runAt" (in ISO 8601 with offset) and the timezone from here.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in tool descriptions (the per-parameter `.describe()` stay inline)
// ─────────────────────────────────────────────────────────────────────────────

export const GET_CURRENT_DATETIME_DESC =
  'Returns the current date and time in ISO 8601 format with timezone offset. ' +
  'Use it to compute relative times ("in 3 minutes", "tomorrow at 8") or to schedule automations.';

export const SCHEDULE_TASK_DESC =
  'PREPARES (without activating it yet) an automation to run in the future, once or recurring. ' +
  'Use it when the user asks to do/remember something later or periodically ' +
  '(e.g. "every morning at 8 check the mail and summarize", "in an hour remind me X"). ' +
  'instruction = what to do, COMPLETE and self-contained (at fire time it won\'t have this chat\'s context). ' +
  'For recurring provide "cron" (5 fields, e.g. "0 8 * * *"); for one-time "runAt" (ISO 8601). ' +
  'With "tools" indicate ONLY the tools the task needs (default: none → cheaper); ' +
  'e.g. for "check the mail" pass the name of the mail tool. ' +
  'AFTER calling this tool, SUMMARIZE for the user what you prepared (what + when + which tools) and ' +
  'ASK for explicit CONFIRMATION; then use confirm_scheduled_task with their response.';

export const CONFIRM_SCHEDULED_TASK_DESC =
  'Confirms or cancels an automation just prepared with schedule_task, based on the user\'s response. ' +
  'confirm=true ACTIVATES it (it will start firing); confirm=false deletes it.';

export const SAVE_MEMORY_DESC =
  'Records a DURABLE, REUSABLE fact about the user in long-term memory (survives across chats). ' +
  'Use it ONLY when the user explicitly asks to remember something ("ricordati che…", "remember that…") ' +
  'or states a lasting preference/constraint/decision worth recalling later. ' +
  'Do NOT use it for ephemeral details tied to the current request. ' +
  'The fact is saved as a PROPOSAL the user confirms from the memory panel — tell the user you noted it and that it awaits their confirmation.';

export const SEARCH_MEMORY_DESC =
  'Searches the user\'s long-term memory for facts relevant to a query, BEYOND the ones already ' +
  'provided in context. Use it when you need to recall something specific about the user (a past ' +
  'preference, a detail, a decision) that is not in the current context. Returns the matching notes.';

export const SEARCH_CONVERSATIONS_DESC =
  'Searches PAST CONVERSATIONS (the raw chat transcript) for when/where something was discussed — ' +
  'e.g. "when did we talk about the backup schedule?", "find the chat where I described the VPN setup". ' +
  'Complementary to save_memory/search_memory (which hold curated facts): this is raw episodic recall ' +
  'across the user\'s accessible chats. Returns matching excerpts with the chat title and date. ' +
  'Use it to locate a discussion the curated memory does not cover.';

export const RUN_IN_SANDBOX_DESC =
  'Runs arbitrary code or shell commands in an isolated environment and evaluates them. ' +
  'Use it for calculations, data transformations, scripting, file analysis, or to build on the fly ' +
  'functionality not covered by other tools. ' +
  'If a dedicated skill/tool exists for the task or file type (e.g. a format-specific analyzer), ' +
  'ALWAYS try it first with the arguments its description asks for — the sandbox is the fallback, ' +
  'not the first choice. ' +
  'The working directory IS the persistent workspace of this chat: files written remain available in subsequent turns, ' +
  'so you can save a function/script and reuse it. ALWAYS use relative paths (`./file`, `skills/<name>/…`); ' +
  'NEVER absolute paths like `/workspace` (the absolute location varies with the execution mode). ' +
  'The working directory and shell state do NOT carry over between calls: every call starts fresh at the workspace ROOT, ' +
  'so a `cd` (or any shell variable) from a previous call is gone. Always reference files by their path relative to the ' +
  'workspace root — not relative to a `cd` you did in an earlier call — and write a file and read it back using the SAME ' +
  'root-relative path. ' +
  'If the network is enabled, you can INSTALL dependencies at runtime in the workspace (they persist for subsequent turns): ' +
  'Python → `pip install --user <pkg>` then `import`; Node → `npm install <pkg>` (in the workspace) then `require`. ' +
  'Without network enabled, only the standard library and already-present packages are available. ' +
  'WHAT PERSISTS vs WHAT DOES NOT: only the workspace persists (files you write, `pip install --user`, `npm install`). ' +
  'Each call runs in a FRESH ephemeral container, so SYSTEM packages installed with `apt-get` live only inside that ' +
  'container\'s root filesystem and are GONE on the next call. Therefore, when you need a system library, install it AND ' +
  'use it in a SINGLE call (one complete script) — never split "install" and "use" across separate calls. ' +
  'Prefer pure Python/JS libraries that need no system packages: e.g. for PDF use `reportlab` or `fpdf2` (pip), ' +
  'NOT `weasyprint` (which needs system libraries). ' +
  'On a RETRY after a failure, do not start from scratch: `ls` the workspace first and reuse what is already there ' +
  '(installed deps, partial results). ' +
  'The workspace starts empty except `skills/` (descriptive skills). Files produced by SKILLS in previous turns ' +
  'are in the shared dir in env `SKILLS_OUTPUT_DIR` (copy what you need, e.g. `cp "$SKILLS_OUTPUT_DIR/report.csv" .`). ' +
  'Files UPLOADED in chat are staged into `inputs/` in the workspace: look there first (`ls inputs/`). ' +
  'If a file is not there, tell the user instead of hunting for it on the filesystem. ' +
  'DELIVERING FILES TO THE USER — read this before writing any file: a file written ONLY in the workspace is ' +
  'PRIVATE to the session, so the user gets NO download link and cannot see it in the files panel. For EVERY file ' +
  'you create, decide whether the USER wants it. Any user-facing artifact (a report, an export, a generated ' +
  'document/image, or any file the user asked for) MUST be written to the dir in env `SKILLS_OUTPUT_DIR` (not only ' +
  'in the workspace), and you MUST then give the user a CLICKABLE Markdown link in your reply: ' +
  '`[<filename>](/api/files/raw?rel=<filename>)` (Markdown link syntax, not a bare URL). Keep in the workspace only ' +
  'genuinely intermediate/private files. If you realize you produced a file the user may want but left it in the ' +
  'workspace, re-write it to `SKILLS_OUTPUT_DIR` (or at least tell the user) — never leave it silently unreachable. ' +
  'Deliver only NEW artifacts you produced: never copy the user\'s own input file back to `SKILLS_OUTPUT_DIR` as a ' +
  'deliverable (they already have it), and give every file an extension that matches its CONTENT ' +
  '(extracted data → `.json`/`.csv`, a report → `.md`/`.pdf` — not the source file\'s extension). ' +
  'The script\'s stdout is the result you receive: print what you need to see. ' +
  'For recurring tasks, consider saving them as a reusable skill instead of regenerating the code every time.';

/**
 * Default description of the org-wide 'rag' search tool auto-created when an
 * admin creates a vector collection (VectorDbController). It is SEEDED into
 * `custom_tools.description` and stays admin-editable there afterwards: this
 * is only the template for newly created tools.
 */
export function ragSearchToolDescription(
  collection: string,
  collectionDescription?: string | null,
): string {
  return (
    `Semantic search in the "${collection}" knowledge base (vector collection). ` +
    `Use it when the user asks about topics or documents that may have been indexed there ` +
    `(uploaded files, embedded notes). Do not use it for questions unrelated to stored documents.` +
    (collectionDescription ? ` Collection content: ${collectionDescription}` : '')
  );
}

/**
 * Injected when the tool-selection strategy (top-K) filtered tools out: a
 * compact catalog of the NOT-loaded tools plus the rule that the model must
 * never deny a capability that exists but was not selected for this message.
 */
export function toolsNotLoadedBlock(lines: string[]): string {
  return [
    '<tools_not_loaded>',
    ...lines,
    '</tools_not_loaded>',
    'The tools listed above exist but are NOT loaded for this message: the platform ' +
    'selects, per message, the tools most relevant to the user\'s text. NEVER claim a ' +
    'capability from this list is unavailable. If the current task needs one of these ' +
    'tools, tell the user the capability exists and ask them to resend the request ' +
    'naming that operation explicitly — the tool will then be loaded automatically.',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Background prompts (run on the summarizer model, off the interactive path)
// ─────────────────────────────────────────────────────────────────────────────

/** History compaction: rolling summary update. */
export function summarizerPrompt(previousSummary: string | null, transcript: string): string {
  return (
    'You are a conversational context compressor. Update the summary of the ' +
    'conversation by incorporating the new messages. Keep ALL durable information: ' +
    'decisions made, facts, data and numbers cited, user preferences, constraints, pending ' +
    'tasks, identifiers (ids, file names, paths). Omit pleasantries. Write in the same ' +
    'language as the conversation, concise but complete, with no preamble.\n\n' +
    (previousSummary?.trim() ? `CURRENT SUMMARY:\n${previousSummary.trim()}\n\n` : '') +
    `NEW MESSAGES TO INCORPORATE:\n${transcript}\n\n` +
    'UPDATED SUMMARY:'
  );
}

/** Metadata contract shared by the memory extraction/annotation prompts. */
export const METADATA_SPEC =
  'For each fact also produce: "tags" (1-3 lowercase classification labels), ' +
  '"keywords" (2-5 salient search terms, include proper names verbatim), ' +
  '"context" (ONE sentence: when is this note useful to recall), ' +
  '"category" (one of: "preference" | "profile" | "constraint" | "knowledge").';

/** Long-term memory extraction from a batch of turns. */
export function memoryExtractionPrompt(transcript: string, existing: string[]): string {
  const existingBlock = existing.length
    ? `FACTS ALREADY IN MEMORY (do not propose them again):\n${existing.map((e) => `- ${e}`).join('\n')}\n\n`
    : '';
  return (
    'You are a long-term memory extractor about a user. Analyze the conversation ' +
    'and extract ONLY DURABLE and REUSABLE facts about the user, useful in future conversations: ' +
    'stable preferences (language, style, technical level), role/profession, recurring constraints, ' +
    'tools/technologies they use, long-term decisions. ' +
    'DO NOT extract: ephemeral details tied to a single request, generated content, ' +
    'temporary information, pleasantries. Each fact must be a short, self-contained sentence in English. ' +
    METADATA_SPEC + ' ' +
    'If nothing new and durable emerges, return an empty array.\n\n' +
    existingBlock +
    `CONVERSATION:\n${transcript}\n\n` +
    'Respond EXCLUSIVELY with a JSON array of objects, without any additional text. Example: ' +
    '[{"content":"Develops in TypeScript with NestJS","tags":["stack"],"keywords":["TypeScript","NestJS"],' +
    '"context":"Useful when suggesting code or libraries.","category":"profile"}]. ' +
    'Empty array if there is nothing: []'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-agent orchestration (teams). Each agent's own `systemPrompt` is DB-editable;
// these are the hard-coded orchestration texts + the fallbacks when it is empty.
// ─────────────────────────────────────────────────────────────────────────────

export const SUPERVISOR_DEFAULT = 'You are the supervisor of a team of agents.';
export const SUPERVISOR_DEFAULT_PARALLEL = 'You are the supervisor of a team.';

/** Parallel topology: system prompt to aggregate the members' outputs. */
export function parallelAggregationSystem(supPrompt: string): string {
  return `${supPrompt}\nAggregate the members' contributions into a single final answer for the user.`;
}
export function parallelAggregationUser(input: string, transcript: string): string {
  return `Objective: ${input}\n\nTeam contributions:\n${transcript}\n\nFinal answer:`;
}

/** Supervisor topology: routing decision (who acts next / FINISH). */
export function supervisorRoutingSystem(supPrompt: string, roster: string): string {
  return (
    `${supPrompt}\n\nTeam members:\n${roster}\n\n` +
    `Choose WHO must act now (exact member name) to make progress toward the objective, ` +
    `or reply FINISH if the task is complete. Reply ONLY with the member name or with FINISH.`
  );
}
export function supervisorRoutingUser(input: string, transcript: string): string {
  return `Objective: ${input}\n\nProgress so far:\n${transcript || '(none)'}\n\nNext (name or FINISH):`;
}

/** Supervisor topology: final synthesis. */
export function supervisorSynthesisSystem(supPrompt: string): string {
  return `${supPrompt}\n\nSynthesize the final answer for the user based on the team's work.`;
}
export function supervisorSynthesisUser(input: string, transcript: string): string {
  return `Objective: ${input}\n\nTeam's work:\n${transcript || '(none)'}\n\nFinal answer:`;
}
