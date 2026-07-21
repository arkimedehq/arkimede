import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { UsersRound, Plus, Trash2, Users as UsersIcon, Loader2, Crown, UserMinus } from 'lucide-react';
import { teamsApi, type TeamWithCount, type TeamRole } from '../api/teams';
import { adminUsersApi } from '../api/adminUsers';
import { Field, ModalActions, InlineEditor } from './UsersPage';

/**
 * Admin section: team and member management.
 * Exported as `TeamsSection` and mounted in SettingsPage (adminOnly).
 */
export function TeamsSection() {
  const { t } = useTranslation('teams');
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [membersTeam, setMembersTeam] = useState<TeamWithCount | null>(null);

  const query = useQuery({ queryKey: ['teams'], queryFn: teamsApi.list, staleTime: 10_000 });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['teams'] });

  const teams = query.data ?? [];

  // Editors replace the list in-place (Flows-style) instead of a modal.
  if (createOpen) {
    return <CreateTeamEditor onClose={() => setCreateOpen(false)} onSaved={() => { setCreateOpen(false); invalidate(); }} />;
  }
  if (membersTeam) {
    return <MembersEditor team={membersTeam} onClose={() => { setMembersTeam(null); invalidate(); }} />;
  }

  return (
    <div>
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gray-800 flex items-center justify-center text-gray-300"><UsersRound size={18} /></div>
          <div>
            <h2 className="text-lg font-semibold text-white">Team</h2>
            <p className="text-sm text-gray-500">{t('header.subtitle')}</p>
          </div>
        </div>
        <button onClick={() => setCreateOpen(true)} className="btn-primary px-4 py-2 text-sm flex items-center gap-2">
          <Plus size={16} /> {t('actions.newTeam')}
        </button>
      </div>

      {query.isLoading ? (
        <div className="text-center py-10 text-gray-500"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : teams.length === 0 ? (
        <div className="text-center py-10 text-gray-500 border border-dashed border-gray-800 rounded-xl">
          {t('empty.noTeams')}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {teams.map((team) => (
            <button key={team.id} onClick={() => setMembersTeam(team)}
              className="text-left w-full border border-gray-800 rounded-xl p-4 hover:border-gray-700 transition-colors">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: team.color ?? '#6b7280' }} />
                <div className="min-w-0">
                  <div className="font-medium text-gray-100 truncate">{team.name}</div>
                  {team.description && <div className="text-xs text-gray-500 truncate">{team.description}</div>}
                </div>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-sm text-blue-400">
                <UsersIcon size={14} /> {t('member', { count: team.memberCount })} — {t('actions.manageMembers')}
              </div>
            </button>
          ))}
        </div>
      )}

    </div>
  );
}

function CreateTeamEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation('teams');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [err, setErr] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => teamsApi.create({ name, description: description || null, color }),
    onSuccess: onSaved,
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.createTeam')),
  });
  return (
    <InlineEditor backLabel="Team" title={t('modal.createTitle')} onBack={onClose}>
      {err && <p className="text-sm text-red-400 mb-3">{err}</p>}
      <Field label={t('modal.form.nameLabel')}><input className="input-field w-full" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label={t('modal.form.descriptionLabel')}><input className="input-field w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label={t('modal.form.colorLabel')}>
        <input type="color" className="h-9 w-16 bg-gray-800 rounded border border-gray-700" value={color} onChange={(e) => setColor(e.target.value)} />
      </Field>
      <ModalActions onClose={onClose} onConfirm={() => m.mutate()} pending={m.isPending} disabled={name.trim().length < 2} />
    </InlineEditor>
  );
}

