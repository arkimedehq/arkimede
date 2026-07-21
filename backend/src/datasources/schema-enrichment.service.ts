/**
 * @file schema-enrichment.service.ts
 *
 * In-app port of the `comment-schema.mjs`, `generate-comments.mjs` and
 * `generate-relations.mjs` scripts, made automatic and cross-provider.
 *
 *   introspect() → manifest draft from the live schema (DB comments + declared FKs)
 *   enrich()     → the LLM (summarizer model) fills the empty comments and infers
 *                  the missing implicit relations
 *
 * Both are NON-destructive: comments/relations already present (DB or manual edit)
 * are never overwritten. No writes to the customer's external DB.
 */
import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage } from '@langchain/core/messages';

import { DataSourcesService, DataSourceDto } from './datasources.service';
import { LlmConfigsService } from '../llm-configs/llm-configs.service';
import { LlmConfigEntity } from '../llm-configs/llm-config.entity';
import { introspectSchema } from './sql-introspect';
import { engineFamily, SqlEngine } from './engine.types';
import { mongoDriver } from './mongo/mongo.driver';
import { redisDriver } from './redis/redis.driver';
import {
  SchemaManifest, SchemaManifestTable, SchemaManifestRelation, mergeManifest,
} from './schema-manifest.types';
import {
  DocumentManifest, DocumentCollection, isDocumentManifest, mergeDocumentManifest,
} from './document-manifest.types';
import {
  KeyspaceManifest, KeyPattern, isKeyspaceManifest, mergeKeyspaceManifest,
} from './keyspace-manifest.types';

/** Tables per LLM call in the comment batch. */
const COMMENT_BATCH_SIZE = 5;

/** Output budget for the comment batches (small input, contained output). */
const COMMENT_MAX_TOKENS = 4096;

/**
 * Output budget for relation inference: it is a SINGLE call over all the
 * tables → the JSON array can be very long (e.g. ~5k tokens for 68 tables).
 * With too small a budget the response is truncated and the JSON becomes invalid.
 */
const RELATIONS_MAX_TOKENS = 16384;

/** Candidate FK columns (heuristic to reduce the relations prompt payload). */
const FK_PATTERN = /(^|_)(id|cod|code|fk)/i;

@Injectable()
export class SchemaEnrichmentService {
  private readonly logger = new Logger(SchemaEnrichmentService.name);

  constructor(
    private readonly dataSources: DataSourcesService,
    private readonly llmConfigs: LlmConfigsService,
  ) {}

  /**
   * Introspects the live schema and produces/updates the base manifest (DB comments +
   * declared FKs). Non-destructive merge with any existing manifest.
   */
  async introspect(id: string): Promise<DataSourceDto> {
    const resolved = await this.dataSources.resolveDataSourceById(id);
    this.logger.log(`Introspection DataSource "${resolved.name}" (engine=${resolved.engine})...`);

    const family = engineFamily(resolved.engine);

    // Document family (MongoDB): sampling-based introspection.
    if (family === 'document') {
      const fresh = await mongoDriver.introspectSample(resolved.connectionString);
      const existing = isDocumentManifest(resolved.schemaManifest) ? resolved.schemaManifest : null;
      const merged = mergeDocumentManifest(fresh, existing);
      this.logger.log(`Introspection "${resolved.name}": ${merged.collections.length} collections`);
      return this.dataSources.saveSchemaManifest(id, merged);
    }

    // Key-value family (Redis): keyspace sampling.
    if (family === 'keyvalue') {
      const fresh = await redisDriver.introspectKeyspace(resolved.connectionString);
      const existing = isKeyspaceManifest(resolved.schemaManifest) ? resolved.schemaManifest : null;
      const merged = mergeKeyspaceManifest(fresh, existing);
      this.logger.log(`Introspection "${resolved.name}": ${merged.patterns.length} patterns`);
      return this.dataSources.saveSchemaManifest(id, merged);
    }

    const existing = (isDocumentManifest(resolved.schemaManifest) || isKeyspaceManifest(resolved.schemaManifest))
      ? null : (resolved.schemaManifest ?? null);
    const fresh = await introspectSchema(resolved.connectionString, resolved.engine as SqlEngine);
    const merged = mergeManifest(fresh, existing);

    this.logger.log(
      `Introspection "${resolved.name}": ${merged.tables.length} tables, ${merged.relations.length} relations`,
    );
    return this.dataSources.saveSchemaManifest(id, merged);
  }

