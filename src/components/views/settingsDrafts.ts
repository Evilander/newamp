// Which unsaved text on the Settings page survives a save, kept out of the page
// so it can be tested without a DOM.
import type { AppSettings } from '@shared/types';

// Credential fields are typed into the local settings copy and saved by their
// own buttons, so a save of any other setting must not wipe them.
export const CREDENTIAL_FIELDS = ['lastfmApiKey', 'lastfmSharedSecret', 'openaiApiKey', 'openaiModel'] as const;
export type CredentialValues = Pick<AppSettings, (typeof CREDENTIAL_FIELDS)[number]>;

/**
 * The settings the page shows once `saved` has arrived. A credential field that
 * differs from `lastSaved` is an edit in progress and keeps what was typed.
 * `written` is for a save of credential fields themselves: it names the fields
 * that save persisted, with the text each was saved from. Those fields take the
 * saved value, unless something else has been typed into them since the save
 * began, and the fields it did not write are left alone as before.
 */
export function mergeSavedSettings(
  saved: AppSettings,
  shown: AppSettings | null,
  lastSaved: CredentialValues | null,
  written: Partial<CredentialValues> = {},
): AppSettings {
  if (!shown || !lastSaved) return saved;
  const next = { ...saved };
  for (const field of CREDENTIAL_FIELDS) {
    const edited = field in written ? shown[field] !== written[field] : shown[field] !== lastSaved[field];
    if (edited) Object.assign(next, { [field]: shown[field] });
  }
  return next;
}
