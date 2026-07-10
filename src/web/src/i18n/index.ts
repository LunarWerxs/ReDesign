import { createAppI18n } from '@/lib/i18n-core';
import en from './locales/en';

// vue-i18n bootstrap for Reimagine. The persistence (under `reimagine.locale`),
// `<html lang>` sync and supported-locale set live in the shared kit factory
// (`@/lib/i18n-core`) so they match RepoYeti and DevWebUI. English-only today; add a
// `locales/<code>.ts` catalog and register it here to introduce another language.
export const { i18n, t } = createAppI18n({ en }, 'reimagine.locale');