  /**
   * Enriches the manifest with AI: missing comments (batched) + inferred relations.
   * If no manifest exists yet it introspects it first.
   *
   * @param llmConfigId  model to use (chosen by the user). If omitted it uses the
   *                     summarizer, otherwise the default. For large/complex schemas
   *                     it is better to pick a capable model, not a flash one.
   */
  async enrich(id: string, llmConfigId?: string): Promise<DataSourceDto> {
    const resolved = await this.dataSources.resolveDataSourceById(id);
    const entity = await this.dataSources.findEntityById(id);
    const domain = entity.description?.trim() || 'business management system';

    const family = engineFamily(resolved.engine);
    // Document family (MongoDB): enrichment of collection/field comments.
    if (family === 'document') return this.enrichDocument(id, resolved, domain, llmConfigId);
    // Key-value family (Redis): enrichment of pattern comments.
    if (family === 'keyvalue') return this.enrichKeyspace(id, resolved, domain, llmConfigId);

    // Always starts from a fresh manifest (so structure + DB comments are aligned).
    const existingSql = (isDocumentManifest(resolved.schemaManifest) || isKeyspaceManifest(resolved.schemaManifest))
      ? null : (resolved.schemaManifest ?? null);
    const fresh = await introspectSchema(resolved.connectionString, resolved.engine as SqlEngine);
    const manifest = mergeManifest(fresh, existingSql);

    const llmEntity = await this.resolveLlmEntity(llmConfigId);
    this.logger.log(`Enrich: model "${llmEntity.name}" (${llmEntity.provider}/${llmEntity.model})`);

    // Separate models: comments go in small batches; relations are a single
    // call that requires a much larger output budget.
    const comments = await this.fillComments(
      await this.buildModel(llmEntity, COMMENT_MAX_TOKENS), manifest, domain,
    );
    const relations = await this.inferRelations(
      await this.buildModel(llmEntity, RELATIONS_MAX_TOKENS), manifest, domain,
    );

    // Explicit error: if NOTHING was produced and all calls failed
    // (incompatible model, truncated output, API down…), do not save a false
    // success — surface the problem with the provider's message.
    const errors = [...comments.errors, ...(relations.error ? [relations.error] : [])];
    if (comments.filled === 0 && relations.added === 0 && errors.length > 0) {
      throw new BadGatewayException(
        `Enrichment failed: no result from model "${llmEntity.name}". ` +
        `Last error: ${errors[errors.length - 1]}`,
      );
    }

    manifest.generatedAt = new Date().toISOString();
    this.logger.log(
      `Enrich "${resolved.name}" completed: ${manifest.tables.length} tables, ${manifest.relations.length} relations`,
    );
    return this.dataSources.saveSchemaManifest(id, manifest);
  }

  // ── Document enrich (MongoDB) ────────────────────────────────────────────────

  /** Enriches a document manifest: collection and field comments via LLM. */
  private async enrichDocument(
    id: string,
    resolved: { connectionString: string; schemaManifest?: any },
    domain: string,
    llmConfigId?: string,
  ): Promise<DataSourceDto> {
    const fresh = await mongoDriver.introspectSample(resolved.connectionString);
    const existing = isDocumentManifest(resolved.schemaManifest) ? resolved.schemaManifest : null;
    const manifest = mergeDocumentManifest(fresh, existing);

    const llmEntity = await this.resolveLlmEntity(llmConfigId);
    this.logger.log(`Enrich Mongo: model "${llmEntity.name}" (${llmEntity.provider}/${llmEntity.model})`);
    const model = await this.buildModel(llmEntity, COMMENT_MAX_TOKENS);

    const { filled, errors } = await this.fillDocumentComments(model, manifest, domain);
    if (filled === 0 && errors.length > 0) {
      throw new BadGatewayException(
        `Enrichment failed: no result from model "${llmEntity.name}". Last error: ${errors[errors.length - 1]}`,
      );
    }

    manifest.generatedAt = new Date().toISOString();
    this.logger.log(`Enrich Mongo completed: ${manifest.collections.length} collections`);
    return this.dataSources.saveSchemaManifest(id, manifest);
  }

