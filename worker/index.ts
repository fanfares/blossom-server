import { Container } from "@cloudflare/containers";

type Env = {
  CF_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  BLOSSOM_PUBLIC_DOMAIN?: string;
  BLOSSOM_ADMIN_PASSWORD?: string;
  BLOSSOM_APP: DurableObjectNamespace<BlossomAppContainer>;
};

export class BlossomAppContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "10m";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const envVars: Record<string, string> = {
      CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
      BLOSSOM_PUBLIC_DOMAIN: env.BLOSSOM_PUBLIC_DOMAIN ?? "",
      BLOSSOM_ADMIN_PASSWORD: env.BLOSSOM_ADMIN_PASSWORD ?? "",
    };

    // Metadata must live in a persistent remote libSQL database in Cloudflare
    // containers. Local SQLite inside the container is ephemeral across restarts.
    if (env.TURSO_DATABASE_URL) {
      envVars.TURSO_DATABASE_URL = env.TURSO_DATABASE_URL;
    }
    if (env.TURSO_AUTH_TOKEN) {
      envVars.TURSO_AUTH_TOKEN = env.TURSO_AUTH_TOKEN;
    }

    this.envVars = envVars;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Route all requests to one stable container instance.
    const container = env.BLOSSOM_APP.getByName("primary");
    return await container.fetch(request);
  },
};
