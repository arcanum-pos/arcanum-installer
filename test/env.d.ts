import type { Env as WorkerEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      // Tests only: where the fake Cloudflare API runs membership SQL.
      TEST_BACKEND_DB: D1Database;
    }
  }
}
