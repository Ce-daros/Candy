# Changelog

## [Unreleased]

### Breaking Changes

- Renamed `@earendil-works/chord` to `@candy/chord`. Update package dependencies and imports.
- Consolidated immutable delta tracking around explicit `beginChange()`, `prepare()`, and `adopt()` transactions. Initial and replacement values transfer ownership of alias-free strict JSON; callers must not mutate transferred or published values.
- Assigning `undefined` to an object property deletes it. Changes publish atomically, and draft values cannot be used after the change callback returns.

### Added

- Added `replicatedState(source, options?)` and `ReplicatedStateSource` for publication-only state attached to a source, forwarding snapshots and frames without re-diffing, with explicit disposal.
- Exported `copyJson` and `CopyJsonOptions`.

### Changed

- Reduced copying in immutable batch application and document replay by retaining unchanged structure.

### Fixed

- Allowed promise-detection probes of `then` on settled drafts.
