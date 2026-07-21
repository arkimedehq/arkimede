/**
 * i18n initialization (react-i18next).
 *
 * - Supported languages: en, it. Fallback: en.
 * - Detection (anonymous user / pre-login): localStorage → navigator.
 *   The preference saved on the user profile (User.language) takes precedence and
 *   is applied via `applyUserLanguage()` after login (see useUserLanguage).
 * - Per-feature namespaces: add the resources here as the pages are converted
 *   (common is the shared base: actions, scope, confirmations…).
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import itCommon from './locales/it/common.json';
import enSettings from './locales/en/settings.json';
import itSettings from './locales/it/settings.json';
import enTools from './locales/en/tools.json';
import itTools from './locales/it/tools.json';
import enAgents from './locales/en/agents.json';
import itAgents from './locales/it/agents.json';
import enChat from './locales/en/chat.json';
import itChat from './locales/it/chat.json';
import enFlows from './locales/en/flows.json';
import itFlows from './locales/it/flows.json';
import enMcp from './locales/en/mcp.json';
import itMcp from './locales/it/mcp.json';
import enSkills from './locales/en/skills.json';
import itSkills from './locales/it/skills.json';
import enUsers from './locales/en/users.json';
import itUsers from './locales/it/users.json';
import enTeams from './locales/en/teams.json';
import itTeams from './locales/it/teams.json';
import enDatasources from './locales/en/datasources.json';
import itDatasources from './locales/it/datasources.json';
import enFeedback from './locales/en/feedback.json';
import itFeedback from './locales/it/feedback.json';
import enAutomations from './locales/en/automations.json';
import itAutomations from './locales/it/automations.json';
import enAudit from './locales/en/audit.json';
import itAudit from './locales/it/audit.json';
import enActivity from './locales/en/activity.json';
import itActivity from './locales/it/activity.json';
import enAuth from './locales/en/auth.json';
import itAuth from './locales/it/auth.json';
import enProjects from './locales/en/projects.json';
import itProjects from './locales/it/projects.json';
import enFiles from './locales/en/files.json';
import itFiles from './locales/it/files.json';
import enNotifications from './locales/en/notifications.json';
import itNotifications from './locales/it/notifications.json';
import enBackup from './locales/en/backup.json';
import itBackup from './locales/it/backup.json';

export const SUPPORTED_LANGUAGES = ['en', 'it'] as const;
export type AppLanguage = (typeof SUPPORTED_LANGUAGES)[number];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { common: enCommon, settings: enSettings, tools: enTools, agents: enAgents, chat: enChat, flows: enFlows, mcp: enMcp, skills: enSkills, users: enUsers, teams: enTeams, datasources: enDatasources, feedback: enFeedback, automations: enAutomations, audit: enAudit, activity: enActivity, auth: enAuth, projects: enProjects, files: enFiles, notifications: enNotifications, backup: enBackup },
      it: { common: itCommon, settings: itSettings, tools: itTools, agents: itAgents, chat: itChat, flows: itFlows, mcp: itMcp, skills: itSkills, users: itUsers, teams: itTeams, datasources: itDatasources, feedback: itFeedback, automations: itAutomations, audit: itAudit, activity: itActivity, auth: itAuth, projects: itProjects, files: itFiles, notifications: itNotifications, backup: itBackup },
    },
    fallbackLng: 'en',
    supportedLngs: SUPPORTED_LANGUAGES as unknown as string[],
    nonExplicitSupportedLngs: true, // it-IT → it
    defaultNS: 'common',
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'language',
      caches: ['localStorage'],
    },
    interpolation: { escapeValue: false }, // React already escapes
    returnNull: false,
  });

/** Applies and locally persists the chosen language (user or auto-detect). */
export function applyUserLanguage(lang: string | null | undefined): void {
  if (lang && (SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) {
    if (i18n.language !== lang) i18n.changeLanguage(lang);
  }
}

export default i18n;
