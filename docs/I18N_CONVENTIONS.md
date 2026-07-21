# i18n — Conventions and pitfalls (operational guide)

Guide for extracting UI strings safely. Also designed to be followed by a less
powerful model/agent: the work is repetitive but has **silent failures** that
`tsc` does not catch. Follow the template and the gates to the letter.

## State and architecture

- Library: **react-i18next** (init in `frontend/src/i18n/index.ts`).
- Languages: `en`, `it`. **Fallback: `en`**. Auto-detect: localStorage → navigator.
- Preference persisted on `User.language` (DB); applied by `useUserLanguage`
  (mounted in `DashboardPage`); selector = `LanguageSwitcher` (Settings → Profile).
- Assistant response language: injected into the system prompt on the backend
  (`AgentService.buildSystemPrompt`) — unrelated to UI extraction.
- Translation files: `frontend/src/i18n/locales/{en,it}/<namespace>.json`.
- **One namespace per feature**: `common`, `settings`, `tools`, then `agents`,
  `flows`, `skills`, `mcp`, `chat`, … `common` = shared strings (actions, scope,
  nav, theme, header).

## How to convert a page (template)

1. Create/extend `locales/en/<ns>.json` **and** `locales/it/<ns>.json` (same keys).
2. If it is a new namespace, **register it** in `i18n/index.ts` (import + `resources`).
   Forgetting it = the key shows up raw on screen (no build error!).
3. In the component: `import { useTranslation } from 'react-i18next'` and
   `const { t } = useTranslation('<ns>')`. **Every** component that uses `t` must
   call its own hook (including sub-components in the same file).
4. Replace the literals: JSX text `Salva` → `{t('actions.save')}`; attribute
   `title="Salva"` → `title={t('actions.save')}`.
5. Gate (see below) → commit the slice.

### Keys: naming

- Semantic structure by area: `form.identity.nameLabel`, `card.delete`, `stats.total`.
- The `id` of an element can serve as the key: array with `{ id: 'profile' }` →
  `t(`nav.${id}`)` (see `SettingsPage` SECTIONS, `Sidebar` THEME_OPTIONS). In these
  cases **remove the `label` field** from the array, do not leave it dead.
- Cross-namespace reuse: `t('common:scope.visibility')` (works even if the hook is
  `useTranslation('tools')`, because `common` is always loaded).

## ⚠️ The 5 pitfalls (they compile but break at runtime)

### 1. `{{ }}` is i18next interpolation
Never put a literal `{{...}}` inside a **JSON value**: i18next reads it as a
variable and renders **empty**.

```jsonc
// ❌ BROKEN: "{{secret.KEY}}" becomes an empty variable
"headersHint": "usa {{secret.KEY}} per le API key"
```

For hints with code snippets use the **split pre / `<code>` / post** in the JSX,
keeping the snippet as a JSX literal:

```tsx
// ✅ correct
<span>
  {t('http.headersHintPre')} <code>{'{{secret.KEY}}'}</code> {t('http.headersHintPost')}
</span>
```
```json
"headersHintPre": "use", "headersHintPost": "for API keys"
```

The real `{{ }}` (variables) are only for **dynamic values**:
`t('stats.total', { count: n })` with `"total": "{{count}} total tools"`.

### 2. Plurals → `_one` / `_other` (+ `count`)
```json
"secret_one": "{{count}} secret", "secret_other": "{{count}} secrets"
```
```tsx
{t('card.secret', { count: n })}   // picks singular/plural on its own
```
Do not do `n === 1 ? 'segreto' : 'segreti'` by hand.

### 3. Unregistered namespace
New `<ns>.json` file → ALWAYS add it to `i18n/index.ts` (import + inside
`resources.en` and `resources.it`). Without it, `t('x')` shows raw `"x"` on screen.

### 4. What NOT to translate
Identifiers and code, not text: header names (`Authorization`), executor ids
(`http`/`sql`/`rag`/`prompt`), technical badges, code snippets/examples, object
keys, values used as logic (not just display). Translating these breaks
behavior or examples.

### 5. EN ≠ literal word-for-word translation
The English must sound natural and technically correct (e.g. *hierarchical delegation*,
not *hierarchical delegation of the agent*). When in doubt, prefer concise.

## Gate for every slice (mandatory)

`tsc` here is a **coarse-mesh** net: it catches JSX/types, NOT translations/empty keys.

1. `cd frontend && npx tsc --noEmit` → zero errors.
2. **Visual check in both languages** of the touched page: no raw keys
   (`form.identity.x`), no empty text, plurals ok. Switch language from
   Settings → Profile.
3. `it.json` and `en.json` have **the same keys** (none orphaned/missing).

## Cadence & commit

- **One slice = one namespace/feature (or sub-section of a large form) = one commit.**
  Dense forms (e.g. ToolModal http/sql/rag/prompt) → one slice per section.
- Message: `feat(i18n): <feature> — <what>`; close with the `Co-Authored-By` line.

## Order of the remaining work

`tools` (remaining: SQL, RAG, Prompt, Parameters, Secrets of the ToolModal) → `agents` →
`flows` → `skills` → `mcp` → `chat` → internal sections of `SettingsPage` →
backend errors (Phase 3, `nestjs-i18n` — separate task).

## Phase 3 — Backend errors (nestjs-i18n)

Infra ready: `nestjs-i18n` configured in `backend/src/app.module.ts` (`I18nModule.forRoot`,
fallback `en`, language from the `Accept-Language` header that the frontend sends in
`api/client.ts`). Translation files in `backend/src/i18n/<lang>/errors.json`. A global
`I18nExceptionFilter` filter (`backend/src/common/`) translates the messages that are **keys**.

**Pattern to convert an exception (normal, static case):**
1. Add the key to `backend/src/i18n/en/errors.json` **and** `it/errors.json` (same keys).
2. Replace the message with the key, prefix `errors.`:
   ```ts
   // before
   throw new ConflictException('Email già registrata');
   // after
   throw new ConflictException('errors.emailTaken');
   ```
   The filter translates it into the request language. Non-key messages pass through unchanged.

**Case with interpolation** (dynamic values in the message): translate at throw-time with
`I18nContext`, so the message arrives already translated (the filter lets it pass):
```ts
import { I18nContext } from 'nestjs-i18n';
throw new NotFoundException(I18nContext.current()!.t('errors.toolNotFound', { args: { name } }));
```
with `"toolNotFound": "Tool {name} not found"` / `"Tool {name} non trovato"`.

**Do NOT translate**: logs (`this.logger`/`console`), internal messages not exposed to the user,
audit strings. Only the `HttpException` messages that the user sees.

**Gate**: `cd backend && npx tsc --noEmit` + `en/it` key parity in `errors.json`.
Converted as an example: `auth.service.ts` (`errors.emailTaken/invalidCredentials/accountDisabled`).
About ~30 files with `throw new ...Exception('<IT text>')` remain — find them with:
`grep -rEn "throw new \w+Exception\('[A-ZÀ-Ù]" backend/src --include="*.ts" | grep -v dist`

### Difficulty for delegation

- **Suitable for a lower model**: page shells (header, buttons, empty-state,
  stats), simple labels/placeholders, new namespaces following this template.
- **Keep on a capable model**: help blocks with markup/`{{ }}` (pitfall #1 risk),
  choices about what-not-to-translate, EN quality of domain strings.
