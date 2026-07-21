import {
  Injectable, NotFoundException, ConflictException, UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserRole, UserStatus } from './users.entity';
import { ToolLoadingStrategy, ToolSchemaFormat } from '../app-config/app-config.entity';

export type SafeUser = Omit<User, 'password' | 'projects' | 'chats' | 'files'>;

/** Safe fields exposed in the admin lists/details (never the password). */
const ADMIN_USER_SELECT = {
  id: true, email: true, name: true, role: true, status: true,
  createdAt: true, updatedAt: true,
} as const;

export interface ListUsersFilter {
  search?: string;
  role?: UserRole;
  status?: UserStatus;
  page?: number;
  pageSize?: number;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly repo: Repository<User>,
  ) {}

  create(data: Partial<User>) {
    return this.repo.save(this.repo.create(data));
  }

  findById(id: string) {
    return this.repo.findOne({ where: { id } });
  }

  /** Total number of registered users (used for bootstrapping the first admin). */
  count() {
    return this.repo.count();
  }

  findByEmail(email: string) {
    return this.repo.findOne({ where: { email } });
  }

  async getProfile(id: string): Promise<SafeUser> {
    const user = await this.repo.findOne({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        systemPrompt: true,
        language: true,
        toolLoadingStrategy: true,
        toolLoadingMaxTools: true,
        toolSchemaFormat: true,
        maxHistoryTokens: true,
        showTokenCount: true,
        autoMemoryEnabled: true,
        memoryThreshold: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) throw new NotFoundException('users.notFound');
    return user as SafeUser;
  }

  async updateProfile(
    id: string,
    dto: {
      name?: string;
      email?: string;
      systemPrompt?: string | null;
      language?: string | null;
      /** null = reset to the global default */
      toolLoadingStrategy?: ToolLoadingStrategy | null;
      toolLoadingMaxTools?: number | null;
      toolSchemaFormat?: ToolSchemaFormat | null;
      /** null = use the global default */
      maxHistoryTokens?: number | null;
      showTokenCount?: boolean;
      autoMemoryEnabled?: boolean;
      memoryThreshold?: number | null;
    },
  ): Promise<SafeUser> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.repo.findOne({ where: { email: dto.email } });
      if (conflict) throw new ConflictException('users.emailInUse');
      user.email = dto.email;
    }

    if (dto.name                !== undefined) user.name                = dto.name;
    if (dto.systemPrompt        !== undefined) user.systemPrompt        = dto.systemPrompt ?? null;
    if (dto.language            !== undefined) user.language            = dto.language ?? null;
    if (dto.toolLoadingStrategy !== undefined) user.toolLoadingStrategy = dto.toolLoadingStrategy ?? null;
    if (dto.toolLoadingMaxTools !== undefined) user.toolLoadingMaxTools = dto.toolLoadingMaxTools ?? null;
    if (dto.toolSchemaFormat    !== undefined) user.toolSchemaFormat    = dto.toolSchemaFormat ?? null;
    if (dto.maxHistoryTokens    !== undefined) user.maxHistoryTokens    = dto.maxHistoryTokens ?? null;
    if (dto.showTokenCount      !== undefined) user.showTokenCount      = dto.showTokenCount;
    if (dto.autoMemoryEnabled   !== undefined) user.autoMemoryEnabled   = dto.autoMemoryEnabled;
    if (dto.memoryThreshold     !== undefined) user.memoryThreshold     = dto.memoryThreshold ?? null;

    await this.repo.save(user);
    return this.getProfile(id);
  }

  async changePassword(
    id: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) throw new UnauthorizedException('users.wrongPassword');

    user.password = await bcrypt.hash(newPassword, 12);
    await this.repo.save(user);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // User administration (reserved for the admin role — see AdminUsersController)
  // ─────────────────────────────────────────────────────────────────────────

  /** Paginated list with filters by text search (name/email), role and status. */
  async listUsers(filter: ListUsersFilter): Promise<{ items: SafeUser[]; total: number; page: number; pageSize: number }> {
    const page     = Math.max(1, filter.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));

    const baseWhere: Record<string, unknown> = {};
    if (filter.role)   baseWhere.role   = filter.role;
    if (filter.status) baseWhere.status = filter.status;

    // The text search goes on name OR email → two where branches with the same base filters.
    const where = filter.search
      ? [
          { ...baseWhere, name:  ILike(`%${filter.search}%`) },
          { ...baseWhere, email: ILike(`%${filter.search}%`) },
        ]
      : baseWhere;

    const [items, total] = await this.repo.findAndCount({
      where,
      select: ADMIN_USER_SELECT,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return { items: items as SafeUser[], total, page, pageSize };
  }

  /** Single user detail for the admin. */
  async getById(id: string): Promise<SafeUser> {
    const user = await this.repo.findOne({ where: { id }, select: ADMIN_USER_SELECT });
    if (!user) throw new NotFoundException('users.notFound');
    return user as SafeUser;
  }

  /** Create a user from the admin panel (password provided by the admin, hashed). */
  async adminCreate(data: {
    email: string; name: string; password: string; role?: UserRole;
  }): Promise<SafeUser> {
    const existing = await this.repo.findOne({ where: { email: data.email } });
    if (existing) throw new ConflictException('users.emailTaken');

    const password = await bcrypt.hash(data.password, 12);
    const user = await this.repo.save(this.repo.create({
      email: data.email,
      name: data.name,
      password,
      role: data.role ?? 'user',
      status: 'active',
    }));
    return this.getById(user.id);
  }

  /** Update a user's name/email (admin side). Role and status have dedicated endpoints. */
  async adminUpdate(id: string, data: { name?: string; email?: string }): Promise<SafeUser> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');

    if (data.email && data.email !== user.email) {
      const conflict = await this.repo.findOne({ where: { email: data.email } });
      if (conflict) throw new ConflictException('users.emailInUse');
      user.email = data.email;
    }
    if (data.name !== undefined) user.name = data.name;

    await this.repo.save(user);
    return this.getById(id);
  }

  /**
   * Change the role. Protection: you cannot remove the last active admin
   * (otherwise the org would be left with nobody able to administer it).
   */
  async setRole(id: string, role: UserRole): Promise<SafeUser> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');

    if (user.role === 'admin' && role !== 'admin') {
      await this.assertNotLastAdmin(id);
    }
    user.role = role;
    await this.repo.save(user);
    return this.getById(id);
  }

  /**
   * Enable/disable an account. Protection: you cannot disable
   * the last active admin.
   */
  async setStatus(id: string, status: UserStatus): Promise<SafeUser> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');

    if (status === 'disabled' && user.role === 'admin') {
      await this.assertNotLastAdmin(id);
    }
    user.status = status;
    await this.repo.save(user);
    return this.getById(id);
  }

  /** Password reset by admin: sets a new password (hashed). */
  async adminResetPassword(id: string, newPassword: string): Promise<void> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');
    user.password = await bcrypt.hash(newPassword, 12);
    await this.repo.save(user);
  }

  /**
   * Delete a user. Protection: you cannot delete the last active admin.
   * The linked history (chats/files) follows the cascade rules defined in the entities.
   */
  async deleteUser(id: string): Promise<void> {
    const user = await this.repo.findOne({ where: { id } });
    if (!user) throw new NotFoundException('users.notFound');
    if (user.role === 'admin') await this.assertNotLastAdmin(id);
    await this.repo.remove(user);
  }

  /** Throws if `excludeId` is the only active admin left. */
  private async assertNotLastAdmin(excludeId: string): Promise<void> {
    const otherActiveAdmins = await this.repo.count({
      where: { role: 'admin', status: 'active', id: Not(excludeId) },
    });
    if (otherActiveAdmins === 0) {
      throw new BadRequestException('users.lastAdminProtected');
    }
  }
}
