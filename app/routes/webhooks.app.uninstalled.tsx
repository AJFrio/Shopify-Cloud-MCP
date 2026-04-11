import type { ActionFunctionArgs } from "react-router";
import { authenticateWebhook, sessionStorageForEnv } from "../shopify.server";

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticateWebhook(
    request,
    context.cloudflare.env,
  );

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    const storage = sessionStorageForEnv(context.cloudflare.env);
    const sessions = await storage.findSessionsByShop(shop);
    if (sessions.length) {
      await storage.deleteSessions(sessions.map((s: { id: string }) => s.id));
    }
  }

  return new Response();
};
