-- Agent API keys (hashed) and permission flags per shop
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  shop_domain TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  label TEXT,
  permissions_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_agent_tokens_shop ON agent_tokens(shop_domain);
CREATE UNIQUE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);
