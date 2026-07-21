/**
 * @file skill-tool.factory.ts
 *
 * Builds a LangChain DynamicStructuredTool from a SkillScript.
 *
 * Each script becomes a tool with name:
 *   skill_{skill_name}_{script_filename_sanitized}
 *   e.g.: "data-analyzer" + "scripts/analyze.py" → "skill_data_analyzer_analyze_py"
 *
 * The tool, when invoked by the LLM, calls skill-executor via HTTP
 * and returns stdout as a string (or a descriptive error message).
 *
 * The schema's `input` parameter is built from the JSON Schema declared
 * in SKILL.md — each property becomes a typed Zod field.
 */
import {Logger} from '@nestjs/common';
import {DynamicStructuredTool} from '@langchain/core/tools';
import {z} from 'zod';
import {Skill} from './skill.entity';
import {SkillScript} from './skill-script.entity';
import {SkillExecutorClient} from './skill-executor.client';
import {skillNetworkParams} from './skill-networks';
import {mintRunToken} from '../common/internal-token/internal-token';

const logger = new Logger('SkillToolFactory');

// ─── Tool name ────────────────────────────────────────────────────────────────

/**
 * Generates the LangGraph tool name from the skill name + script filename.
 * Result: snake_case, starts with "skill_", max ~120 chars.
 *
 * Examples:
 *   "data-analyzer" + "scripts/analyze.py"  → "skill_data_analyzer_analyze_py"
 *   "email-formatter" + "scripts/format.js" → "skill_email_formatter_format_js"
 */
export function buildToolName(skillName: string, filename: string): string {
  const base = filename
    .replace(/^scripts\//, '')  // remove "scripts/" prefix
    .replace(/[^a-zA-Z0-9]/g, '_')  // anything non-alphanumeric → _
    .replace(/_+/g, '_')             // collapse sequences of _ into a single one
    .replace(/^_|_$/g, '')           // remove leading/trailing _
    .toLowerCase();

  const skill = skillName.replace(/-/g, '_').toLowerCase();

  return `skill_${skill}_${base}`;
}

// ─── String coercion → declared type ───────────────────────────────────────────
// In Flows the node inputs are ALWAYS strings (`inputs: Record<string,string>`):
// a hand-typed constant or an interpolated binding arrives as a string even
// when the skill's schema requires boolean/number/array/object. These
// preprocessors convert the string into the expected type BEFORE zod validation,
// so the `skill` node does not break (and it also covers the agent passing
// stringified JSON). Values already of the right type — e.g. a single binding
// that preserves the type, or a real boolean — pass through unchanged.

function coerceBoolean(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  if (['false', '0', 'no', 'off', ''].includes(s)) return false;
  return v; // unrecognized → let zod raise an explicit error
}

function coerceNumber(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s === '') return v;
  const n = Number(s);
  return Number.isNaN(n) ? v : n;
}

/** For array/object: if it is a JSON string it parses it, otherwise leaves it as is. */
function coerceJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!s) return v;
  try { return JSON.parse(s); } catch { return v; }
}

// ─── JSON Schema → Zod ───────────────────────────────────────────────────────

/**
 * Converts a simple JSON Schema into a Zod schema.
 *
 * Supported types: string, number, integer, boolean, array, object.
 * Unsupported (fallback to z.string()): $ref, oneOf, anyOf, allOf.
 *
 * Non-string types are wrapped in `z.preprocess` to coerce inputs that
 * arrive as strings (see above): essential for Flows, whose inputs are
 * always strings.
 *
 * Fields not present in the JSON Schema's `required` array become `.optional()`.
 */
