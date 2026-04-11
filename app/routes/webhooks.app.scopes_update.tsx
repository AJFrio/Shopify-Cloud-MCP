import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook, sessionStorageForEnv } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticateWebhook(
    request,
    context.cloudflare.env,
  );
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = payload.current as string[];
  if (session) {
    const storage = sessionStorageForEnv(context.cloudflare.env);
    const loaded = await storage.loadSession(session.id);
    if (loaded) {
      loaded.scope = current.toString();
      await storage.storeSession(loaded);
    }
  }
  return new Response();
};
