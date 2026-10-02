#!/usr/bin/env bash
exec node "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/packages/coding-agent/dist/bundle/cli.js" "$@"