  private async fillDocumentComments(
    model: BaseChatModel,
    manifest: DocumentManifest,
    domain: string,
  ): Promise<{ filled: number; errors: string[] }> {
    const collMap = new Map(manifest.collections.map((c) => [c.name, c]));
    const todo = manifest.collections.filter(
      (c) => !c.deny && (!c.comment.trim() || c.fields.some((f) => !f.comment.trim())),
    );
    const errors: string[] = [];
    let filled = 0;
    if (!todo.length) return { filled, errors };

    for (let i = 0; i < todo.length; i += COMMENT_BATCH_SIZE) {
      const batch = todo.slice(i, i + COMMENT_BATCH_SIZE);
      try {
        const results = this.parseJsonArray(
          await this.invokeText(model, this.documentCommentPrompt(batch, domain)),
        );
        filled += this.applyDocumentComments(collMap, results);
      } catch (err: any) {
        this.logger.warn(`Mongo comment batch ${i / COMMENT_BATCH_SIZE + 1} failed: ${err.message}`);
        errors.push(err.message);
      }
    }
    return { filled, errors };
  }

  private documentCommentPrompt(collections: DocumentCollection[], domain: string): string {
    const input = JSON.stringify(
      collections.map((c) => ({
        collection: c.name,
        collectionComment: c.comment || null,
        fields: c.fields.map((f) => ({ path: f.path, types: f.types, existingComment: f.comment || null })),
      })),
      null, 2,
    );
    return `You are a MongoDB database expert. Database context: ${domain}.
Collection and field names may be abbreviated or in a language other than English.

For each collection and field, generate a comment that clearly describes what it contains, in the context of this database.

RULES:
- Concise comment, max 80 characters.
- Use the same language as the names (if they are in Italian, comment in Italian).
- If a field already has existingComment set → leave null for that field.
- If a collection already has collectionComment set → leave null for the collection.
- Respond ONLY with valid JSON, without markdown and without explanations.

Input:
${input}

Response format:
[
  {
    "collection": "collection_name",
    "collectionComment": "comment or null",
    "fields": [ { "path": "field", "comment": "comment or null" } ]
  }
]`;
  }

  private applyDocumentComments(collMap: Map<string, DocumentCollection>, results: any[]): number {
    let n = 0;
    for (const r of results) {
      const c = collMap.get(r?.collection);
      if (!c) continue;
      if (r.collectionComment && !c.comment.trim()) { c.comment = String(r.collectionComment); n++; }
      const fieldMap = new Map(c.fields.map((f) => [f.path, f]));
      for (const rf of r.fields ?? []) {
        const f = fieldMap.get(rf?.path);
        if (f && rf.comment && !f.comment.trim()) { f.comment = String(rf.comment); n++; }
      }
    }
    return n;
  }

  // ── Keyspace enrich (Redis) ─────────────────────────────────────────────────────

