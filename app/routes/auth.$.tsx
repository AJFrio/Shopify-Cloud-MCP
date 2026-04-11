import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticateAdmin } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await authenticateAdmin(request, context.cloudflare.env);

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
