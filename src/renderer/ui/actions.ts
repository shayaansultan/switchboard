// Things a row can ask the app to do that are not calls on the bridge: open
// the setup dialog for a profile (or for a new one of a vendor), start a new
// proxy bucket, or open an account's usage resets.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ProfileView, ResetTarget, Vendor } from '../lib';

export type Actions = {
  openSetup(target?: ProfileView, vendor?: Vendor): void;
  newBucket(): void;
  openResets(target: ResetTarget): void;
};
export const ActionsCtx = createContext<Actions>({ openSetup() {}, newBucket() {}, openResets() {} });
export const useActions = (): Actions => useContext(ActionsCtx);
