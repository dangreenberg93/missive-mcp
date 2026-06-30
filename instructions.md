Missive is a shared inbox and team collaboration tool for email.

## Safety (non-negotiable)

This MCP is **read + draft only**. There is no send tool. Never attempt to deliver email via the API.

- Use `reply_to_conversation` or `create_draft` to compose drafts only
- A human must review and send from the Missive app
- Before drafting, read the full thread with `get_conversation_timeline`

## Conversations

A conversation is an email thread containing three types of items:
- **Messages**: Actual emails from external contacts
- **Posts**: Internal notes and state changes (assign, close, label) — visible only to team
- **Comments**: Sidebar discussions about the conversation — visible only to team

Use `get_conversation_timeline` to fetch all three types interleaved chronologically, matching how Missive displays them. Treat posts and comments as binding context before drafting.

## Replying

Use **`reply_to_conversation`** for thread replies. It sets recipients, subject, quoting, and conversation linkage automatically.

Use `create_draft` only for **new** outbound messages (no existing conversation).

## Organization

- **Organizations**: Top-level account containing teams and users
- **Teams**: Groups of users with shared inboxes
- **Shared Labels**: Tags for organizing conversations across the team
- **Contact Books**: Shared address books for the organization

Use `list_organizations` to determine which org context applies before drafting.

## Voyager MCP (cross-connector workflows)

If Claude also has the **Voyager MCP** connector enabled, see the Voyager-specific section in these instructions for order ↔ email playbooks (`voyager_find_order` → `voyager_get_order` → `reply_to_conversation`). Voyager holds order truth; Missive holds thread truth.

## HTML formatting

Use `<br><br>` between paragraphs in draft bodies. Do not wrap content in `<p>`, `<div>`, or style blocks — Missive strips these and renders without spacing.
