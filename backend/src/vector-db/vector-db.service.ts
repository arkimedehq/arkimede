import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { I18nContext } from 'nestjs-i18n';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VectorDbConfigEntity } from './vector-db-config.entity';
import { VectorCollectionEntity } from './vector-collection.entity';
import type { VectorDbProvider } from './vector-store.types';
import { encrypt } from '../custom-tools/crypto.utils';

const CONFIG_ID = 1;

/**
 * URL the migration seeds the singleton row with (bare-metal default). Recognising it lets
 * the boot realign a row nobody ever configured to the Qdrant of the current deployment.
 */
const SEEDED_QDRANT_URL = 'http://localhost:6333';

export interface UpdateVectorDbConfigDto {
  provider:          VectorDbProvider;
  url?:              string | null;
  connectionString?: string | null;
  /** API key in cleartext. String → encrypt; null → remove; undefined → keep. */
  apiKey?:           string | null;
  extraConfig?:      Record<string, any> | null;
}

export interface UpsertCollectionDto {
  name: string;
  description?: string | null;
  isDefault?: boolean;
}

@Injectable()
export class VectorDbService implements OnModuleInit {
  private readonly logger = new Logger(VectorDbService.name);

  constructor(
    @InjectRepository(VectorDbConfigEntity)
    private readonly configRepo: Repository<VectorDbConfigEntity>,
    @InjectRepository(VectorCollectionEntity)
    private readonly collectionRepo: Repository<VectorCollectionEntity>,
    private readonly cfg: ConfigService,
  ) {}

  /**
   * Default Qdrant URL for the seeded singleton row: QDRANT_URL env var,
   * so the seed works both in Docker (http://qdrant:6333) and bare dev.
   */
  private defaultQdrantUrl(): string {
    return this.cfg.get<string>('QDRANT_URL', 'http://localhost:6333');
  }

