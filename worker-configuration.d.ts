export interface Env {
  SESSIONS: KVNamespace;
  DB: D1Database;
  MCP_AGENT: DurableObjectNamespace;
  SHOPIFY_API_KEY: string;
  SHOPIFY_API_SECRET: string;
  SCOPES: string;
  SHOPIFY_APP_URL: string;
  TOKEN_PEPPER: string;
  SHOP_CUSTOM_DOMAIN?: string;
}

declare module "react-router" {
  export interface AppLoadContext {
    cloudflare: {
      env: Env;
      ctx: ExecutionContext;
    };
  }
}
