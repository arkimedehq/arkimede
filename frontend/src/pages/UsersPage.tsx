import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users, Plus, Search, Shield, ShieldOff, KeyRound, Trash2, Ban, CheckCircle2, X, Loader2, ArrowLeft,
} from 'lucide-react';
import {
  adminUsersApi, type AdminUser, type UserRole, type UserStatus,
} from '../api/adminUsers';
import { useStore } from '../store/useStore';

/**
 * Admin section: user management.
 * Exported as `UsersSection` and mounted in SettingsPage (adminOnly).
 */
export function UsersSection() {
  const { t } = useTranslation('users');
  const qc = useQueryClient();
  const me = useStore((s) => s.user);

  const [search, setSearch]   = useState('');
  const [role, setRole]       = useState<UserRole | ''>('');
  const [status, setStatus]   = useState<UserStatus | ''>('');
  const [page, setPage]       = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editUser, setEditUser]     = useState<AdminUser | null>(null);
  const [resetUser, setResetUser]   = useState<AdminUser | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const pageSize = 25;
  const query = useQuery({
    queryKey: ['admin-users', { search, role, status, page }],
    queryFn: () => adminUsersApi.list({
      search: search || undefined,
      role:   role || undefined,
      status: status || undefined,
      page, pageSize,
    }),
    staleTime: 10_000,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-users'] });
  const onError = (e: any) => setErr(e?.response?.data?.message ?? t('errors.operationFailed'));

  const setRoleM = useMutation({
    mutationFn: ({ id, role: r }: { id: string; role: UserRole }) => adminUsersApi.setRole(id, r),
    onSuccess: () => { setErr(null); invalidate(); }, onError,
  });
  const setStatusM = useMutation({
    mutationFn: ({ id, status: s }: { id: string; status: UserStatus }) => adminUsersApi.setStatus(id, s),
    onSuccess: () => { setErr(null); invalidate(); }, onError,
  });
  const removeM = useMutation({
    mutationFn: (id: string) => adminUsersApi.remove(id),
    onSuccess: () => { setErr(null); invalidate(); }, onError,
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Editors replace the table in-place (Flows-style) instead of a modal.
  if (createOpen) {
    return <CreateUserEditor onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); invalidate(); }} />;
  }
  if (editUser) {
    return <EditUserEditor user={editUser} onClose={() => setEditUser(null)} onSaved={() => { setEditUser(null); invalidate(); }} />;
  }
  if (resetUser) {
    return <ResetPasswordEditor user={resetUser} onClose={() => setResetUser(null)} />;
  }

  return (
    <div>
      <Header
        title={t('header.title')}
        subtitle={t('header.subtitle')}
        icon={Users}
        action={
          <button onClick={() => setCreateOpen(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
            <Plus size={16} /> {t('header.newUser')}
          </button>
        }
      />

      {err && <Banner text={err} onClose={() => setErr(null)} />}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('filter.searchPlaceholder')}
            className="input-field w-full pl-9 py-2 text-sm"
          />
        </div>
        <select value={role} onChange={(e) => { setRole(e.target.value as any); setPage(1); }} className="input-field py-2 text-sm">
          <option value="">{t('filter.allRoles')}</option>
          <option value="admin">{t('filter.roleAdmin')}</option>
          <option value="user">{t('filter.roleUser')}</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value as any); setPage(1); }} className="input-field py-2 text-sm">
          <option value="">{t('filter.allStatuses')}</option>
          <option value="active">{t('filter.statusActive')}</option>
          <option value="disabled">{t('filter.statusDisabled')}</option>
        </select>
      </div>

      {/* Table */}
      <div className="border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-900 text-gray-400">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">{t('table.colName')}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t('table.colEmail')}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t('table.colRole')}</th>
              <th className="text-left px-4 py-2.5 font-medium">{t('table.colStatus')}</th>
              <th className="text-right px-4 py-2.5 font-medium">{t('table.colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {query.isLoading && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                <Loader2 className="animate-spin inline" size={18} />
              </td></tr>
            )}
            {!query.isLoading && items.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">{t('table.empty')}</td></tr>
            )}
            {items.map((u) => {
              const isSelf = u.id === me?.id;
              return (
                <tr key={u.id} className="border-t border-gray-800 hover:bg-gray-900/50">
                  <td className="px-4 py-2.5 text-gray-200">
                    {u.name} {isSelf && <span className="text-xs text-gray-500">{t('table.self')}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-gray-400">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <RoleBadge role={u.role} />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={u.status} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        title={t('actions.edit')}
                        onClick={() => setEditUser(u)}
                        className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors"
                      >✎</button>
                      <button
                        title={u.role === 'admin' ? t('actions.makeUser') : t('actions.makeAdmin')}
                        disabled={setRoleM.isPending}
                        onClick={() => setRoleM.mutate({ id: u.id, role: u.role === 'admin' ? 'user' : 'admin' })}
                        className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors"
                      >{u.role === 'admin' ? <ShieldOff size={15} /> : <Shield size={15} />}</button>
                      <button
                        title={u.status === 'active' ? t('actions.disable') : t('actions.enable')}
                        disabled={isSelf || setStatusM.isPending}
                        onClick={() => setStatusM.mutate({ id: u.id, status: u.status === 'active' ? 'disabled' : 'active' })}
                        className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors disabled:opacity-30"
                      >{u.status === 'active' ? <Ban size={15} /> : <CheckCircle2 size={15} />}</button>
                      <button title={t('actions.resetPassword')} onClick={() => setResetUser(u)} className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors">
                        <KeyRound size={15} />
                      </button>
                      <button
                        title={t('actions.delete')}
                        disabled={isSelf}
                        onClick={() => {
                          if (confirm(t('confirm.deleteUser', { name: u.name }))) removeM.mutate(u.id);
                        }}
                        className="p-1.5 text-gray-400 hover:text-gray-200 rounded transition-colors text-red-400 hover:text-red-300 disabled:opacity-30"
                      ><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3 text-sm text-gray-500">
        <span>{t('pagination.total', { count: total })}</span>
        <div className="flex items-center gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 rounded border border-gray-800 disabled:opacity-30">‹</button>
          <span>{page} / {totalPages}</span>
          <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 rounded border border-gray-800 disabled:opacity-30">›</button>
        </div>
      </div>

    </div>
  );
}

// ── Modals ──────────────────────────────────────────────────────────────────────

function CreateUserEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('users');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [err, setErr] = useState<string | null>(null);

  const m = useMutation({
    mutationFn: () => adminUsersApi.create({ name, email, password, role }),
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.createFailed')),
  });

  return (
    <InlineEditor backLabel={t('header.title')} title={t('modal.createTitle')} onBack={onClose}>
      {err && <Banner text={err} onClose={() => setErr(null)} />}
      <Field label={t('modal.fieldName')}><input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('modal.fieldEmail')}><input className="input-field w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label={t('modal.fieldPassword')}><input className="input-field w-full" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <Field label={t('modal.fieldRole')}>
        <select className="input-field w-full" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
          <option value="user">{t('filter.roleUser')}</option>
          <option value="admin">{t('filter.roleAdmin')}</option>
        </select>
      </Field>
      <ModalActions onClose={onClose} onConfirm={() => m.mutate()} pending={m.isPending} disabled={!name || !email || password.length < 6} />
    </InlineEditor>
  );
}

function EditUserEditor({ user, onClose, onSaved }: { user: AdminUser; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('users');
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => adminUsersApi.update(user.id, { name, email }),
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.updateFailed')),
  });
  return (
    <InlineEditor backLabel={t('header.title')} title={t('modal.editTitle', { name: user.name })} onBack={onClose}>
      {err && <Banner text={err} onClose={() => setErr(null)} />}
      <Field label={t('modal.fieldName')}><input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('modal.fieldEmail')}><input className="input-field w-full" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <ModalActions onClose={onClose} onConfirm={() => m.mutate()} pending={m.isPending} disabled={!name || !email} />
    </InlineEditor>
  );
}

