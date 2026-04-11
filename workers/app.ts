import type { Env } from "../worker-configuration";
import { createRequestHandler } from "react-router";
import { getAgentByHash } from "../app/lib/agents.server";
import { hashAgentToken } from "../app/lib/crypto.server";
import { parsePermissions } from "../app/lib/permissions";
import { ShopMcp } from "../app/mcp/shop-mcp";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

const mcpHandler = ShopMcp.serve("/mcp", { binding: "MCP_AGENT" });

type CFContext = ExecutionContext & {
  props?: import("../app/mcp/shop-mcp").ShopMcpProps;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const auth = request.headers.get("Authorization");
      if (!auth?.startsWith("Bearer ")) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Missing Bearer token" },
            id: null,
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      const raw = auth.slice(7).trim();
      const pepper = env.TOKEN_PEPPER || "dev-pepper";
      const hash = await hashAgentToken(raw, pepper);
      const row = await getAgentByHash(env.DB, hash);
      if (!row) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32001, message: "Invalid or revoked agent token" },
            id: null,
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      (ctx as CFContext).props = {
        shopDomain: row.shop_domain,
        tokenId: row.id,
        permissions: parsePermissions(row.permissions_json),
      };
      return mcpHandler.fetch(request, env, ctx);
    }

    return requestHandler(request, {
      cloudflare: { env, ctx },
    });
  },
} satisfies ExportedHandler<Env>;

export { ShopMcp };
