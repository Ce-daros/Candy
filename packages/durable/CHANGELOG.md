# Changelog

## [Unreleased]

### Breaking Changes

- Reordered Storage scan arguments so the limit precedes the cursor.
- Added the required conversation-visible `Storage.entry(conversationId, id, context)` overload.
- Split `Tx.createConversation()` from `Tx.forkConversation()`, replaced raw conversation-record input, and require explicit ownerless or task ownership.
- Replaced untyped numeric record IDs and the `TaskRef` wrapper with erased branded numeric ID types, including result-typed `TaskId<R>`, separately branded commit sequences, and generic `Storage.mintId()`.
- Made task conversation membership immutable after task creation.
- Added `ConversationQuery` to Storage and transaction conversation scans.
- Renamed `@earendil-works/pi-durable` to `@candy/durable`, with AI and Chord dependencies under the Candy namespace. Update package dependencies and imports.

### Added

- Added transactional Sessions with typed durable documents, task creation, snapshots, retirement, and commit publications.
- Added document checkpoint selection, lazy version migration, and `Session.snapshotAsOf()` for rewindable conversation documents.
- Added policy-driven backend-side conversation document copying when creating forks.
- Added indexed conversation ownership queries and guaranteed no-effect Storage rejection handling.
- Added portable JSONL storage through `openNodeJsonlStorage()`, optional fsync, and reclamation of unused sidecar files.
- Added filesystem-backed `NodeExecutionEnv` with bounded output, spill files, and adaptive publication.
- Added reusable storage conformance tests and benchmarks through `@candy/durable/testing`.

### Changed

- Reduced repeated document copies during memory and SQLite replay.
- Set default execution-output limits to 50 KiB and 2,000 lines.

### Fixed

- Fixed output truncation metadata and handling of multibyte boundaries, oversized tail lines, and trailing newlines.

## [0.87.1] - 2026-09-22

## [0.87.0] - 2026-09-21

## [0.86.1] - 2026-09-20

## [0.86.0] - 2026-09-19

### Added

- Added the initial Pico durable record contracts and detached in-memory storage implementation.
