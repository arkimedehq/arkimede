import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Lock, Users, Globe } from 'lucide-react';
import { teamsApi } from '../api/teams';

export type ResourceScope = 'personal' | 'team' | 'org';

const OPTIONS: { value: ResourceScope; labelKey: string; icon: React.ElementType; activeClass: string }[] = [
  { value: 'personal', labelKey: 'scope.personalLabel', icon: Lock,  activeClass: 'bg-gray-700 text-white border-gray-600' },
  { value: 'team',     labelKey: 'scope.teamLabel',     icon: Users, activeClass: 'bg-amber-600/80 text-white border-amber-500' },
  { value: 'org',      labelKey: 'scope.orgLabel',      icon: Globe, activeClass: 'bg-blue-600 text-white border-blue-500' },
];

/**
 * Scope selector shared by Tool / Skill / DataSource.
 * Shows the 3 options personal|team|org and, if scope='team', a dropdown
 * with the user's teams (GET /api/teams/mine). When 'team' is chosen it
 * automatically preselects the first available team.
 */
export function ScopeSelector({
  scope, teamId, onScope, onTeam, disabled, allowOrg = true,
}: {
  scope: ResourceScope;
  teamId: string | null;
  onScope: (s: ResourceScope) => void;
  onTeam: (id: string | null) => void;
  disabled?: boolean;
  /** Show the "org" option only if the user can create one (admin). Default true. */
  allowOrg?: boolean;
}) {
  const { t } = useTranslation('common');
  const teamsQ = useQuery({ queryKey: ['teams', 'mine'], queryFn: teamsApi.mine, staleTime: 30_000 });
  const teams = teamsQ.data ?? [];
  const options = allowOrg ? OPTIONS : OPTIONS.filter((o) => o.value !== 'org');

  return (
    <div>
      <div className="flex gap-1.5">
        {options.map(({ value, labelKey, icon: Icon, activeClass }) => (
          <button
            key={value}
            type="button"
            disabled={disabled}
            onClick={() => {
              onScope(value);
              if (value === 'team') onTeam(teamId ?? teams[0]?.id ?? null);
              else onTeam(null);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors
              ${scope === value ? activeClass : 'border-gray-700 text-gray-400 hover:text-gray-200'}`}
          >
            <Icon size={11} /> {t(labelKey)}
          </button>
        ))}
      </div>

      {scope === 'team' && (
        <div className="mt-2">
          {teams.length === 0 ? (
            <p className="text-xs text-amber-400">{t('scope.noTeams')}</p>
          ) : (
            <select
              className="input-field w-full text-sm"
              value={teamId ?? ''}
              onChange={(e) => onTeam(e.target.value || null)}
              disabled={disabled}
            >
              <option value="" disabled>{t('scope.chooseTeam')}</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          )}
        </div>
      )}

      <p className="mt-1.5 text-xs text-gray-500">
        {scope === 'personal' && t('scope.descPersonal')}
        {scope === 'team' && t('scope.descTeam')}
        {scope === 'org' && t('scope.descOrg')}
      </p>
    </div>
  );
}

/** Compact badge to indicate a resource's scope in lists. */
export function ScopeBadge({ scope }: { scope: ResourceScope }) {
  const { t } = useTranslation('common');
  if (scope === 'org') return <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-300">{t('scope.org')}</span>;
  if (scope === 'team') return <span className="text-xs px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300">{t('scope.team')}</span>;
  return <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">{t('scope.personal')}</span>;
}
