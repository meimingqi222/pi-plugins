# Agent Note: ACE cache entries require confirmation by the current server

Status: implemented

## Problem

Local manifests identify a project and its content but do not prove that a different endpoint or account still has those blobs. Server-side eviction also invalidates that assumption.

## Decision

Check locally cached hashes with the current server before skipping uploads. Upload unknown hashes, and re-upload all unconfirmed hashes if the status request fails or returns an invalid shape; authentication failures and cancellation stop the search.

## Alternatives considered

Keying the local manifest by endpoint and credentials does not detect server eviction and cannot safely identify the owner of an acemcp cache. Trusting local manifests avoids a request but silently loses retrieval coverage.

## Consequences

Warm searches make a status request. A failed or invalid response can cause redundant uploads, preserving retrieval correctness. Pending blobs remain known to the server.

## Verification

- `plugins/ace-search/test/search.test.ts::a warm local cache is checked against the current server`
- `plugins/ace-search/test/client.test.ts::findMissing rejects an invalid response instead of assuming all hashes exist`

Proved: pre-fix assertions failed; output saved to `regression-evidence/ace-server-cache-red.txt` and `regression-evidence/ace-invalid-status-red.txt`.
