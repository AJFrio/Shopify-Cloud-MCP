import { z } from "zod";

export const PERMISSION_GROUPS = [
  "products",
  "collections",
  "inventory",
  "customers",
  "orders",
  "metafields",
  "metaobjects",
  "metaobject_definitions",
  "financials",
  "analytics",
] as const;

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export const defaultPermissions = (): Record<PermissionGroup, boolean> =>
  Object.fromEntries(PERMISSION_GROUPS.map((k) => [k, true])) as Record<
    PermissionGroup,
    boolean
  >;

export const PermissionsSchema = z.record(
  z.enum(PERMISSION_GROUPS),
  z.boolean(),
);

export function parsePermissions(json: string): Record<PermissionGroup, boolean> {
  const parsed = JSON.parse(json) as unknown;
  const result = PermissionsSchema.safeParse(parsed);
  if (result.success) return result.data;
  return defaultPermissions();
}

export function assertPermission(
  perms: Record<PermissionGroup, boolean>,
  group: PermissionGroup,
): void {
  if (!perms[group]) {
    throw new Error(`This agent token does not have permission: ${group}`);
  }
}
