# Missive MCP Server

An MCP (Model Context Protocol) server that interfaces with the [Missive API](https://missiveapp.com/docs/developers/rest-api/endpoints), enabling Claude to manage email conversations, contacts, and team collaboration.

## Prerequisites

- Node.js 18+
- Missive account with **Productive plan** (required for API access)
- Missive API token

## Installation

```bash
npm install
npm run build
```

## Modes

The server runs in two modes: **stdio** for local single-user use, and **remote** for hosted multi-user deployments.

### Stdio Mode (Local)

Set the `MISSIVE_API_TOKEN` environment variable:

```bash
export MISSIVE_API_TOKEN="your_api_token_here"
npm start
```

To get your API token: open Missive, go to Settings > API, click "Create a new token".

Add to your Claude Desktop configuration (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "missive": {
      "command": "/path/to/node",
      "args": ["/path/to/missive-mcp/dist/index.js"],
      "env": {
        "MISSIVE_API_TOKEN": "your_api_token_here"
      }
    }
  }
}
```

**Important:** Use the full path to `node` (run `which node` to find it). Claude Desktop has a restricted PATH and may not find node otherwise.

### Remote Mode (Hosted)

Runs an HTTP server with OAuth. Each user provides their own Missive PAT through a browser-based authorization flow.

```bash
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
export BASE_URL="https://missive-mcp.example.com"
npm run remote
```

| Variable | Required | Description |
|---|---|---|
| `ENCRYPTION_KEY` | Yes | 32-byte hex string for AES-256-GCM PAT encryption |
| `BASE_URL` | Yes | Public URL of the server |
| `PORT` | No | HTTP port (default 3000) |
| `MCP_INSTRUCTIONS_PROFILE` | No | `all`, `pbd`, `voyager`, or `base` (default `all`) |

Point MCP clients at `{BASE_URL}/mcp`. The server handles OAuth automatically:

1. Client discovers endpoints via `/.well-known/oauth-authorization-server`
2. Client registers dynamically via `/register`
3. User is redirected to a form to paste their Missive API token
4. Server validates the token, encrypts and stores it, issues OAuth tokens
5. Client uses bearer tokens to call `/mcp`

PATs are encrypted at rest with AES-256-GCM. OAuth tokens expire after 1 hour (refresh tokens last 30 days).

## Tools

### Reference Data

| Tool | Description |
|------|-------------|
| `list_organizations` | List organizations you belong to |
| `list_teams` | List teams (for assignments) |
| `list_users` | List users (for assignments) |
| `list_contact_books` | List contact books (required before creating contacts) |
| `list_shared_labels` | List labels (for filtering and tagging) |

### Conversations

| Tool | Description |
|------|-------------|
| `list_conversations` | List conversations with filters (inbox, assigned, closed, team, label, email, domain) |
| `get_conversation` | Get a single conversation by ID |

### Messages

| Tool | Description |
|------|-------------|
| `get_conversation_timeline` | Get all messages, posts, and comments as a unified chronological timeline |
| `get_message` | Get full message content (with body truncation options) |
| `list_message_attachments` | List attachment metadata on a message |
| `download_attachment` | Download attachment bytes as base64 (for Voyager upload, etc.) |

### Drafts (draft-only — no send)

| Tool | Description |
|------|-------------|
| `reply_to_conversation` | **Preferred for thread replies** — auto-sets recipients, subject, quoting |
| `list_drafts` | List drafts in a conversation |
| `create_draft` | Create a draft for a new outbound message |
| `delete_draft` | Delete an unsent draft |

### Contacts

| Tool | Description |
|------|-------------|
| `list_contacts` | List contacts in a book (with search) |
| `get_contact` | Get a single contact |
| `create_contact` | Create a new contact |
| `update_contact` | Update an existing contact |

### Management

| Tool | Description |
|------|-------------|
| `create_post` | Add a post to a conversation; close, label, assign, or move to team |

## Examples

### Read inbox
```
Use list_conversations with inbox=true to see recent conversations.
```

### Reply to an email
```
1. Use list_conversations to find the conversation
2. Use get_conversation_timeline to see the full thread (messages + team activity)
3. Use reply_to_conversation with the conversation ID — draft only, human sends from Missive
```

### Search for emails from a domain
```
Use list_conversations with domain="example.com"
```

### Assign a conversation
```
1. Use list_users to find the user ID
2. Use list_organizations to get the org ID
3. Use create_post with add_assignees=[user_id]
```

### HTML formatting in drafts
When composing HTML email bodies with `reply_to_conversation` or `create_draft`, use `<br><br>` between paragraphs. Do not wrap content in `<p>`, `<div>`, or style blocks — Missive strips these and renders the content without spacing.

### Outbound message bodies
`get_message` uses `GET /messages/{id}` for full bodies. Outbound messages sent via the API may return 404 on that endpoint — pass `conversation_id` to fall back to the timeline entry (preview only).

## Org-specific instructions

The server loads MCP instructions from:

- `instructions.md` — shared Missive + safety rules
- `instructions-pbd.md` — Pale Blue Dot voice and workflow
- `instructions-voyager.md` — Voyager voice and workflow

Set `MCP_INSTRUCTIONS_PROFILE=all` (default), `pbd`, `voyager`, or `base`.

## Rate Limits

- Missive API rate limits are undocumented; the client handles 429 responses

## Security

- API tokens are validated on startup (stdio) or on authorization (remote)
- Tokens are never logged or included in error messages
- In remote mode, PATs are encrypted at rest with AES-256-GCM
- Email body content is never logged
- Input validation on all tool parameters

## License

MIT