function MembersEditor({ team, onClose }: { team: TeamWithCount; onClose: () => void }) {
  const { t } = useTranslation('teams');
  const qc = useQueryClient();
  const [err, setErr] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const membersQ = useQuery({ queryKey: ['team-members', team.id], queryFn: () => teamsApi.members(team.id) });
  const usersQ = useQuery({
    queryKey: ['admin-users', 'picker', search],
    queryFn: () => adminUsersApi.list({ search: search || undefined, pageSize: 8 }),
    staleTime: 10_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['team-members', team.id] });
    qc.invalidateQueries({ queryKey: ['teams'] });
  };
  const onErr = (e: any) => setErr(e?.response?.data?.message ?? t('errors.operation'));

  const addM = useMutation({
    mutationFn: (userId: string) => teamsApi.addMember(team.id, userId, 'member'),
    onSuccess: () => { setErr(null); invalidate(); }, onError: onErr,
  });
  const roleM = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: TeamRole }) => teamsApi.setMemberRole(team.id, userId, role),
    onSuccess: () => { setErr(null); invalidate(); }, onError: onErr,
  });
  const removeM = useMutation({
    mutationFn: (userId: string) => teamsApi.removeMember(team.id, userId),
    onSuccess: () => { setErr(null); invalidate(); }, onError: onErr,
  });
  const deleteTeamM = useMutation({
    mutationFn: () => teamsApi.remove(team.id),
    onSuccess: onClose, // section's onClose invalidates the list + goes back
    onError: (e: any) => setErr(e?.response?.data?.message ?? t('errors.deleteTeam')),
  });

  const members = membersQ.data ?? [];
  const memberIds = new Set(members.map((m) => m.userId));
  const candidates = (usersQ.data?.items ?? []).filter((u) => !memberIds.has(u.id));

  return (
    <InlineEditor backLabel="Team" title={t('modal.membersTitle', { name: team.name })} onBack={onClose}>
      {err && <p className="text-sm text-red-400 mb-3">{err}</p>}

      {/* Current members */}
      <div className="mb-4">
        <p className="text-xs font-medium text-gray-400 mb-2">{t('modal.sections.currentMembers', { count: members.length })}</p>
        {membersQ.isLoading ? (
          <Loader2 className="animate-spin text-gray-500" size={16} />
        ) : members.length === 0 ? (
          <p className="text-sm text-gray-500">{t('empty.noMembers')}</p>
        ) : (
          <ul className="space-y-1.5 max-h-48 overflow-y-auto">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 bg-gray-800/50 rounded-lg px-3 py-1.5">
                <div className="min-w-0">
                  <div className="text-sm text-gray-200 truncate">{m.user?.name ?? m.userId}</div>
                  <div className="text-xs text-gray-500 truncate">{m.user?.email}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    title={m.role === 'owner' ? t('actions.makeMember') : t('actions.makeOwner')}
                    onClick={() => roleM.mutate({ userId: m.userId, role: m.role === 'owner' ? 'member' : 'owner' })}
                    className={`p-1.5 rounded transition-colors ${m.role === 'owner' ? 'text-amber-400 hover:text-amber-300' : 'text-gray-500 hover:text-gray-300'}`}
                  ><Crown size={14} /></button>
                  <button
                    title={t('actions.removeMember')}
                    onClick={() => removeM.mutate(m.userId)}
                    className="p-1.5 text-gray-400 hover:text-red-400 rounded transition-colors"
                  ><UserMinus size={14} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Add members */}
      <div>
        <p className="text-xs font-medium text-gray-400 mb-2">{t('modal.sections.addMembers')}</p>
        <input
          className="input-field w-full mb-2"
          placeholder={t('modal.search.placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="space-y-1 max-h-40 overflow-y-auto">
          {candidates.map((u) => (
            <li key={u.id} className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-gray-800/50 rounded-lg">
              <div className="min-w-0">
                <div className="text-sm text-gray-200 truncate">{u.name}</div>
                <div className="text-xs text-gray-500 truncate">{u.email}</div>
              </div>
              <button
                onClick={() => addM.mutate(u.id)}
                disabled={addM.isPending}
                className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white flex-shrink-0"
              >{t('actions.addMember')}</button>
            </li>
          ))}
          {candidates.length === 0 && !usersQ.isLoading && (
            <li className="text-sm text-gray-500 px-3 py-1.5">{t('empty.noUsers')}</li>
          )}
        </ul>
      </div>

      {/* Footer: delete team (left) + close (right) */}
      <div className="flex items-center gap-2 mt-6 pt-4 border-t border-gray-800">
        {confirmDelete ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            <span className="text-xs text-gray-400">{t('actions.deleteTeam')}?</span>
            <button onClick={() => deleteTeamM.mutate()} disabled={deleteTeamM.isPending}
              className="px-2 py-1 text-xs bg-red-600 hover:bg-red-500 text-white rounded transition-colors">
              {deleteTeamM.isPending ? <Loader2 size={12} className="animate-spin" /> : t('actions.deleteTeam')}
            </button>
            <button onClick={() => setConfirmDelete(false)} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200 rounded">
              {t('common:actions.cancel')}
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)} title={t('actions.deleteTeam')}
            className="flex items-center gap-1.5 px-2.5 py-2 text-sm text-gray-400 hover:text-red-400 rounded-lg transition-colors flex-shrink-0">
            <Trash2 size={15} /> {t('actions.deleteTeam')}
          </button>
        )}
        <div className="flex-1" />
        <button onClick={onClose} className="btn-primary px-4 py-2 text-sm">{t('common:actions.close')}</button>
      </div>
    </InlineEditor>
  );
}
