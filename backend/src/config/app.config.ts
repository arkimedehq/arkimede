/**
 * Application branding configuration.
 * Change APP_NAME in the .env to rebrand everything without touching the code.
 */
export const APP_NAME = process.env.APP_NAME ?? 'Arkimede';
export const APP_NAME_SLUG = APP_NAME.toLowerCase().replace(/\s+/g, '-');
export const APP_DB_DEFAULT  = APP_NAME_SLUG.replace(/-/g, '_') + '_db';