  /** Enriches a keyspace manifest: key-pattern comments via LLM. */
  private async enrichKeyspace(
    id: string,
    resolved: { connectionString: string; schemaManifest?: any },
    domain: string,
    llmConfigId?: string,
  ): Promise<DataSourceDto> {
    const fresh = await redisDriver.introspectKeyspace(resolved.connectionString);
    const existing = isKeyspaceManifest(resolved.schemaManifest) ? resolved.schemaManifest : null;
    const manifest = mergeKeyspaceManifest(fresh, existing);

    const todo = manifest.patterns.filter((p) => !p.deny && !p.comment.trim());
    if (todo.length) {
      const llmEntity = await this.resolveLlmEntity(llmConfigId);
      this.logger.log(`Enrich Redis: model "${llmEntity.name}" (${llmEntity.provider}/${llmEntity.model})`);
      const model = await this.buildModel(llmEntity, COMMENT_MAX_TOKENS);
      try {
        const results = this.parseJsonArray(await this.invokeText(model, this.keyspaceCommentPrompt(todo, domain)));
        const byPattern = new Map(manifest.patterns.map((p) => [p.pattern, p]));
        for (const r of results) {
          const p = byPattern.get(r?.pattern);
          if (p && r.comment && !p.comment.trim()) p.comment = String(r.comment);
        }
      } catch (err: any) {
        this.logger.warn(`Enrich Redis failed: ${err.message}`);
      }
    }

    manifest.generatedAt = new Date().toISOString();
    this.logger.log(`Enrich Redis completed: ${manifest.patterns.length} patterns`);
    return this.dataSources.saveSchemaManifest(id, manifest);
  }

  private keyspaceCommentPrompt(patterns: KeyPattern[], domain: string): string {
    const input = JSON.stringify(
      patterns.map((p) => ({ pattern: p.pattern, type: p.type, sampleKeys: p.sampleKeys ?? [] })), null, 2,
    );
    return `You are a Redis expert. Database context: ${domain}.
For each key pattern, generate a comment that describes what it contains, in the context of this database.

RULES:
- Concise comment, max 80 characters.
- Use the same language as the key names.
- Respond ONLY with valid JSON, without markdown.

Input:
${input}

Response format:
[ { "pattern": "user:*", "comment": "comment" } ]`;
  }

  // ── LLM model (cross-provider) ─────────────────────────────────────────────────

  /** Resolves the chosen LLM config (or summarizer/default if omitted). */
  private async resolveLlmEntity(llmConfigId?: string): Promise<LlmConfigEntity> {
    const entity = llmConfigId
      ? await this.llmConfigs.findOne(llmConfigId)
      : (await this.llmConfigs.getSummarizer()) ?? (await this.llmConfigs.getDefault());
    if (!entity) {
      throw new Error('No LLM config available for schema enrichment.');
    }
    return entity;
  }

  private async buildModel(entity: LlmConfigEntity, maxTokens: number): Promise<BaseChatModel> {
    // No temperature override: some reasoning models (e.g. claude-opus-4-x)
    // reject non-default values. The provider default is used.
    return this.llmConfigs.buildModelForConfig(entity, { maxTokens });
  }

  private async invokeText(model: BaseChatModel, prompt: string): Promise<string> {
    const res = await model.invoke([new HumanMessage(prompt)]);
    const content = res.content;
    if (typeof content === 'string') return content;
    const textBlock = (content as any[]).find((b: any) => b.type === 'text');
    return textBlock?.text ?? '';
  }

