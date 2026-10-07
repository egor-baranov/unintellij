import { createContext, useContext } from 'react';

/** Only the active group owns application-menu commands for its editor. */
export const WorkspaceApplicationActions = createContext(false);
export const useWorkspaceApplicationActions = () => useContext(WorkspaceApplicationActions);
