# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-03-19

### ⚠ Breaking

- Redefined single-record adapter mutations around a strict SurrealDB-first contract: `update()` and `delete()` now use `ONLY <table> WHERE ...` semantics instead of resolving a target record id first.
- Removed the adapter-side single-record target lookup fallback for non-id predicates; singularity is now expected to come from SurrealDB schema/index guarantees on Better Auth single-record fields.

### Changed

- Refactored single-record `update()` to execute table-scoped `UPDATE ONLY <table> ... WHERE ... RETURN AFTER` directly.
- Refactored single-record `delete()` to execute table-scoped `DELETE ONLY <table> ... WHERE ... RETURN BEFORE` directly.
- Removed `resolveSingleTargetRecordId` and the extra `SELECT VALUE id ... LIMIT 1` round trip from single-record mutation paths.
- Realigned unit and integration coverage around the new baseline where SurrealDB enforces one-record mutation cardinality through `ONLY` plus schema uniqueness.

## [0.8.0] - 2026-03-18

### ⚠ Breaking

- Removed `usePlural` from `SurrealAdapterConfig`; pluralized table naming is no longer configurable.
- Adapter factory now hard-codes `usePlural: false` for a single singular-table contract.

### Changed

- Refactored adapter query execution around SurrealDB `BoundQuery` composition, with a unified where-clause pipeline shared across `find`, `count`, `update`, and `delete` paths.
- Refactored mutation implementation to favor SurrealDB-native `SET` semantics for updates (`null` -> `NONE`) and explicit `RETURN AFTER/BEFORE` count/result behavior.
- Simplified single-record delete flow to SurrealDB-native target subquery selection (`SELECT VALUE id ... LIMIT 1`) before `DELETE`, preserving deterministic one-record behavior.
- Reduced adapter boilerplate by consolidating internal query builders/helpers and removing redundant defensive wrappers.
- Updated README to a concise runtime-focused guide and added explicit `defineAccess` example usage.
- Added safe Surreal client cleanup (`close()` in `finally`) in JWT access integration coverage.
- Tightened integration assertions for duplicate-email signup behavior and admin unauthorized endpoint checks.
- Tightened UUIDv7 integration validation to assert version-7 UUID format explicitly.
- Reduced expected-noise stderr output in negative auth-path integration tests via targeted console error suppression helpers.

## [0.7.0] - 2026-03-16

### ⚠ Breaking

- Removed the `apiEndpoints` adapter option and generated `DEFINE API` schema output.
- Removed standalone schema/migration helper public entrypoints; the package now exposes the adapter runtime surface only.
- Removed adapter-specific migration CLI workflow from the documented/public package surface.
- Transaction option contract is now boolean (`true` | `false`); `"auto"` is no longer a supported option.

### Changed

- Adapter runtime now consistently treats Surreal string record ids (`table:id`) as the canonical boundary format across CRUD and plugin flows.
- Runtime model/field remapping is applied end-to-end for reads, writes, filtering, sorting, and projection through Better Auth adapter mapping hooks.
- `create` no longer accepts explicit ids; record creation always delegates id generation to SurrealDB (including configured `recordIdFormat` behavior).
- `recordIdFormat` behavior is constrained to create-target strategy (`native`, `uuidv7`, `ulid`) and no longer implies logical-id normalization.
- Mutation handling was hardened to map `null` to `NONE` and omit `undefined`, preventing schemafull coercion errors during update paths.
- Transaction handling now uses Surreal SDK feature probing (`Features.Transactions`) plus transactional adapter wrapping, while preserving Better Auth fallback when disabled/unsupported.
- Schema generation remains `DEFINE ... OVERWRITE`-based and now focuses on auth tables/fields/indexes plus optional `defineAccess` output only.
- `defineAccess` remains the single extension point for custom `DEFINE ACCESS` output and requires static SurQL (no bound variables during schema generation).
- Updated README to match the current runtime surface (adapter-only export, no standalone schema helper entrypoint or adapter migration CLI).
- Removed outdated README references to deprecated/example workflows that are no longer present in this branch.
- Clarified compatibility wording for SurrealDB JavaScript SDK v2 (client) with modern SurrealDB v3 server deployments.

## [0.6.0] - 2026-03-13

### ⚠ Breaking

- Adapter id contract is now strict SurrealDB string record ids (`table:id`) for ID-bearing paths.
- Bare ids (for example `abc123`) are no longer accepted for primary-id filters or reference-id filters/writes.
- Adapter output for `id` and reference fields now remains full string record ids instead of stripping table prefixes.