  private parseJsonArray(text: string): any[] {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error(`Non-JSON LLM response: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
  }

  // ── Comments (porting of generate-comments.mjs) ────────────────────────────────────

  private async fillComments(
    model: BaseChatModel,
    manifest: SchemaManifest,
    domain: string,
  ): Promise<{ filled: number; errors: string[] }> {
    const tableMap = new Map(manifest.tables.map((t) => [t.name, t]));
    const todo = manifest.tables.filter(
      (t) => !t.deny && (!t.comment.trim() || t.columns.some((c) => !c.comment.trim())),
    );
    const errors: string[] = [];
    let filled = 0;
    if (!todo.length) return { filled, errors };

    for (let i = 0; i < todo.length; i += COMMENT_BATCH_SIZE) {
      const batch = todo.slice(i, i + COMMENT_BATCH_SIZE);
      try {
        const results = this.parseJsonArray(
          await this.invokeText(model, this.commentPrompt(batch, domain)),
        );
        filled += this.applyComments(tableMap, results);
      } catch (err: any) {
        this.logger.warn(`Comment batch ${i / COMMENT_BATCH_SIZE + 1} failed: ${err.message}`);
        errors.push(err.message);
      }
    }
    return { filled, errors };
  }

  private commentPrompt(tables: SchemaManifestTable[], domain: string): string {
    const input = JSON.stringify(
      tables.map((t) => ({
        table: t.name,
        tableComment: t.comment || null,
        columns: t.columns.map((c) => ({
          name: c.name, type: c.type, existingComment: c.comment || null,
        })),
      })),
      null, 2,
    );

    return `You are a relational database expert. Database context: ${domain}.
Table and column names may be abbreviated or in a language other than English.

For each table and column provided, generate a comment that clearly describes what it contains, in the specific context of this database.

RULES:
- Concise comment, max 80 characters.
- Use the same language as the column names (if they are in Italian, comment in Italian).
- If a column already has existingComment set → leave null for that column.
- If a table already has tableComment set → leave null for the table.
- For ambiguous columns, use the context of the table and the domain.
- Respond ONLY with valid JSON, without markdown and without explanations.

Input:
${input}

Response format:
[
  {
    "table": "table_name",
    "tableComment": "comment or null",
    "columns": [ { "name": "COL_NAME", "comment": "comment or null" } ]
  }
]`;
  }

  /** Applies the generated comments (non-destructive) and returns how many it filled. */
  private applyComments(tableMap: Map<string, SchemaManifestTable>, results: any[]): number {
    let n = 0;
    for (const r of results) {
      const t = tableMap.get(r?.table);
      if (!t) continue;
      if (r.tableComment && !t.comment.trim()) { t.comment = String(r.tableComment); n++; }
      const colMap = new Map(t.columns.map((c) => [c.name, c]));
      for (const rc of r.columns ?? []) {
        const col = colMap.get(rc?.name);
        if (col && rc.comment && !col.comment.trim()) { col.comment = String(rc.comment); n++; }
      }
    }
    return n;
  }

  // ── Relations (porting of generate-relations.mjs) ──────────────────────────────────

  private async inferRelations(
    model: BaseChatModel,
    manifest: SchemaManifest,
    domain: string,
  ): Promise<{ added: number; error?: string }> {
    const visible = manifest.tables
      .filter((t) => !t.deny)
      .map((t) => ({
        table: t.name,
        columns: t.columns.map((c) => c.name),
        potentialFKs: t.columns.filter((c) => FK_PATTERN.test(c.name)).map((c) => c.name),
      }))
      .filter((t) => t.potentialFKs.length > 0);
    if (!visible.length) return { added: 0 };

    let inferred: any[];
    try {
      inferred = this.parseJsonArray(
        await this.invokeText(model, this.relationsPrompt(visible, manifest, domain)),
      );
    } catch (err: any) {
      this.logger.warn(`Relation inference failed: ${err.message}`);
      return { added: 0, error: err.message };
    }

    const existing = new Set(manifest.relations.map((r) => `${r.from}→${r.to}`));
    let added = 0;
    for (const r of inferred) {
      if (!r?.from || !r?.to) continue;
      const rel: SchemaManifestRelation = { from: String(r.from), to: String(r.to), label: r.label ? String(r.label) : undefined };
      const key = `${rel.from}→${rel.to}`;
      if (existing.has(key)) continue;
      existing.add(key);
      manifest.relations.push(rel);
      added++;
    }
    return { added };
  }

  private relationsPrompt(
    visible: Array<{ table: string; columns: string[]; potentialFKs: string[] }>,
    manifest: SchemaManifest,
    domain: string,
  ): string {
    const allTables = manifest.tables.filter((t) => !t.deny).map((t) => t.name).join(', ');
    return `You are a relational database expert. Database context: ${domain}.

You must identify the IMPLICIT relations between tables (foreign keys not formally declared in the DB).

Available tables: ${allTables}

For each potential FK column, identify which table.column (primary key) it points to,
based on the naming conventions visible in the schema. Include ONLY relations you are
reasonably sure of: do NOT make them up. For composite keys use two separate entries.

Schema with candidate FK columns:
${JSON.stringify(visible, null, 2)}

Respond ONLY with a JSON array, without markdown. Each element:
{ "from": "table.column", "to": "table.column", "label": "short description" }`;
  }
}
