import type { AuthContext } from "./auth/service";

export type AppEnv = {
  Bindings: {
    /** Injected by the Bun listener. Never derive this value from request headers. */
    remoteAddress?: string;
  };
  Variables: {
    auth: AuthContext;
    requestId: string;
  };
};
