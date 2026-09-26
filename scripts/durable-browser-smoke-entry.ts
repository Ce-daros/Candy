import * as durable from "@candy/durable";
import * as environment from "@candy/durable/env";
import * as jsonl from "@candy/durable/storage/jsonl";
import * as sqlite from "@candy/durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