### Changed

- Switched package builds from `tsc` emit to `tsdown` ESM output.
- Published entrypoints/types now target `.mjs` and `.d.mts` artifacts.
- Updated npm package file inclusion to ship only ESM runtime and ESM type artifacts.
- Split schema/migration helpers into a dedicated `@vxlx/surrealdb-better-auth/schema` entrypoint and kept the root entry focused on adapter runtime.
- Adapter `createSchema` now lazy-loads the schema module so consumers importing only `surrealAdapter` avoid bundling schema helper implementation code.
- Narrowed root adapter exports so only `surrealAdapter` is publicly exported from `@vxlx/surrealdb-better-auth`.
- Removed legacy UUID literal/prefix normalization logic in favor of strict `StringRecordId`-validated parsing.
- `recordIdFormat` now only controls create-time record target strategy when no explicit id is provided.
- Updated JWT payload handling/tests to use full record-id strings directly for `id`/`sub`.
- Realigned integration and unit tests around full string record-id behavior and strict bare-id rejection.

## [0.5.1] - 2026-03-12

### Changed

- Refactored shared query-target preparation paths in the adapter to reduce duplicated logic across `count`, `findOne`, `findMany`, `update`, `updateMany`, `delete`, and `deleteMany`.
- Improved SurrealDB query error classification and shaping for field coercion and unique-constraint violations with clearer adapter-level error messages.
- Streamlined integration test setup/teardown and fixture generation to reduce duplication and improve reliability across auth/core/plugin feature coverage.

## [0.5.0] - 2026-03-12

### Added

- Added a `transaction` adapter option (`"auto"` | `true` | `false`) to control transaction behavior explicitly.
- Added unit coverage for transaction capability detection and unsupported-session fallback behavior.

### Changed

- Transaction handling now performs SDK feature-aware detection (`Sessions` + `Transactions`) in auto mode and falls back internally when unsupported, removing the need for app-level `forkSession` normalization workarounds.
- Hardened integration test server startup by adding child-process failure diagnostics, safer port selection, and retry behavior to reduce flaky health-check timeouts.
- Replaced adapter-internal structural typing with SDK and Better Auth exported types in transaction/query/adapter factory paths, removing unsafe type casts.

## [0.4.0] - 2026-03-11

### Added

- Integration coverage for explicit query operator behavior including unsupported operators and malformed `in` filters.
- Integration coverage for stricter reference-field validation on writes and filters.

### Changed

- Improved transaction implementation to use a wrapped transaction-scoped adapter without assuming a Node-only runtime.
- Added explicit query/operator validation instead of silently falling back for unsupported operators.
- Tightened reference-field handling so plain Better Auth ids are converted automatically, while explicit wrong-table record ids are rejected early.
- Prefer SurrealDB SDK-defined error types first when shaping adapter errors, with clearer messages for unique constraint and field coercion failures.
- Documented transaction usage, query behavior, reference-field behavior, and error handling in the README.

## [0.3.0] - 2026-03-11

### Added

- Initial Better Auth transaction support using the SurrealDB JavaScript SDK v2 session transaction API.
- Integration tests covering transaction commit and rollback behavior.

### Changed

- Documented transaction usage and behavior in the README.

## [0.2.0] - 2026-03-10

### Changed

- Moved `better-auth` and `surrealdb` from package dependencies to peer dependencies so consuming apps use their own installed versions.
- Added publish-safe package metadata and release scaffolding for npm publishing and GitHub Actions.

### Added

- `applySurqlSchema(...)` helper for explicitly generating and applying Better Auth schema to SurrealDB.
- Migration CLI support so apps can run schema application explicitly via `bunx surrealdb-better-auth migrate --config ./auth.ts`.
- Example Bun server support for SurrealDB record-JWT claim shaping via `SURREALDB_ACCESS`.

### Developer Experience

- Added a minimal Bun server for live local verification of Better Auth routes.
- Added browser-focused tests using `@vitest/browser-playwright` for `/.well-known`, sign-up/sign-in flows, and session cookie behavior.
- Strengthened JWT integration coverage to verify Better Auth JWT claims and authenticated SurrealDB record access through `DEFINE ACCESS ... TYPE RECORD WITH JWT`.

## [0.1.0] - 2026-03-10

### Added

- Initial public release of the SurrealDB Better Auth adapter.
- Support for Better Auth adapter CRUD operations backed by the SurrealDB JavaScript SDK v2.
- Schema generation helpers and record-id normalization behavior for SurrealDB.
