/** Shared state handed to every route module's register(). Mirrors RepoYeti's src/http/deps.ts. */
export interface Deps {
  /** Called by POST /api/shutdown and the origin process's own signal handlers. */
  requestShutdown: () => void;
}