function ResetPasswordEditor({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const { t } = useTranslation('users');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => adminUsersApi.resetPassword(user.id, password),
    onSuccess: () => setDone(true),
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.resetFailed')),
  });
  return (
    <InlineEditor backLabel={t('header.title')} title={t('modal.resetTitle', { name: user.name })} onBack={onClose}>
      {err && <Banner text={err} onClose={() => setErr(null)} />}
      {done ? (
        <p className="text-sm text-green-400 mb-4">{t('modal.passwordUpdated')}</p>
      ) : (
        <Field label={t('modal.fieldNewPassword')}>
          <input className="input-field w-full" type="text" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      )}
      {done
        ? <div className="flex justify-end"><button onClick={onClose} className="btn-primary px-4 py-2 text-sm">{t('modal.close')}</button></div>
        : <ModalActions onClose={onClose} onConfirm={() => m.mutate()} pending={m.isPending} disabled={password.length < 6} confirmLabel={t('modal.resetConfirmLabel')} />}
    </InlineEditor>
  );
}

// ── UI helpers ──────────────────────────────────────────────────────────────

function Header({ title, subtitle, icon: Icon, action }: { title: string; subtitle: string; icon: React.ElementType; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between mb-5">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><Icon size={18} /></div>
        <div>
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

function RoleBadge({ role }: { role: UserRole }) {
  const { t } = useTranslation('users');
  return role === 'admin'
    ? <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300">{t('role.admin')}</span>
    : <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{t('role.user')}</span>;
}

function StatusBadge({ status }: { status: UserStatus }) {
  const { t } = useTranslation('users');
  return status === 'active'
    ? <span className="text-xs px-2 py-0.5 rounded-full bg-green-900/40 text-green-300">{t('status.active')}</span>
    : <span className="text-xs px-2 py-0.5 rounded-full bg-red-900/40 text-red-300">{t('status.disabled')}</span>;
}

function Banner({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-red-950/50 border border-red-900 text-red-300 text-sm rounded-lg px-3 py-2 mb-3">
      <span>{text}</span>
      <button onClick={onClose}><X size={14} /></button>
    </div>
  );
}

/**
 * Inline editor shell (Flows-style): back button + title, replaces the section
 * content instead of overlaying a modal. Shared with other admin sections.
 */
export function InlineEditor({ backLabel, title, onBack, children }: {
  backLabel: string; title: string; onBack: () => void; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onBack} className="text-gray-400 hover:text-white flex items-center gap-1 text-sm flex-shrink-0">
          <ArrowLeft size={16} /> {backLabel}
        </button>
        <h3 className="text-base font-semibold text-white truncate">{title}</h3>
      </div>
      <div className="max-w-lg">{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mb-3">
      <span className="block text-xs font-medium text-gray-400 mb-1">{label}</span>
      {children}
    </label>
  );
}

export function ModalActions({ onClose, onConfirm, pending, disabled, confirmLabel }: {
  onClose: () => void; onConfirm: () => void; pending?: boolean; disabled?: boolean; confirmLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2 mt-2">
      <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg text-gray-300 hover:bg-gray-800">{t('actions.cancel')}</button>
      <button onClick={onConfirm} disabled={pending || disabled} className="btn-primary px-4 py-2 text-sm disabled:opacity-50 flex items-center gap-2">
        {pending && <Loader2 className="animate-spin" size={14} />} {confirmLabel ?? t('actions.save')}
      </button>
    </div>
  );
}
