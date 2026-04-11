import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import type { Env } from "../../worker-configuration";
import type { PermissionGroup } from "../lib/permissions";
import { registerShopifyTools } from "./tools";

export type ShopMcpProps = {
  shopDomain: string;
  tokenId: string;
  permissions: Record<PermissionGroup, boolean>;
};

export class ShopMcp extends McpAgent<Env, Record<string, never>, ShopMcpProps> {
  server = new McpServer({ name: "shopify-cloud-mcp", version: "1.0.0" });

  async init() {
    registerShopifyTools(this.server, {
      getEnv: () => this.env,
      getProps: () => {
        const p = this.props;
        if (!p?.shopDomain) {
          throw new Error("Missing MCP props");
        }
        return p;
      },
    });
  }
}
