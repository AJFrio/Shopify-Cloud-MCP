import type { PermissionGroup } from "./permissions";
import { parsePermissions } from "./permissions";

export type AgentTokenRow = {
  id: string;
  shop_domain: string;
  token_hash: string;
  label: string | null;
  permissions_json: string;
  created_at: number;
  revoked_at: number | null;
};

export async function listAgents(
  db: D1Database,
  shopDomain: string,
): Promise<AgentTokenRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, shop_domain, token_hash, label, permissions_json, created_at, revoked_at
       FROM agent_tokens WHERE shop_domain = ? ORDER BY created_at DESC`,
    )
    .bind(shopDomain)
    .all<AgentTokenRow>();
  return results ?? [];
}

export async function getAgentByHash(
  db: D1Database,
  tokenHash: string,
): Promise<AgentTokenRow | null> {
  return await db
    .prepare(
      `SELECT id, shop_domain, token_hash, label, permissions_json, created_at, revoked_at
       FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
    )
    .bind(tokenHash)
    .first<AgentTokenRow>();
}

export async function insertAgent(
  db: D1Database,
  input: {
    id: string;
    shopDomain: string;
    tokenHash: string;
    label: string | null;
    permissions: Record<PermissionGroup, boolean>;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_tokens (id, shop_domain, token_hash, label, permissions_json, created_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())`,
    )
    .bind(
      input.id,
      input.shopDomain,
      input.tokenHash,
      input.label,
      JSON.stringify(input.permissions),
    )
    .run();
}

export async function revokeAgent(
  db: D1Database,
  shopDomain: string,
  id: string,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE agent_tokens SET revoked_at = unixepoch()
       WHERE id = ? AND shop_domain = ? AND revoked_at IS NULL`,
    )
    .bind(id, shopDomain)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function updateAgentPermissions(
  db: D1Database,
  shopDomain: string,
  id: string,
  permissions: Record<PermissionGroup, boolean>,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE agent_tokens SET permissions_json = ?
       WHERE id = ? AND shop_domain = ? AND revoked_at IS NULL`,
    )
    .bind(JSON.stringify(permissions), id, shopDomain)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export function rowPermissions(row: AgentTokenRow): Record<
  PermissionGroup,
  boolean
> {
  return parsePermissions(row.permissions_json);
}
