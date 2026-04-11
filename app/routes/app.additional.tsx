import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticateAdmin } from "../shopify.server";

export const loader = async ({ request, context }: LoaderFunctionArgs) => {
  await authenticateAdmin(request, context.cloudflare.env);
  return null;
};

export default function AdditionalPage() {
  return (
    <s-page heading="Additional page">
      <s-section heading="Multiple pages">
        <s-paragraph>
          The app template comes with an additional page which demonstrates how
          to create multiple pages within app navigation using{" "}
          <s-link
            href="https://shopify.dev/docs/apps/tools/app-bridge"
            target="_blank"
          >
            App Bridge
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
