import type { Env } from "../../worker-configuration";
import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";

const ADMIN_API_VERSION = "2025-10";

export async function loadOfflineSession(
  env: Env,
  shopDomain: string,
): Promise<{ accessToken: string } | null> {
  const storage = new KVSessionStorage(env.SESSIONS);
  const offlineId = `offline_${shopDomain}`;
  const session = await storage.loadSession(offlineId);
  if (!session?.accessToken) return null;
  return { accessToken: session.accessToken };
}

export async function adminGraphql<T = unknown>(
  env: Env,
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ data?: T; errors?: unknown }> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/${ADMIN_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  return (await res.json()) as { data?: T; errors?: unknown };
}
