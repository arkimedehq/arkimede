import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { projectsApi, type ProjectTeamRole } from '../../api/projects';
import { teamsApi } from '../../api/teams';
import { useStore } from '../../store/useStore';
import { Users, Trash2, Plus } from 'lucide-react';

/**
 * Manages sharing a project with teams (collaborator/viewer).
 * Visible only to the project owner or an admin (see ProjectModal).
 *
 * - Admin: can assign any team (teamsApi.list).
 * - Non-admin owner: can only assign teams they are a member of (teamsApi.mine).
 */
export default function ProjectTeamsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation('projects');
  const qc = useQueryClient();
  const user = useStore((s) => s.user);
  const isAdmin = user?.role === 'admin';

  const [teamId, setTeamId] = useState('');
  const [role, setRole] = useState<ProjectTeamRole>('collaborator');
  const [error, setError] = useState('');

  const { data: assigned = [] } = useQuery({
    queryKey: ['project-teams', projectId],
    queryFn: () => projectsApi.listTeams(projectId),
  });
  const { data: available = [] } = useQuery({
    queryKey: ['teams-for-sharing', isAdmin],
    queryFn: () => (isAdmin ? teamsApi.list() : teamsApi.mine()),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['project-teams', projectId] });
  const onErr = (e: any) => setError(e.response?.data?.message || t('teams.error'));

  const add = useMutation({
    mutationFn: () => projectsApi.addTeam(projectId, teamId, role),
    onSuccess: () => { invalidate(); setTeamId(''); setError(''); },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: (tid: string) => projectsApi.removeTeam(projectId, tid),
    onSuccess: invalidate, onError: onErr,
  });
  const changeRole = useMutation({
    mutationFn: (v: { tid: string; r: ProjectTeamRole }) => projectsApi.setTeamRole(projectId, v.tid, v.r),
    onSuccess: invalidate, onError: onErr,
  });

  const assignedIds = new Set(assigned.map((a) => a.teamId));
  const addable = available.filter((t) => !assignedIds.has(t.id));

  return (
    <div className="border-t border-gray-800 pt-4">
      <label className="block text-sm text-gray-300 mb-2 flex items-center gap-1.5">
        <Users size={13} className="text-gray-400" />
        {t('teams.label')}
      </label>

      {error && <div className="text-red-400 text-xs bg-red-500/10 rounded-lg p-2 mb-2">{error}</div>}

      {/* Already assigned teams */}
      {assigned.length > 0 ? (
        <div className="space-y-1.5 mb-3">
          {assigned.map((pt) => (
            <div key={pt.id} className="flex items-center gap-2 bg-gray-800/60 rounded-lg px-2.5 py-1.5">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: pt.team?.color || '#6b7280' }}
              />
              <span className="text-sm text-gray-200 flex-1 truncate">{pt.team?.name ?? pt.teamId}</span>
              <select
                className="bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 px-1.5 py-1"
                value={pt.role}
                onChange={(e) => changeRole.mutate({ tid: pt.teamId, r: e.target.value as ProjectTeamRole })}
              >
                <option value="collaborator">{t('teams.roleCollaborator')}</option>
                <option value="viewer">{t('teams.roleViewer')}</option>
              </select>
              <button
                onClick={() => remove.mutate(pt.teamId)}
                className="text-gray-500 hover:text-red-400 p-1"
                title={t('teams.removeTeam')}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-gray-600 mb-3">{t('teams.assignedEmpty')}</p>
      )}

      {/* Add team */}
      <div className="flex items-center gap-2">
        <select
          className="input-field flex-1 text-sm py-1.5"
          value={teamId}
          onChange={(e) => setTeamId(e.target.value)}
        >
          <option value="">{addable.length ? t('teams.addPlaceholder') : t('teams.noneAvailable')}</option>
          {addable.map((team) => (
            <option key={team.id} value={team.id}>{team.name}</option>
          ))}
        </select>
        <select
          className="bg-gray-900 border border-gray-700 rounded text-xs text-gray-300 px-1.5 py-2"
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectTeamRole)}
        >
          <option value="collaborator">{t('teams.roleCollaborator')}</option>
          <option value="viewer">{t('teams.roleViewer')}</option>
        </select>
        <button
          onClick={() => add.mutate()}
          disabled={!teamId || add.isPending}
          className="btn-primary px-3 py-2 disabled:opacity-50"
          title={t('teams.assign')}
        >
          <Plus size={15} />
        </button>
      </div>
    </div>
  );
}
