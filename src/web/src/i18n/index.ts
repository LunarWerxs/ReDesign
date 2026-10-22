import { createAppI18n } from '@/lib/i18n-core';
import en from './locales/en';

// vue-i18n bootstrap for Reimagine. The persistence (under `reimagine.locale`),
// `<html lang>` sync and supported-locale set live in the shared kit factory
// (`@/lib/i18n-core`) so they match RepoYeti and DevWebUI. English-only today; add a
// `locales/<code>.ts` catalog and register it here to introduce another language.
const app = createAppI18n({ en }, 'reimagine.locale');

// Re-exported as two named consts rather than destructured straight out of the call: a
// destructuring export hides both names from a directory barrel's own export surface, so
// every `import { t } from '@/i18n'` in the app reads as a missing export to anything that
// resolves the barrel statically (it type-checks only because vue-tsc follows the file).
export const i18n = app.i18n;
export const t = app.t;
