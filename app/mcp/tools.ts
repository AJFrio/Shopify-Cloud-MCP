import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env } from "../../worker-configuration";
import { assertPermission } from "../lib/permissions";
import { adminGraphql, loadOfflineSession } from "../lib/shopify-admin.server";
import type { ShopMcpProps } from "./shop-mcp";

export type McpToolHost = {
  getEnv(): Env;
  getProps(): ShopMcpProps;
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function requireProps(host: McpToolHost) {
  const p = host.getProps();
  if (!p?.shopDomain || !p.permissions) {
    throw new Error("Agent is missing authorization context");
  }
  return p;
}

async function gql<T>(
  host: McpToolHost,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const { shopDomain } = requireProps(host);
  const session = await loadOfflineSession(host.getEnv(), shopDomain);
  if (!session) {
    throw new Error("Shop session not found. Reinstall the app on this store.");
  }
  const res = await adminGraphql<T>(
    host.getEnv(),
    shopDomain,
    session.accessToken,
    query,
    variables,
  );
  if (res.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(res.errors)}`);
  }
  return res.data as T;
}

const ANALYTICS_PRESETS: Record<
  "sales_last_7d" | "sales_last_30d",
  string
> = {
  sales_last_7d:
    "FROM sales SHOW total_sales, orders, average_order_value GROUP BY day SINCE -7d UNTIL today ORDER BY day",
  sales_last_30d:
    "FROM sales SHOW total_sales, orders GROUP BY day SINCE -30d UNTIL today ORDER BY day",
};

export function registerShopifyTools(
  server: McpServer,
  host: McpToolHost,
): void {
  server.registerTool(
    "shop_info",
    {
      description: "Return the authorized shop domain for this token.",
      inputSchema: z.object({}),
    },
    async () => {
      const p = requireProps(host);
      return jsonResult({ shop: p.shopDomain });
    },
  );

  server.registerTool(
    "products_list",
    {
      description: "List products (cursor-based)",
      inputSchema: {
        first: z.number().int().min(1).max(50).optional(),
        after: z.string().nullable().optional(),
      },
    },
    async ({ first = 20, after }) => {
      assertPermission(requireProps(host).permissions, "products");
      const data = await gql<{
        products: { edges: { node: unknown }[]; pageInfo: unknown };
      }>(
        host,
        `#graphql
        query Products($first: Int!, $after: String) {
          products(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { id title handle status totalInventory } }
          }
        }`,
        { first, after: after ?? null },
      );
      return jsonResult(data.products);
    },
  );

  server.registerTool(
    "products_create",
    {
      description: "Create a product with a title",
      inputSchema: { title: z.string().min(1) },
    },
    async ({ title }) => {
      assertPermission(requireProps(host).permissions, "products");
      const data = await gql<{ productCreate: { product?: unknown; userErrors: unknown[] } }>(
        host,
        `#graphql
        mutation CreateProduct($product: ProductCreateInput!) {
          productCreate(product: $product) {
            product { id title handle status }
            userErrors { field message }
          }
        }`,
        { product: { title } },
      );
      return jsonResult(data.productCreate);
    },
  );

  server.registerTool(
    "products_update",
    {
      description: "Update a product by ID (partial fields)",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.enum(["ACTIVE", "ARCHIVED", "DRAFT"]).optional(),
        tags: z.array(z.string()).optional(),
        collections: z
          .object({
            add: z.array(z.string()).optional(),
            remove: z.array(z.string()).optional(),
          })
          .optional(),
        variants: z
          .object({
            create: z
              .array(
                z.object({
                  optionValues: z
                    .array(
                      z.object({
                        optionName: z.string(),
                        name: z.string(),
                      }),
                    )
                    .optional(),
                  price: z.string().optional(),
                  inventoryLevels: z
                    .array(
                      z.object({
                        locationId: z.string(),
                        quantity: z.number().int(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
            update: z
              .array(
                z.object({
                  id: z.string(),
                  price: z.string().optional(),
                  inventoryLevels: z
                    .array(
                      z.object({
                        locationId: z.string(),
                        quantity: z.number().int(),
                      }),
                    )
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        metadata: z
          .array(
            z.object({
              namespace: z.string(),
              key: z.string(),
              value: z.string(),
              type: z.string(),
            }),
          )
          .optional(),
      },
    },
    async (input) => {
      assertPermission(requireProps(host).permissions, "products");
      const hasVariantInventory =
        Boolean(
          input.variants?.create?.some(
            (variant: { inventoryLevels?: unknown[] }) =>
              (variant.inventoryLevels?.length ?? 0) > 0,
          ),
        ) ||
        Boolean(
          input.variants?.update?.some(
            (variant: { inventoryLevels?: unknown[] }) =>
              (variant.inventoryLevels?.length ?? 0) > 0,
          ),
        );
      if (
        (input.collections?.add?.length ?? 0) > 0 ||
        (input.collections?.remove?.length ?? 0) > 0
      ) {
        assertPermission(requireProps(host).permissions, "collections");
      }
      if (hasVariantInventory) {
        assertPermission(requireProps(host).permissions, "inventory");
      }
      if (input.metadata !== undefined) {
        assertPermission(requireProps(host).permissions, "metafields");
      }

      const response: Record<string, unknown> = {};
      let didWork = false;

      const product: Record<string, unknown> = { id: input.id };
      if (input.title !== undefined) product.title = input.title;
      if (input.description !== undefined) {
        product.descriptionHtml = input.description;
      }
      if (input.status !== undefined) product.status = input.status;
      if (input.tags !== undefined) product.tags = input.tags;

      if (Object.keys(product).length > 1) {
        didWork = true;
        const data = await gql<{
          productUpdate: { product?: unknown; userErrors: unknown[] };
        }>(
          host,
          `#graphql
          mutation UpdateProduct($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              product { id title status tags descriptionHtml }
              userErrors { field message }
            }
          }`,
          { product },
        );
        response.productUpdate = data.productUpdate;
      }

      const collectionsToAdd = input.collections?.add ?? [];
      if (collectionsToAdd.length > 0) {
        didWork = true;
        const addResults = [];
        for (const collectionId of collectionsToAdd) {
          const data = await gql<{
            collectionAddProducts: { userErrors: unknown[] };
          }>(
            host,
            `#graphql
            mutation AddProductToCollection($id: ID!, $productIds: [ID!]!) {
              collectionAddProducts(id: $id, productIds: $productIds) {
                userErrors { field message }
              }
            }`,
            { id: collectionId, productIds: [input.id] },
          );
          addResults.push({ collectionId, ...data.collectionAddProducts });
        }
        response.collectionsAdded = addResults;
      }

      const collectionsToRemove = input.collections?.remove ?? [];
      if (collectionsToRemove.length > 0) {
        didWork = true;
        const removeResults = [];
        for (const collectionId of collectionsToRemove) {
          const data = await gql<{
            collectionRemoveProducts: { userErrors: unknown[] };
          }>(
            host,
            `#graphql
            mutation RemoveProductFromCollection($id: ID!, $productIds: [ID!]!) {
              collectionRemoveProducts(id: $id, productIds: $productIds) {
                userErrors { field message }
              }
            }`,
            { id: collectionId, productIds: [input.id] },
          );
          removeResults.push({ collectionId, ...data.collectionRemoveProducts });
        }
        response.collectionsRemoved = removeResults;
      }

      const variantsToCreate = input.variants?.create ?? [];
      if (variantsToCreate.length > 0) {
        didWork = true;
        const variants = variantsToCreate.map(
          (variant: {
            optionValues?: { optionName: string; name: string }[];
            price?: string;
            inventoryLevels?: { locationId: string; quantity: number }[];
          }) => {
            const payload: Record<string, unknown> = {};
            if (variant.optionValues !== undefined) {
              payload.optionValues = variant.optionValues;
            }
            if (variant.price !== undefined) payload.price = variant.price;
            const inventoryLevels = variant.inventoryLevels ?? [];
            if (inventoryLevels.length > 0) {
              payload.inventoryQuantities = inventoryLevels.map(
                (inventoryLevel) => ({
                  locationId: inventoryLevel.locationId,
                  availableQuantity: Math.max(0, inventoryLevel.quantity),
                }),
              );
            }
            return payload;
          },
        );
        const data = await gql<{
          productVariantsBulkCreate: {
            productVariants?: unknown[];
            userErrors: unknown[];
          };
        }>(
          host,
          `#graphql
          mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkCreate(productId: $productId, variants: $variants) {
              productVariants { id price inventoryItem { id } }
              userErrors { field message }
            }
          }`,
          { productId: input.id, variants },
        );
        response.variantsCreated = data.productVariantsBulkCreate;
      }

      const variantUpdates = input.variants?.update ?? [];
      const variantUpdatesNeedingInventory = variantUpdates.filter(
        (variant: { inventoryLevels?: unknown[] }) =>
          (variant.inventoryLevels?.length ?? 0) > 0,
      );
      const variantPriceUpdates = variantUpdates
        .map((variant: { id: string; price?: string }) => {
          const payload: Record<string, unknown> = { id: variant.id };
          if (variant.price !== undefined) payload.price = variant.price;
          return payload;
        })
        .filter((variant) => Object.keys(variant).length > 1);

      if ((variantPriceUpdates?.length ?? 0) > 0) {
        didWork = true;
        const data = await gql<{
          productVariantsBulkUpdate: {
            productVariants?: unknown[];
            userErrors: unknown[];
          };
        }>(
          host,
          `#graphql
          mutation ProductVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              productVariants { id price inventoryItem { id } }
              userErrors { field message }
            }
          }`,
          { productId: input.id, variants: variantPriceUpdates },
        );
        response.variantsUpdated = data.productVariantsBulkUpdate;
      }

      if (variantUpdatesNeedingInventory.length > 0) {
        didWork = true;
        const variantIds = variantUpdatesNeedingInventory.map(
          (variant: { id: string }) => variant.id,
        );
        const variantsData = await gql<{
          nodes: Array<{ id: string; inventoryItem?: { id: string } } | null>;
        }>(
          host,
          `#graphql
          query VariantInventoryItems($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                inventoryItem { id }
              }
            }
          }`,
          { ids: variantIds },
        );
        const inventoryItemByVariantId = new Map<string, string>();
        for (const node of variantsData.nodes) {
          if (node?.id && node.inventoryItem?.id) {
            inventoryItemByVariantId.set(node.id, node.inventoryItem.id);
          }
        }

        const setQuantities: Array<{
          inventoryItemId: string;
          locationId: string;
          quantity: number;
        }> = [];
        for (const variant of variantUpdatesNeedingInventory) {
          const inventoryItemId = inventoryItemByVariantId.get(variant.id);
          if (!inventoryItemId) continue;
          for (const level of variant.inventoryLevels ?? []) {
            setQuantities.push({
              inventoryItemId,
              locationId: level.locationId,
              quantity: Math.max(0, level.quantity),
            });
          }
        }

        if (setQuantities.length > 0) {
          const data = await gql<{
            inventorySetOnHandQuantities: {
              userErrors: unknown[];
              inventoryAdjustmentGroup?: unknown;
            };
          }>(
            host,
            `#graphql
            mutation SetVariantInventory($input: InventorySetOnHandQuantitiesInput!) {
              inventorySetOnHandQuantities(input: $input) {
                userErrors { field message }
                inventoryAdjustmentGroup { reason changes { name delta } }
              }
            }`,
            {
              input: {
                reason: "correction",
                setQuantities,
              },
            },
          );
          response.variantInventorySet = data.inventorySetOnHandQuantities;
        } else {
          response.variantInventorySet = {
            userErrors: [
              {
                message:
                  "No inventory items could be resolved for the provided variant IDs.",
              },
            ],
          };
        }
      }

      if (input.metadata !== undefined) {
        didWork = true;
        const data = await gql<{
          metafieldsSet: { metafields?: unknown[]; userErrors: unknown[] };
        }>(
          host,
          `#graphql
          mutation SetProductMetadata($m: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $m) {
              metafields { id namespace key value type }
              userErrors { field message }
            }
          }`,
          {
            m: input.metadata.map(
              (metafield: {
                namespace: string;
                key: string;
                value: string;
                type: string;
              }) => ({
                ownerId: input.id,
                namespace: metafield.namespace,
                key: metafield.key,
                value: metafield.value,
                type: metafield.type,
              }),
            ),
          },
        );
        response.metadata = data.metafieldsSet;
      }

      if (!didWork) {
        return jsonResult({
          id: input.id,
          message: "No patch fields were provided; nothing changed.",
        });
      }

      return jsonResult(response);
    },
  );

  server.registerTool(
    "collections_list",
    {
      description: "List collections",
      inputSchema: { first: z.number().int().min(1).max(50).optional() },
    },
    async ({ first = 20 }) => {
      assertPermission(requireProps(host).permissions, "collections");
      const data = await gql<{
        collections: { edges: { node: unknown }[] };
      }>(
        host,
        `#graphql
        query Collections($first: Int!) {
          collections(first: $first) {
            edges { node { id title handle updatedAt } }
          }
        }`,
        { first },
      );
      return jsonResult(data.collections);
    },
  );

  server.registerTool(
    "collections_create",
    {
      description: "Create a custom collection",
      inputSchema: { title: z.string().min(1) },
    },
    async ({ title }) => {
      assertPermission(requireProps(host).permissions, "collections");
      const data = await gql<{
        collectionCreate: { collection?: unknown; userErrors: unknown[] };
      }>(
        host,
        `#graphql
        mutation CreateCollection($input: CollectionInput!) {
          collectionCreate(input: $input) {
            collection { id title handle }
            userErrors { field message }
          }
        }`,
        { input: { title } },
      );
      return jsonResult(data.collectionCreate);
    },
  );

  server.registerTool(
    "inventory_set_on_hand",
    {
      description: "Set on-hand available quantity for an inventory item at a location",
      inputSchema: {
        inventoryItemId: z.string(),
        locationId: z.string(),
        quantity: z.number().int(),
      },
    },
    async ({ inventoryItemId, locationId, quantity }) => {
      assertPermission(requireProps(host).permissions, "inventory");
      const data = await gql<{
        inventorySetOnHandQuantities: {
          userErrors: unknown[];
          inventoryAdjustmentGroup?: unknown;
        };
      }>(
        host,
        `#graphql
        mutation SetOnHand($input: InventorySetOnHandQuantitiesInput!) {
          inventorySetOnHandQuantities(input: $input) {
            userErrors { message field }
            inventoryAdjustmentGroup { reason changes { name delta } }
          }
        }`,
        {
          input: {
            reason: "correction",
            setQuantities: [
              { inventoryItemId, locationId, quantity: Math.max(0, quantity) },
            ],
          },
        },
      );
      return jsonResult(data.inventorySetOnHandQuantities);
    },
  );

  server.registerTool(
    "customers_search",
    {
      description: "Search customers by query string",
      inputSchema: {
        query: z.string().min(1),
        first: z.number().int().max(50).optional(),
      },
    },
    async ({ query, first = 20 }) => {
      assertPermission(requireProps(host).permissions, "customers");
      const data = await gql<{ customers: { edges: { node: unknown }[] } }>(
        host,
        `#graphql
        query Customers($q: String!, $first: Int!) {
          customers(first: $first, query: $q) {
            edges { node { id displayName email defaultPhoneNumber { phoneNumber } } }
          }
        }`,
        { q: query, first },
      );
      return jsonResult(data.customers);
    },
  );

  server.registerTool(
    "customers_update",
    {
      description: "Update a customer note or tags",
      inputSchema: {
        id: z.string(),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async (input) => {
      assertPermission(requireProps(host).permissions, "customers");
      const customer: Record<string, unknown> = { id: input.id };
      if (input.note !== undefined) customer.note = input.note;
      if (input.tags) customer.tags = input.tags;
      const data = await gql<{ customerUpdate: { customer?: unknown; userErrors: unknown[] } }>(
        host,
        `#graphql
        mutation UpdateCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) {
            customer { id note tags }
            userErrors { field message }
          }
        }`,
        { input: customer },
      );
      return jsonResult(data.customerUpdate);
    },
  );

  server.registerTool(
    "orders_list",
    {
      description: "List recent orders",
      inputSchema: { first: z.number().int().min(1).max(50).optional() },
    },
    async ({ first = 20 }) => {
      assertPermission(requireProps(host).permissions, "orders");
      const data = await gql<{ orders: { edges: { node: unknown }[] } }>(
        host,
        `#graphql
        query Orders($first: Int!) {
          orders(first: $first, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id name createdAt displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
              }
            }
          }
        }`,
        { first },
      );
      return jsonResult(data.orders);
    },
  );

  server.registerTool(
    "orders_update_tags_note",
    {
      description: "Update order tags and/or note",
      inputSchema: {
        id: z.string(),
        tags: z.array(z.string()).optional(),
        note: z.string().optional(),
      },
    },
    async (input) => {
      assertPermission(requireProps(host).permissions, "orders");
      const data = await gql<{ orderUpdate: { order?: unknown; userErrors: unknown[] } }>(
        host,
        `#graphql
        mutation OrderUpdate($input: OrderInput!) {
          orderUpdate(input: $input) {
            order { id name tags note }
            userErrors { field message }
          }
        }`,
        {
          input: {
            id: input.id,
            ...(input.tags ? { tags: input.tags } : {}),
            ...(input.note !== undefined ? { note: input.note } : {}),
          },
        },
      );
      return jsonResult(data.orderUpdate);
    },
  );

  server.registerTool(
    "metafields_set",
    {
      description: "Set metafields on a resource by owner GID",
      inputSchema: {
        ownerId: z.string(),
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      },
    },
    async ({ ownerId, namespace, key, value, type }) => {
      assertPermission(requireProps(host).permissions, "metafields");
      const data = await gql<{
        metafieldsSet: { metafields?: unknown[]; userErrors: unknown[] };
      }>(
        host,
        `#graphql
        mutation SetMetafields($m: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $m) {
            metafields { id namespace key value type }
            userErrors { field message }
          }
        }`,
        {
          m: [
            {
              ownerId,
              namespace,
              key,
              value,
              type,
            },
          ],
        },
      );
      return jsonResult(data.metafieldsSet);
    },
  );

  server.registerTool(
    "metaobjects_list",
    {
      description: "List metaobjects for a type",
      inputSchema: {
        type: z.string(),
        first: z.number().int().max(50).optional(),
      },
    },
    async ({ type, first = 20 }) => {
      assertPermission(requireProps(host).permissions, "metaobjects");
      const data = await gql<{ metaobjects: { nodes: unknown[] } }>(
        host,
        `#graphql
        query Metaobjects($type: String!, $first: Int!) {
          metaobjects(type: $type, first: $first) {
            nodes { id handle type displayName fields { key value } }
          }
        }`,
        { type, first },
      );
      return jsonResult(data.metaobjects);
    },
  );

  server.registerTool(
    "metaobjects_create",
    {
      description:
        "Create a metaobject (fails if handle already exists for the type)",
      inputSchema: {
        type: z.string(),
        handle: z.string(),
        fields: z.array(z.object({ key: z.string(), value: z.string() })),
      },
    },
    async ({ type, handle, fields }) => {
      assertPermission(requireProps(host).permissions, "metaobjects");
      const data = await gql<{
        metaobjectCreate: { metaobject?: unknown; userErrors: unknown[] };
      }>(
        host,
        `#graphql
        mutation CreateMetaobject($metaobject: MetaobjectCreateInput!) {
          metaobjectCreate(metaobject: $metaobject) {
            metaobject { id handle type }
            userErrors { field message }
          }
        }`,
        {
          metaobject: {
            type,
            handle,
            fields,
          },
        },
      );
      return jsonResult(data.metaobjectCreate);
    },
  );

  server.registerTool(
    "metaobject_definitions_list",
    {
      description: "List metaobject definitions",
      inputSchema: { first: z.number().int().max(50).optional() },
    },
    async ({ first = 50 }) => {
      assertPermission(
        requireProps(host).permissions,
        "metaobject_definitions",
      );
      const data = await gql<{
        metaobjectDefinitions: { nodes: unknown[] };
      }>(
        host,
        `#graphql
        query MetaDefs($first: Int!) {
          metaobjectDefinitions(first: $first) {
            nodes { id name type displayName }
          }
        }`,
        { first },
      );
      return jsonResult(data.metaobjectDefinitions);
    },
  );

  server.registerTool(
    "financials_order_transactions",
    {
      description: "Fetch transactions for an order",
      inputSchema: { orderId: z.string() },
    },
    async ({ orderId }) => {
      assertPermission(requireProps(host).permissions, "financials");
      const data = await gql<{ order: { transactions: unknown[] } | null }>(
        host,
        `#graphql
        query OrderTx($id: ID!) {
          order(id: $id) {
            id name
            transactions(first: 50) {
              id kind status test gateway
              amountSet { shopMoney { amount currencyCode } }
            }
          }
        }`,
        { id: orderId },
      );
      return jsonResult(data.order);
    },
  );

  server.registerTool(
    "financials_shopify_payments_payouts",
    {
      description:
        "List Shopify Payments payouts (requires read_shopify_payments_payouts)",
      inputSchema: { first: z.number().int().max(25).optional() },
    },
    async ({ first = 10 }) => {
      assertPermission(requireProps(host).permissions, "financials");
      const data = await gql<{
        shopifyPaymentsAccount: { payouts: { nodes: unknown[] } } | null;
      }>(
        host,
        `#graphql
        query Payouts($first: Int!) {
          shopifyPaymentsAccount {
            payouts(first: $first) {
              nodes { id status issuedAt net { amount currencyCode } }
            }
          }
        }`,
        { first },
      );
      return jsonResult(data.shopifyPaymentsAccount);
    },
  );

  server.registerTool(
    "analytics_shopifyql",
    {
      description:
        "Run a read-only ShopifyQL analytics preset (sales_last_7d or sales_last_30d)",
      inputSchema: { preset: z.enum(["sales_last_7d", "sales_last_30d"]) },
    },
    async ({ preset }) => {
      assertPermission(requireProps(host).permissions, "analytics");
      const query = ANALYTICS_PRESETS[preset];
      const data = await gql<{ shopifyqlQuery: unknown }>(
        host,
        `#graphql
        query Q($q: String!) {
          shopifyqlQuery(query: $q) {
            tableData { columns { name } rows }
            parseErrors
          }
        }`,
        { q: query },
      );
      return jsonResult(data.shopifyqlQuery);
    },
  );
}
