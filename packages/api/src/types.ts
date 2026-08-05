import type { AuthContext } from "./providers";
import type { AgentAuthContext } from "./middleware/agent-auth";

export type ApiEnv = {
  Variables: {
    auth: AuthContext;
    /** Set by `middleware/agent-auth` on the webhook pull-queue routes only. */
    agent: AgentAuthContext;
  };
};
