import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticateAdmin } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await authenticateAdmin(request, context.cloudflare.env);

  return { apiKey: context.cloudflare.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-stack direction="inline" gap="base" padding="base">
        <s-link href="/app">MCP agents</s-link>
        <s-link href="/app/additional">Additional page</s-link>
      </s-stack>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
