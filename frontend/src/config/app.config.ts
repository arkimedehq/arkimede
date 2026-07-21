/**
 * Application branding configuration.
 * Set VITE_APP_NAME in the .env file to customize the name.
 */
export const APP_NAME: string =
  (import.meta as any).env?.VITE_APP_NAME ?? 'Arkimede';
