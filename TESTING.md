# Automated tests

The project uses Node's built-in test runner and has no third-party test dependencies.

## Requirements

- Node.js 22.5 or newer (for the built-in SQLite integration harness)

## Run the tests

From the repository root:

```powershell
node --test test
```

The package script provides the equivalent command:

```powershell
npm.cmd test
```

Use `npm.cmd` on Windows if PowerShell execution policy prevents the `npm.ps1` shim from running.

## Current coverage

The smoke tests verify:

- The application shell includes its PWA, local storage, IndexedDB, navigation, and service-worker hooks.
- The web manifest and cached application assets have the expected structure.
- Demo seed records have valid collections and unique rabbit IDs.
- Every Cloudflare API module loads and exports a request handler.
- Basic health and rabbit-read behavior against mocked D1 bindings.
- The test backup endpoint fails closed outside the test environment, requires authentication, and still has writes disabled.
- All D1 migrations reconstruct an isolated SQLite schema with the expected constraints.
- Rabbit, litter, and breeding create/read/edit flows execute against that migrated schema.
- Invalid requests, parent validation, environment isolation, and existing optimistic conflicts are rejected.
- Access JWT signature, issuer, audience, expiration, header, and compatibility-cookie handling.
- Authenticated reads and optimistic breeding-update conflicts.

These tests do not contact Cloudflare, modify D1, open a browser, deploy the application, or alter rabbitry data.

See `D1-DEVELOPMENT.md` for the reconstructed schema, assumptions, and integration-test design.

