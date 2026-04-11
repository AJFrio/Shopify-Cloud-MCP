import { KVSessionStorage } from "@shopify/shopify-app-session-storage-kv";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import type { Env } from "../worker-configuration";

const cache = new WeakMap<Env, ReturnType<typeof shopifyApp>>();

export function shopifyAppForEnv(env: Env): ReturnType<typeof shopifyApp> {
  let app = cache.get(env);
  if (!app) {
    app = shopifyApp({
      apiKey: env.SHOPIFY_API_KEY,
      apiSecretKey: env.SHOPIFY_API_SECRET || "",
      apiVersion: ApiVersion.October25,
      scopes: env.SCOPES?.split(",").map((s: string) => s.trim()),
      appUrl: env.SHOPIFY_APP_URL || "",
      authPathPrefix: "/auth",
      sessionStorage: new KVSessionStorage(env.SESSIONS),
      distribution: AppDistribution.AppStore,
      future: {
        expiringOfflineAccessTokens: true,
      },
      ...(env.SHOP_CUSTOM_DOMAIN
        ? { customShopDomains: [env.SHOP_CUSTOM_DOMAIN] }
        : {}),
    });
    cache.set(env, app);
  }
  return app;
}

export const apiVersion = ApiVersion.October25;

export function addDocumentResponseHeaders(
  request: Request,
  headers: Headers,
  env: Env,
) {
  shopifyAppForEnv(env).addDocumentResponseHeaders(request, headers);
}

export function authenticateAdmin(request: Request, env: Env) {
  return shopifyAppForEnv(env).authenticate.admin(request);
}

export function authenticateWebhook(request: Request, env: Env) {
  return shopifyAppForEnv(env).authenticate.webhook(request);
}

export function login(request: Request, env: Env) {
  return shopifyAppForEnv(env).login(request);
}

export function sessionStorageForEnv(env: Env) {
  return shopifyAppForEnv(env).sessionStorage;
}
