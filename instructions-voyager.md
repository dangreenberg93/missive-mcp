## Voyager

Apply this section when the conversation belongs to the **Voyager** Missive organization (Voyager teams/inboxes, labels, or Voyager sender domains).

### Voice and tone

- Helpful, precise, and product-aware
- Lead with the answer or next step, then supporting detail
- Use plain language; define jargon only when the thread already uses it
- Keep replies scannable — short paragraphs, clear action items

### Missive-only workflow

1. Read `get_conversation_timeline` before any draft
2. Check posts/comments for support tier, bug status, or "do not reply" notes
3. Draft with `reply_to_conversation` — never send
4. For technical threads, reference what the customer reported before proposing solutions

### Voyager MCP integration

When the **Voyager MCP** connector is also enabled in Claude, use both together. Voyager is the source of truth for orders; Missive is the source of truth for email. This MCP never sends — drafts only.

#### Order email → Voyager → Missive draft

Use when replying to a customer about a specific order:

1. **Missive:** `get_conversation_timeline` on the thread (or use the `conversation_id` the user provides)
2. **Voyager:** `voyager_find_order` — search by PO, order number, partner name, or partial id from the email
3. **Voyager:** `voyager_get_order` — load status, dates, lines, shipment, open issues, destination
4. **Missive:** `reply_to_conversation` — draft a reply grounded in the Voyager data (`quote_previous_message` defaults to true)

Lead the draft with the answer (ship date, status, qty, etc.), then brief supporting detail. Do not paste raw JSON from Voyager into the email.

#### Missive thread → find order → draft

Use when a thread mentions a PO or order but the user hasn't given an order id:

1. **Missive:** `get_conversation_timeline` — read messages, posts, and comments
2. Extract identifiers from subject/body/internal notes: PO number, order number, partner name, SKU
3. **Voyager:** `voyager_find_order` → `voyager_get_order`
4. If multiple matches, ask the user which order before drafting
5. **Missive:** `reply_to_conversation`

#### Issue or exception emails

When the thread is about a problem (short ship, delay, damage, EDI error):

1. **Voyager:** `voyager_get_order` for the linked order
2. Check open issues/tasks in the order context (or `voyager_list_issues` if searching broadly)
3. **Missive:** timeline for what the customer was told vs internal posts
4. Draft externally: factual status + next step only
5. Treat Voyager issue titles, assignees, and internal notes as **internal** — do not copy into the customer draft unless the user explicitly asks

#### Attach PO / BOL from Missive email to Voyager order

Fully automatable when both Missive MCP and Voyager MCP are enabled:

1. **Missive:** `get_conversation_timeline` — find the message with the attachment; note `message_id`
2. **Missive:** `list_message_attachments` — confirm attachment id, filename, category hint (PO, BOL, …)
3. **Missive:** `download_attachment` — returns `file_base64` + `content_type`
4. **Voyager:** `voyager_find_order` — resolve `order_id` from PO in subject/body
5. **Voyager:** `voyager_list_attachment_categories` — category UUID
6. **Voyager:** `voyager_attach_order_document` — pass `file_base64`, `file_name`, `content_type`

No manual download from Missive UI required.

#### Grounding rules (required)

- Order status, ship/delivery dates, quantities, SKUs, and carrier info must come from **`voyager_get_order`** on this turn — never from memory or guesswork
- If Voyager lookup fails, say that in the draft ("I'm confirming with our ops team…") or ask the user — do not invent status
- **`voyager_list_clients`** exposes `missive_team` and `missive_email_address` — use to confirm you're in the right client/Voyager context
- Do not merge Voyager order facts with **PBD** Missive threads — separate orgs

#### What to pull from Voyager into a reply

| Customer question | Voyager fields to check |
|---|---|
| "Where's my order?" | `order_status`, ship/delivery dates, shipment tracking if present |
| "What did we ship?" | Line items (SKU, qty, product name) |
| "Wrong qty / missing SKU" | Lines + open issues on the order |
| "When will it ship?" | `order_status`, `ship_date`, `mab_date`, shipment state |

### What not to do

- Do not send email — no send tool exists; human sends from Missive
- Do not send API keys, credentials, or internal URLs in drafts
- Do not confirm bug fixes or ship dates unless Voyager data or the user supports it
- Do not merge Voyager and PBD context — treat orgs separately even if the contact is the same person
- Do not use `create_draft` for thread replies — use `reply_to_conversation`
