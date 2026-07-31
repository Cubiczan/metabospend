# Prava API notes — verified against the sandbox, 30 July 2026

Findings from testing `sandbox.api.prava.space` directly with an `sk_test_` key.
Recorded because **the prose docs, the integration guide, and Prava's own starter
template disagree with the API** in ways that fail confusingly. Each item below
was confirmed by an actual request, not read from documentation.

Where sources conflict, `prava-skills/prava-sdk-integration/SKILL.md` was right
and everything else was stale.

## 1. Session creation: `total_amount`, not `amount`

`POST /v1/sessions` requires `total_amount`. Sending `amount` returns:

```json
{"error":{"code":"VAL_2001","message":"Invalid request body",
  "details":{"fieldErrors":{"total_amount":["Required"],"purchase_context":["Required"]}}}}
```

Note the second field error: an invalid `product_details` entry makes the *whole*
`purchase_context` read as missing, which sends you looking in the wrong place.

## 2. Product lines: `unit_price`, not `amount`

Inside `purchase_context[].product_details[]`, the field is `unit_price`, and it
is the **per-unit** price — not the line total. `PRAVA_INTEGRATION_GUIDE.md` in
`prava-skills` shows `amount`, which is rejected.

Working payload:

```json
{
  "user_id": "metabospend-ops",
  "user_email": "ops@metabospend.local",
  "total_amount": "21.60",
  "currency": "USD",
  "description": "Widget case restock",
  "purchase_context": [{
    "merchant_details": {"name":"Acme Supply","url":"https://acmesupply.com","country_code_iso2":"US"},
    "product_details": [{"description":"Widget case","unit_price":"21.60","quantity":1}],
    "effective_until_minutes": 15
  }]
}
```

→ `200` with `session_id`, `session_token`, `iframe_url`, `order_id`, `expires_at`.

## 3. Prava's `sdk-template` is broken as shipped

[Prava-Payments/sdk-template](https://github.com/Prava-Payments/sdk-template)
sends both wrong field names (`src/app/actions.ts`, `amount` and
`product_details[].amount`), so clicking **Buy** returns `Invalid request body`
against the current sandbox. Patching those two names makes session creation and
polling work.

## 4. Credentials are nested on the line item

`GET /v1/sessions/{id}/payment-result` puts the token at
`transactions[0].line_items[0].token`, **not** `transactions[0].token`.

This is the nastiest of the four: reading the transaction level yields
`undefined` with no error, so it looks like a credential-less success rather than
a bug. `PRAVA_INTEGRATION_GUIDE.md` documents the flat shape.

Our client reads the nested path and falls back to flat, so a change in either
direction survives.

## 5. Session ids are `ses_`, not `sess_`

Four characters, and a regex written against `sess_` silently matches nothing.

## 6. `CUSTOMER_NOT_FOUND` means "nothing authorized yet"

`GET /v1/mandates?customer_id=…` returns `404 CUSTOMER_NOT_FOUND` when that
customer has never transacted. A customer is created implicitly by the first
session or mandate, so **every fresh sandbox account starts in this state**.

Treated as an empty mandate list, not an outage. Without a `customer_id` filter
the same endpoint returns `200 {"mandates":[]}`.

## 7. Errors are nested under `error`

```json
{"error":{"code":"AUTH_1001","message":"Invalid API key","details":{}}}
```

Reading `.message` or `.error` off the top level yields `[object Object]` and
throws away the only useful information. Our client reads `error.code` and
`error.message`.

## 8. The SDK's embedded iframe did not work against sandbox

`@prava-sdk/core@0.1.1` mounted with a sandbox `iframe_url`
(`https://sandbox.collect.prava.space?session=ses_…`) reports
`Session preview failed: 404` from inside the iframe. The `iframe_url` itself
returns `200` when fetched directly, and every server-side call succeeds — so
this is in the hosted card-collection page or its key provisioning, not in the
session.

**Unresolved.** It does not block us: MetaboSpend's approval lane hands the
person a URL to open rather than embedding the SDK, which is the documented
"Approach B" and sidesteps this entirely.

## 9. There is no CLI sandbox

The `@prava-sdk/cli` (Prava Pay) path runs against the **live API only**. There
is no `--test` flag, so `prava mandate charge` on the CLI spends real money on a
real card. The sandbox exists only on REST.

This is why MetaboSpend has both a CLI client and a REST client behind one
`PravaGateway` interface: REST/sandbox to build and rehearse, CLI/live for the
production story.

## Confirmed working, end to end

| Call | Result |
|---|---|
| `GET /health` | `200 {"status":"ok"}` |
| `POST /v1/sessions` | `200` · `ses_01KYTQXAVWTT3BEB93KQT4E51J` |
| `GET /v1/sessions/{id}/payment-result` | `200` · `status: "pending"`, empty `transactions` |
| `GET /v1/mandates` | `200 {"mandates":[]}` |
| `GET /v1/mandates?customer_id=…` | `404 CUSTOMER_NOT_FOUND` until first transaction |

## Blocked on Prava

**Sandbox test card numbers.** Both the template UI and the SDK skill say network
test cards are issued by the Prava team — `support@prava.space`. Without them the
card-entry and passkey steps cannot be exercised at all, which is the last
unverified stretch of the flow.
