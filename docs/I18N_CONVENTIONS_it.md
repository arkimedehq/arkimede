# i18n — Convenzioni e trappole (guida operativa)

Guida per estrarre le stringhe UI in modo sicuro. Pensata anche per essere seguita
da un modello/agent meno potente: il lavoro è ripetitivo ma ha **fallimenti
silenziosi** che `tsc` non cattura. Segui il template e i gate alla lettera.

## Stato e architettura

- Libreria: **react-i18next** (init in `frontend/src/i18n/index.ts`).
- Lingue: `en`, `it`. **Fallback: `en`**. Auto-detect: localStorage → navigator.
- Preferenza persistita su `User.language` (DB); applicata da `useUserLanguage`
  (montato in `DashboardPage`); selettore = `LanguageSwitcher` (Impostazioni → Profilo).
- Lingua di risposta dell'assistente: iniettata nel system prompt lato backend
  (`AgentService.buildSystemPrompt`) — non riguarda l'estrazione UI.
- File traduzioni: `frontend/src/i18n/locales/{en,it}/<namespace>.json`.
- **Un namespace per feature**: `common`, `settings`, `tools`, e poi `agents`,
  `flows`, `skills`, `mcp`, `chat`, … `common` = stringhe condivise (azioni, scope,
  nav, tema, header).

## Come si converte una pagina (template)

1. Crea/estendi `locales/en/<ns>.json` **e** `locales/it/<ns>.json` (stesse chiavi).
2. Se è un namespace nuovo, **registralo** in `i18n/index.ts` (import + `resources`).
   Dimenticarlo = la chiave appare grezza a schermo (nessun errore di build!).
3. Nel componente: `import { useTranslation } from 'react-i18next'` e
   `const { t } = useTranslation('<ns>')`. **Ogni** componente che usa `t` deve
   chiamare il proprio hook (anche i sotto-componenti nello stesso file).
4. Sostituisci i literal: testo JSX `Salva` → `{t('actions.save')}`; attributo
   `title="Salva"` → `title={t('actions.save')}`.
5. Gate (vedi sotto) → commit della slice.

### Chiavi: naming

- Struttura semantica per area: `form.identity.nameLabel`, `card.delete`, `stats.total`.
- L'`id` di un elemento può fungere da chiave: array con `{ id: 'profile' }` →
  `t(`nav.${id}`)` (vedi `SettingsPage` SECTIONS, `Sidebar` THEME_OPTIONS). In questi
  casi **rimuovi il campo `label`** dall'array, non lasciarlo morto.
- Riuso cross-namespace: `t('common:scope.visibility')` (funziona anche se l'hook è
  `useTranslation('tools')`, perché `common` è sempre caricato).

## ⚠️ Le 5 trappole (compilano ma si rompono a runtime)

### 1. `{{ }}` è interpolazione di i18next
Mai mettere un literal `{{...}}` dentro un **valore JSON**: i18next lo legge come
variabile e renderizza **vuoto**.

```jsonc
// ❌ ROTTO: "{{secret.KEY}}" diventa una variabile vuota
"headersHint": "usa {{secret.KEY}} per le API key"
```

Per gli hint con snippet di codice usa lo **split pre / `<code>` / post** nel JSX,
tenendo lo snippet come literal JSX:

```tsx
// ✅ giusto
<span>
  {t('http.headersHintPre')} <code>{'{{secret.KEY}}'}</code> {t('http.headersHintPost')}
</span>
```
```json
"headersHintPre": "use", "headersHintPost": "for API keys"
```

Le `{{ }}` vere (variabili) sono solo per i **valori dinamici**:
`t('stats.total', { count: n })` con `"total": "{{count}} total tools"`.

### 2. Plurali → `_one` / `_other` (+ `count`)
```json
"secret_one": "{{count}} secret", "secret_other": "{{count}} secrets"
```
```tsx
{t('card.secret', { count: n })}   // sceglie singolare/plurale da solo
```
Non fare `n === 1 ? 'segreto' : 'segreti'` a mano.

### 3. Namespace non registrato
Nuovo file `<ns>.json` → aggiungilo SEMPRE a `i18n/index.ts` (import + dentro
`resources.en` e `resources.it`). Senza, `t('x')` mostra `"x"` grezzo a schermo.

