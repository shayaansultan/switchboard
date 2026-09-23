// Things a row can ask the app to do that are not calls on the bridge: open
// the setup dialog for a profile (or for a new one of a vendor), or start a
// new proxy bucket.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ProfileView, Vendor } from '../lib';

export type Actions = { openSetup(target?: ProfileView, vendor?: Vendor): void; newBucket(): void };
export const ActionsCtx = createContext<Actions>({ openSetup() {}, newBucket() {} });
export const useActions = (): Actions => useContext(ActionsCtx);
