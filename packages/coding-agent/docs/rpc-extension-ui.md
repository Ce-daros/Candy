# RPC Extension UI

Extensions request user interaction through `ctx.ui`; MCP servers can also request form input, a URL visit, or OAuth authorization. RPC mode forwards these through a request/response subprotocol alongside normal [RPC commands](rpc-commands.md) and [session events](json.md).

Dialog methods (`select`, `confirm`, `input`, and `editor`) and MCP interactions emit an `extension_ui_request` on stdout and wait for a matching `extension_ui_response` on stdin. `notify`, `setStatus`, and `setWidget` emit a request without waiting for a response. A dialog timeout resolves on the Candy side.

## Requests from Candy

Each request has `type: "extension_ui_request"`, a unique `id`, and a `method`.

### select

```json
{"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Choose an action","options":["Allow","Block"],"timeout":10000}
```

Respond with the selected option in `value`, or set `cancelled: true`.

### confirm

```json
{"type":"extension_ui_request","id":"uuid-2","method":"confirm","title":"Clear session?","message":"All messages will be lost."}
```

Respond with `confirmed: true` or `confirmed: false`, or set `cancelled: true`.

### input and editor

```json
{"type":"extension_ui_request","id":"uuid-3","method":"input","title":"Enter a value","placeholder":"type something..."}
```

```json
{"type":"extension_ui_request","id":"uuid-4","method":"editor","title":"Edit text","prefill":"Line 1\nLine 2"}
```

Respond with the entered text in `value`, or set `cancelled: true`.

### notify

```json
{"type":"extension_ui_request","id":"uuid-5","method":"notify","message":"Command blocked","notifyType":"warning"}
```

`notifyType` is `info`, `warning`, or `error`; it defaults to `info`.

### setStatus

```json
{"type":"extension_ui_request","id":"uuid-6","method":"setStatus","statusKey":"my-ext","statusText":"Waiting for review"}
```

Omit `statusText` or set it to `undefined` to clear the status.

### setWidget

```json
{"type":"extension_ui_request","id":"uuid-7","method":"setWidget","widgetKey":"my-ext","widgetLines":["Plan","1. Inspect","2. Verify"]}
```

`widgetLines` contains plain text lines. Omit it or set it to `undefined` to remove the widget.

### mcp_elicitation

`request` is the MCP elicitation request. The `form` mode carries a flat object schema; show its fields and return typed values, including string arrays for multi-select fields. Field definitions can provide a default, a single-select `enum` or titled `oneOf`, a multi-select `items.enum` or titled `items.anyOf`, and string formats (`email`, `uri`, `date`, `date-time`). The `url` mode carries an `elicitationId` and URL; ask the user before opening that URL and wait for their completion decision. Keep the original `id` for the entire exchange.

```json
{"type":"extension_ui_request","id":"uuid-8","method":"mcp_elicitation","server":"remote","request":{"mode":"form","message":"Choose a report","requestedSchema":{"type":"object","properties":{"label":{"type":"string","title":"Label"},"copies":{"type":"integer","minimum":1}},"required":["label"]}}}
```

```json
{"type":"extension_ui_response","id":"uuid-8","action":"accept","content":{"label":"Summary","copies":2}}
```

```json
{"type":"extension_ui_request","id":"uuid-9","method":"mcp_elicitation","server":"remote","request":{"mode":"url","message":"Complete setup in your browser","elicitationId":"setup-1","url":"https://example.test/setup"}}
```

For either mode, reply with `action: "accept"` after completion, `"decline"` for an explicit refusal, or `"cancel"` if the interaction was abandoned. Only accepted form responses include `content`. The same pending request queue handles extension dialogs and MCP interactions; there is no separate MCP response command.

### mcp_authorization

OAuth login can ask the RPC host to authorize a URL. The host should ask the user before opening it, then respond to the request. `accept` means the authorization page was opened; Candy continues the OAuth callback flow. `decline` or `cancel` ends the interaction.

```json
{"type":"extension_ui_request","id":"uuid-10","method":"mcp_authorization","server":"remote","url":"https://example.test/authorize"}
{"type":"extension_ui_response","id":"uuid-10","action":"accept"}
```

## Responses to Candy

Responses apply to dialogs only. The response `id` must match the request.

```json
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
```

```json
{"type":"extension_ui_response","id":"uuid-2","confirmed":true}
```

Setting `cancelled: true` resolves selection, input, or editor with `undefined`, and confirmation with `false`.
For MCP requests, use `action` instead of `cancelled` or `confirmed`. If the request is cancelled by Candy or the session changes, a late response cannot resume it.

See the checked [RPC extension UI client](../examples/rpc-extension-ui.ts). The request and response types are defined in [`rpc-types.ts`](../src/modes/rpc/rpc-types.ts).