export function jsonSchemaToZod(schema: Record<string, unknown>, required = true): z.ZodTypeAny {
  const type = schema.type as string | undefined;
  const desc = schema.description as string | undefined;

  let zodType: z.ZodTypeAny;

  switch (type) {
    case 'string': {
      let s = z.string();
      if (desc) s = s.describe(desc);
      zodType = s;
      break;
    }
    case 'number':
    case 'integer': {
      let n = type === 'integer' ? z.number().int() : z.number();
      if (desc) n = n.describe(desc);
      zodType = z.preprocess(coerceNumber, n);
      break;
    }
    case 'boolean': {
      const b = desc ? z.boolean().describe(desc) : z.boolean();
      zodType = z.preprocess(coerceBoolean, b);
      break;
    }
    case 'array': {
      const items = (schema.items as Record<string, unknown>) ?? {};
      let a: z.ZodTypeAny = z.array(jsonSchemaToZod(items));
      if (desc) a = a.describe(desc);
      zodType = z.preprocess(coerceJson, a);
      break;
    }
    case 'object': {
      const props     = (schema.properties as Record<string, unknown>) ?? {};
      const reqFields = (schema.required as string[]) ?? [];
      const shape: Record<string, z.ZodTypeAny> = {};

      for (const [key, val] of Object.entries(props)) {
        const isRequired = reqFields.includes(key);
        shape[key] = jsonSchemaToZod(val as Record<string, unknown>, isRequired);
      }

      let o: z.ZodTypeAny = z.object(shape).passthrough();
      if (desc) o = o.describe(desc);
      zodType = z.preprocess(coerceJson, o);
      break;
    }
    default:
      // Fallback: generic string
      zodType = desc ? z.string().describe(desc) : z.string();
  }

  // If the field is not required in the parent, it becomes optional (with default if present)
  if (!required) {
    const defaultVal = schema.default;
    if (defaultVal !== undefined) {
      return (zodType as any).default(defaultVal).optional();
    }
    return zodType.optional();
  }

  return zodType;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Builds the LangChain DynamicStructuredTool for a skill's script.
 *
 * The tool, when invoked by the LLM:
 *   1. Calls skill-executor POST /execute with the parameters
 *   2. If exit_code === 0, returns stdout as the response
 *   3. If exit_code !== 0, returns a descriptive error message with stderr
 *
 * If skill-executor is unreachable, returns a non-blocking error
 * (the agent can choose another strategy).
 */
export function buildSkillTool(
  skill:          Skill,
  script:         SkillScript,
  executorClient: SkillExecutorClient,
  config:         Record<string, string> = {},
  infoOutput:     string | null = null,
  userId:         string = '',
  resolveFileRef?: (value: string, userId: string) => Promise<{ hostPath: string; name: string } | null>,
): DynamicStructuredTool {
  const toolName   = buildToolName(skill.name, script.filename);
  const inputSchema = script.inputSchema as Record<string, unknown>;

  // Params declared as file-ref (C2 copy-in): they will be resolved+authorized and
  // staged into the job's work dir (the arg is rewritten to the path in the container).
  const fileRefParams = Object.entries((inputSchema?.properties as Record<string, any>) ?? {})
    .filter(([, p]) => p?.format === 'file-ref')
    .map(([name]) => name);

  // We build the Zod schema from the DB's JSON inputSchema. The root MUST be a
  // pure ZodObject (DynamicStructuredTool requires it): we build the shape field
  // by field, so that coercion via preprocess stays on the individual fields (and on
  // nested objects) without wrapping the root container in a ZodEffects.
  let zodSchema: z.ZodObject<any>;
  try {
    if (inputSchema?.type === 'object' && inputSchema.properties) {
      const props     = inputSchema.properties as Record<string, unknown>;
      const reqFields = (inputSchema.required as string[]) ?? [];
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, val] of Object.entries(props)) {
        shape[key] = jsonSchemaToZod(val as Record<string, unknown>, reqFields.includes(key));
      }
      zodSchema = z.object(shape).passthrough();
    } else {
      zodSchema = z.object({ input: z.string().describe('Script input') });
    }
  } catch {
    // Safe fallback if the schema is malformed
    zodSchema = z.object({ input: z.string().describe('Script input') });
  }

  const context = script.contextNote || infoOutput || null;
  const description = context
    ? `${script.description}\n\nCurrent context:\n${context}`
    : script.description;

  return new DynamicStructuredTool<any>({
    name:        toolName,
    description,
    schema:      zodSchema,

    func: async (args: Record<string, unknown>): Promise<string> => {
      const argsPreview = JSON.stringify(args);
      logger.log(`skill tool "${toolName}": args=${argsPreview}`);

      try {
        // Copy-in (C2): resolves+authorizes the file-ref params → files[] for staging.
        const files: { param: string; hostPath: string; name: string }[] = [];
        if (resolveFileRef && fileRefParams.length) {
          for (const param of fileRefParams) {
            const val = args[param];
            if (typeof val === 'string' && val.trim()) {
              const r = await resolveFileRef(val, userId);
              if (r) files.push({ param, hostPath: r.hostPath, name: r.name });
            }
          }
        }

        const result = await executorClient.execute({
          skill_id:  skill.id,
          filename:  script.filename,
          language:  script.language,
          input:     args,
          config,
          user_id:   userId,
          // Signed run token: the non-forgeable identity for the internal APIs.
          // Wide TTL (5 min) to cover long scripts within the executor timeout.
          run_token: mintRunToken(userId, 300_000),
          ...skillNetworkParams(skill),
          ...(files.length ? { files } : {}),
        });

        if (result.exit_code === 0) {
          const out = result.stdout.trim() || '(no output)';
          const preview = out.length > 200 ? out.slice(0, 200) + '…' : out;
          logger.log(`skill tool "${toolName}" OK (${result.duration_ms}ms): ${preview}`);
          // Deliverables produced by the skill → tracked as downloadable files and
          // surfaced in the chat/project file panel. The backend builds the canonical
          // `?rel=` links (owner-confined), independent of what the skill printed.
          if (result.outputs?.length) {
            const links = result.outputs
              .map((f) => `- ${f}: /api/files/raw?rel=${encodeURIComponent(f)}`)
              .join('\n');
            return `${out}\n\nGenerated files (give the user these Markdown links):\n${links}`;
          }
          return out;
        }

        // Script ended with error: log + message readable by the AI
        const stderrSnippet = result.stderr.trim().slice(0, 500);
        logger.warn(
          `skill tool "${toolName}" ERROR exit=${result.exit_code} (${result.duration_ms}ms)` +
          (stderrSnippet ? `\n  stderr: ${stderrSnippet}` : ''),
        );

        const errMsg = [
          `Script "${script.filename}" ended with an error (exit code ${result.exit_code}).`,
          result.stderr.trim() ? `Stderr:\n${result.stderr.slice(0, 1000)}` : '',
          result.stdout.trim() ? `Stdout:\n${result.stdout.slice(0, 500)}` : '',
        ].filter(Boolean).join('\n');

        return errMsg;

      } catch (err: any) {
        logger.error(`skill tool "${toolName}" EXCEPTION: ${err.message}`);
        return `Unable to run script "${script.filename}": ${err.message}`;
      }
    },
  });
}