  /**
   * At boot: make sure the singleton row points at the Qdrant of THIS deployment.
   *
   * Creating it when missing is not enough: the migration seeds the row with the bare-metal
   * default (http://localhost:6333), so in Docker the row already exists and points the
   * backend at itself → every collection op dies with "fetch failed". So we also heal a row
   * that still carries that untouched default while QDRANT_URL says otherwise (Docker:
   * http://qdrant:6333). A URL the admin actually chose is never overwritten.
   */
  async onModuleInit(): Promise<void> {
    const existing = await this.configRepo.findOne({ where: { id: CONFIG_ID } });
    if (!existing) {
      await this.configRepo.save({
        id:       CONFIG_ID,
        provider: 'qdrant',
        url:      this.defaultQdrantUrl(),
      });
      this.logger.log('VectorDbConfig: singleton row created (provider=qdrant)');
      return;
    }

    const envUrl = this.defaultQdrantUrl();
    const untouchedDefault = existing.provider === 'qdrant' && existing.url === SEEDED_QDRANT_URL;
    if (untouchedDefault && envUrl !== SEEDED_QDRANT_URL) {
      await this.configRepo.update({ id: CONFIG_ID }, { url: envUrl });
      this.logger.log(`VectorDbConfig: seeded URL realigned to the deployment (${envUrl})`);
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  /** Returns the current configuration (without decrypting the API key). */
  async getConfig(): Promise<VectorDbConfigEntity & { hasApiKey: boolean }> {
    const cfg = await this.configRepo.findOne({ where: { id: CONFIG_ID } });
    if (!cfg) {
      const created = await this.configRepo.save({
        id: CONFIG_ID, provider: 'qdrant', url: this.defaultQdrantUrl(),
      });
      return { ...created, hasApiKey: false };
    }
    return { ...cfg, hasApiKey: !!cfg.apiKey };
  }

  /** Updates the vector DB configuration. */
  async updateConfig(dto: UpdateVectorDbConfigDto): Promise<VectorDbConfigEntity & { hasApiKey: boolean }> {
    const current = await this.configRepo.findOne({ where: { id: CONFIG_ID } });

    let encryptedKey = current?.apiKey ?? null;
    if (dto.apiKey === null) {
      encryptedKey = null;
    } else if (typeof dto.apiKey === 'string' && dto.apiKey.trim() !== '') {
      encryptedKey = encrypt(dto.apiKey.trim());
    }

    await this.configRepo.save({
      id:               CONFIG_ID,
      provider:         dto.provider,
      url:              dto.url              ?? null,
      connectionString: dto.connectionString ?? null,
      apiKey:           encryptedKey,
      extraConfig:      dto.extraConfig      ?? null,
    });

    this.logger.log(`VectorDbConfig: updated — provider=${dto.provider}`);
    return this.getConfig();
  }

  // ── Collections ──────────────────────────────────────────────────────────────

  /** Lists all collections, ordered by name. */
  async listCollections(): Promise<VectorCollectionEntity[]> {
    return this.collectionRepo.find({ order: { name: 'ASC' } });
  }

  /** Returns the default collection, or null if not set. */
  async getDefaultCollection(): Promise<VectorCollectionEntity | null> {
    return this.collectionRepo.findOne({ where: { isDefault: true } });
  }

  /** Creates a new collection. */
  async createCollection(dto: UpsertCollectionDto): Promise<VectorCollectionEntity> {
    const existing = await this.collectionRepo.findOne({ where: { name: dto.name } });
    if (existing) {
      throw new ConflictException(
        I18nContext.current()?.t('vectordb.collectionAlreadyExists', { args: { name: dto.name } }) ?? `Collection "${dto.name}" already exists`,
      );
    }

    // If isDefault is true, remove the default from the others
    if (dto.isDefault) {
      await this.clearAllDefaults();
    }

    const entity = this.collectionRepo.create({
      name:        dto.name,
      description: dto.description ?? null,
      isDefault:   dto.isDefault ?? false,
    });
    const saved = await this.collectionRepo.save(entity);
    this.logger.log(`Collection created: "${saved.name}"${saved.isDefault ? ' (default)' : ''}`);
    return saved;
  }

  /** Updates an existing collection. */
  async updateCollection(id: string, dto: Partial<UpsertCollectionDto>): Promise<VectorCollectionEntity> {
    const col = await this.collectionRepo.findOne({ where: { id } });
    if (!col) throw new NotFoundException('vectordb.collectionNotFound');

    // If renaming, check for duplicates
    if (dto.name && dto.name !== col.name) {
      const dup = await this.collectionRepo.findOne({ where: { name: dto.name } });
      if (dup) throw new ConflictException(
        I18nContext.current()?.t('vectordb.collectionAlreadyExists', { args: { name: dto.name } }) ?? `Collection "${dto.name}" already exists`,
      );
      col.name = dto.name;
    }

    if (dto.description !== undefined) col.description = dto.description ?? null;

    // If isDefault is set to true, remove the default from the others
    if (dto.isDefault === true) {
      await this.clearAllDefaults();
      col.isDefault = true;
    } else if (dto.isDefault === false) {
      col.isDefault = false;
    }

    const saved = await this.collectionRepo.save(col);
    this.logger.log(`Collection updated: "${saved.name}"`);
    return saved;
  }

  /** Sets a collection as default (removes the flag from the others). */
  async setDefault(id: string): Promise<VectorCollectionEntity> {
    const col = await this.collectionRepo.findOne({ where: { id } });
    if (!col) throw new NotFoundException('vectordb.collectionNotFound');

    await this.clearAllDefaults();
    col.isDefault = true;
    const saved = await this.collectionRepo.save(col);
    this.logger.log(`Collection default set: "${saved.name}"`);
    return saved;
  }

  /** Deletes a collection. You cannot delete the default collection if it is the last one. */
  async deleteCollection(id: string): Promise<void> {
    const col = await this.collectionRepo.findOne({ where: { id } });
    if (!col) throw new NotFoundException('vectordb.collectionNotFound');

    if (col.isDefault) {
      const total = await this.collectionRepo.count();
      if (total === 1) {
        throw new BadRequestException('vectordb.cannotDeleteLastDefault');
      }
    }

    await this.collectionRepo.remove(col);
    this.logger.log(`Collection deleted: "${col.name}"`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /** Removes the isDefault flag from all collections. */
  private async clearAllDefaults(): Promise<void> {
    await this.collectionRepo
      .createQueryBuilder()
      .update(VectorCollectionEntity)
      .set({ isDefault: false })
      .where('isDefault = true')
      .execute();
  }
}
