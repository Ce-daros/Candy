# RPC Extension UI

Extensions request user interaction through `ctx.ui`. RPC mode forwards supported dialogs and text updates through a request/response subprotocol alongside normal [RPC commands](rpc-commands.md) and [session events](json.md).

Dialog methods (`select`, `confirm`, `input`, and `editor`) emit an `extension_ui_request` on stdout and wait for a matching `extension_ui_response` on stdin. `notify`, `setStatus`, and `setWidget` emit a request without waiting for a response. A dialog timeout resolves on the Candy side.

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

## Responses to Candy

Responses apply to dialogs only. The response `id` must match the request.

```json
{"type":"extension_ui_response","id":"uuid-1","value":"Allow"}
```

```json
{"type":"extension_ui_response","id":"uuid-2","confirmed":true}
```

Setting `cancelled: true` resolves selection, input, or editor with `undefined`, and confirmation with `false`.

See the checked [RPC extension UI client](../examples/rpc-extension-ui.ts). The request and response types are defined in [`rpc-types.ts`](../src/modes/rpc/rpc-types.ts).
