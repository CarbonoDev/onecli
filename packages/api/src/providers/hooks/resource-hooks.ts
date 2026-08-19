export interface ResourceHooks {
  beforeCreateAgent(organizationId: string, projectId: string): Promise<void>;
  beforeCreateSecret(organizationId: string): Promise<void>;
  /**
   * Optional — omitted editions get no post-create step (today: none do; OSS
   * wires the project agent-default-connections template here). Kept optional
   * rather than required so an edition implementing `ResourceHooks` outside
   * this package (e.g. cloud, in its own repo) doesn't break the moment this
   * method is added here — it opts in on its own schedule.
   */
  afterCreateAgent?(
    organizationId: string,
    projectId: string,
    agentId: string,
  ): Promise<void>;
}

const defaultResourceHooks: ResourceHooks = {
  beforeCreateAgent: async () => {},
  beforeCreateSecret: async () => {},
};

let _resourceHooks: ResourceHooks = defaultResourceHooks;

export const initResourceHooks = (h: ResourceHooks) => {
  _resourceHooks = h;
};

export const getResourceHooks = (): ResourceHooks => _resourceHooks;
