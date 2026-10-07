import { applicationActionIds, type ApplicationActionId, type ApplicationMenuState } from './contracts';

export interface ApplicationAction {
  enabled?: boolean;
  checked?: boolean;
  allowInModal?: boolean;
  run: () => void | Promise<void>;
}
export type ApplicationActions = Partial<Record<ApplicationActionId, ApplicationAction>>;

/** Application handlers stay in their owning component; only availability and
 * checkmarks cross IPC. Disposed tabs cannot leave invokable closures behind. */
export class ApplicationActionRegistry {
  private owners = new Map<symbol, ApplicationActions>();
  private blocked = false;
  constructor(private changed: () => void) {}

  register(actions: ApplicationActions): () => void {
    const owner = Symbol();
    this.owners.set(owner, actions); this.changed();
    return () => { this.owners.delete(owner); this.changed(); };
  }
  setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked; this.changed();
  }
  private handlers(): ApplicationActions {
    return Object.assign({}, ...this.owners.values());
  }
  state(): ApplicationMenuState {
    const handlers = this.handlers(), state: ApplicationMenuState = {};
    for (const id of applicationActionIds) {
      const action = handlers[id];
      if (action) state[id] = { enabled: action.enabled !== false && (!this.blocked || !!action.allowInModal),
        ...(action.checked === undefined ? {} : { checked: action.checked }) };
    }
    return state;
  }
  async execute(id: ApplicationActionId): Promise<void> {
    const action = this.handlers()[id];
    if (action && action.enabled !== false && (!this.blocked || action.allowInModal)) await action.run();
  }
}
