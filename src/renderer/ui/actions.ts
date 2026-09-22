// Things a row can ask the app to do that are not calls on the bridge:
// open the setup dialog for a profile.

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { ProfileView } from '../lib';

export type Actions = { openSetup(target?: ProfileView): void };
export const ActionsCtx = createContext<Actions>({ openSetup() {} });
export const useActions = (): Actions => useContext(ActionsCtx);
