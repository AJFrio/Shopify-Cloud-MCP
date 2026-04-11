import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useEffect, useRef } from "react";

import { authenticateAdmin } from "../shopify.server";
import {
  insertAgent,
  listAgents,
  revokeAgent,
  rowPermissions,
  updateAgentPermissions,
} from "../lib/agents.server";
import { hashAgentToken, randomAgentToken } from "../lib/crypto.server";
import {
  PERMISSION_GROUPS,
  type PermissionGroup,
  defaultPermissions,
} from "../lib/permissions";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  const { session } = await authenticateAdmin(
    request,
    context.cloudflare.env,
  );
  const agents = await listAgents(
    context.cloudflare.env.DB,
    session.shop,
  ).then((rows) =>
    rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      revoked: r.revoked_at != null,
      permissions: rowPermissions(r),
    })),
  );

  const mcpUrl = new URL("/mcp", context.cloudflare.env.SHOPIFY_APP_URL).href;

  return { shop: session.shop, agents, mcpUrl };
};

export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { session } = await authenticateAdmin(
    request,
    context.cloudflare.env,
  );
  const shop = session.shop;
  const db = context.cloudflare.env.DB;
  const pepper = context.cloudflare.env.TOKEN_PEPPER || "dev-pepper";
  const form = await request.formData();
  const intent = String(form.get("intent") || "");

  if (intent === "create") {
    const label = String(form.get("label") || "").trim() || null;
    const raw = randomAgentToken();
    const tokenHash = await hashAgentToken(raw, pepper);
    const id = crypto.randomUUID();
    await insertAgent(db, {
      id,
      shopDomain: shop,
      tokenHash,
      label,
      permissions: defaultPermissions(),
    });
    return {
      ok: true as const,
      intent: "create" as const,
      rawToken: raw,
      agentId: id,
      label,
    };
  }

  if (intent === "revoke") {
    const id = String(form.get("id") || "");
    await revokeAgent(db, shop, id);
    return { ok: true as const, intent: "revoke" as const };
  }

  if (intent === "update_permissions") {
    const id = String(form.get("id") || "");
    const next: Record<PermissionGroup, boolean> = defaultPermissions();
    for (const g of PERMISSION_GROUPS) {
      next[g] = form.get(`perm_${g}`) === "on";
    }
    await updateAgentPermissions(db, shop, id, next);
    return { ok: true as const, intent: "update_permissions" as const };
  }

  return { ok: false as const, error: "Unknown intent" };
};

export default function AgentsIndex() {
  const { agents, mcpUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const tokenAnchor = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (actionData?.ok && actionData.intent === "create" && actionData.rawToken) {
      tokenAnchor.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [actionData]);

  return (
    <s-page heading="MCP agents">
      <div ref={tokenAnchor} />
      <s-section heading="Connect external agents">
        <s-paragraph>
          Point your MCP client at the URL below. Each agent token must be sent
          as{" "}
          <code>Authorization: Bearer &lt;token&gt;</code> on every request
          (including the MCP initialize handshake).
        </s-paragraph>
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <s-text>
            <strong>MCP endpoint</strong>
          </s-text>
          <pre style={{ margin: "8px 0 0", wordBreak: "break-all" }}>{mcpUrl}</pre>
        </s-box>
      </s-section>

      {actionData?.ok && actionData.intent === "create" && actionData.rawToken ? (
        <s-section heading="New agent token (copy now)">
          <s-banner tone="warning" heading="This token is shown only once">
            Store it in your agent or secret manager. Revoke the agent if it is
            exposed.
          </s-banner>
          <pre
            style={{
              marginTop: 12,
              padding: 12,
              background: "#111",
              color: "#eee",
              borderRadius: 8,
              overflow: "auto",
            }}
          >
            {actionData.rawToken}
          </pre>
        </s-section>
      ) : null}

      <s-section heading="Create agent">
        <Form method="post">
          <input type="hidden" name="intent" value="create" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="label"
              label="Label (optional)"
              placeholder="Cursor production"
            />
            <s-button type="submit" variant="primary">
              Generate token
            </s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Existing agents">
        {agents.length === 0 ? (
          <s-paragraph>No agents yet. Create one to get a token.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="large">
            {agents.map((agent) => (
              <s-box
                key={agent.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
              >
                <s-stack direction="block" gap="base">
                  <s-stack direction="inline" gap="base">
                    <s-text>
                      <strong>{agent.label || "Unnamed agent"}</strong>
                    </s-text>
                    {agent.revoked ? (
                      <s-badge tone="critical">Revoked</s-badge>
                    ) : (
                      <s-badge tone="success">Active</s-badge>
                    )}
                  </s-stack>
                  <s-text color="subdued">
                    Created {new Date(agent.createdAt * 1000).toLocaleString()}
                  </s-text>

                  {!agent.revoked ? (
                    <>
                      <s-heading>Permissions</s-heading>
                      <Form method="post">
                        <input type="hidden" name="intent" value="update_permissions" />
                        <input type="hidden" name="id" value={agent.id} />
                        <s-stack direction="block" gap="small">
                          {PERMISSION_GROUPS.map((g) => (
                            <label key={g} style={{ display: "flex", gap: 8 }}>
                              <input
                                type="checkbox"
                                name={`perm_${g}`}
                                defaultChecked={agent.permissions[g]}
                              />
                              <span>{g}</span>
                            </label>
                          ))}
                        </s-stack>
                        <div style={{ marginTop: 8 }}>
                          <s-button type="submit" variant="secondary">
                            Save permissions
                          </s-button>
                        </div>
                      </Form>

                      <Form method="post" style={{ marginTop: 12 }}>
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="id" value={agent.id} />
                        <s-button type="submit" tone="critical" variant="tertiary">
                          Revoke token
                        </s-button>
                      </Form>
                    </>
                  ) : null}
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="Notes">
        <s-paragraph>
          Analytics tools are read-only (ShopifyQL). Optional Shopify scopes such
          as <code>read_all_orders</code> or Shopify Payments payouts may require
          Partner approval before data is returned.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