### 4. Cosa NON tradurre
Identificatori e codice, non testo: nomi di header (`Authorization`), id executor
(`http`/`sql`/`rag`/`prompt`), badge tecnici, snippet/esempi di codice, chiavi di
oggetti, valori usati come logica (non solo display). Tradurre questi rompe
comportamento o esempi.

### 5. EN ≠ traduzione letterale parola-per-parola
L'inglese deve suonare naturale e tecnico corretto (es. *hierarchical delegation*,
non *hierarchical delegation of the agent*). In dubbio, preferisci conciso.

## Gate per ogni slice (obbligatorio)

`tsc` qui è una rete a **maglie larghe**: prende JSX/tipi, NON traduzioni/chiavi vuote.

1. `cd frontend && npx tsc --noEmit` → zero errori.
2. **Controllo visivo nelle due lingue** della pagina toccata: nessuna chiave grezza
   (`form.identity.x`), nessun testo vuoto, plurali ok. Cambia lingua da
   Impostazioni → Profilo.
3. `it.json` e `en.json` hanno **le stesse chiavi** (nessuna orfana/mancante).

## Cadenza & commit

- **Una slice = un namespace/feature (o sotto-sezione di un form grande) = un commit.**
  Form densi (es. ToolModal http/sql/rag/prompt) → una slice per sezione.
- Messaggio: `feat(i18n): <feature> — <cosa>`; chiudi con la riga `Co-Authored-By`.

## Ordine del lavoro rimanente

`tools` (resta SQL, RAG, Prompt, Parametri, Segreti del ToolModal) → `agents` →
`flows` → `skills` → `mcp` → `chat` → sezioni interne di `SettingsPage` →
errori backend (Fase 3, `nestjs-i18n` — task separato).

## Fase 3 — Errori backend (nestjs-i18n)

Infra pronta: `nestjs-i18n` configurato in `backend/src/app.module.ts` (`I18nModule.forRoot`,
fallback `en`, lingua dall'header `Accept-Language` che il frontend invia in
`api/client.ts`). File traduzioni in `backend/src/i18n/<lang>/errors.json`. Un filtro
globale `I18nExceptionFilter` (`backend/src/common/`) traduce i messaggi che sono **chiavi**.

**Pattern per convertire una exception (caso normale, statico):**
1. Aggiungi la chiave a `backend/src/i18n/en/errors.json` **e** `it/errors.json` (stesse chiavi).
2. Sostituisci il messaggio con la chiave, prefisso `errors.`:
   ```ts
   // prima
   throw new ConflictException('Email già registrata');
   // dopo
   throw new ConflictException('errors.emailTaken');
   ```
   Il filtro la traduce nella lingua della richiesta. Messaggi non-chiave passano invariati.

**Caso con interpolazione** (valori dinamici nel messaggio): traduci a throw-time con
`I18nContext`, così il messaggio arriva già tradotto (il filtro lo lascia passare):
```ts
import { I18nContext } from 'nestjs-i18n';
throw new NotFoundException(I18nContext.current()!.t('errors.toolNotFound', { args: { name } }));
```
con `"toolNotFound": "Tool {name} not found"` / `"Tool {name} non trovato"`.

**NON tradurre**: log (`this.logger`/`console`), messaggi interni non esposti all'utente,
stringhe di audit. Solo i messaggi delle `HttpException` che l'utente vede.

**Gate**: `cd backend && npx tsc --noEmit` + parità chiavi `en/it` in `errors.json`.
Convertito come esempio: `auth.service.ts` (`errors.emailTaken/invalidCredentials/accountDisabled`).
Restano ~30 file con `throw new ...Exception('<testo IT>')` — trovali con:
`grep -rEn "throw new \w+Exception\('[A-ZÀ-Ù]" backend/src --include="*.ts" | grep -v dist`

### Difficoltà per delega

- **Adatto a modello più basso**: shell delle pagine (header, bottoni, empty-state,
  stats), label/placeholder semplici, namespace nuovi seguendo questo template.
- **Tieni su modello capace**: blocchi di aiuto con markup/`{{ }}` (rischio trappola
  #1), scelte su cosa-non-tradurre, qualità EN di stringhe di dominio.
