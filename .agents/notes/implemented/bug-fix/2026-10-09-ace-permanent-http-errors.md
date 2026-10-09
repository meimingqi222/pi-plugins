# Agent Note: Do not retry permanent ACE 4xx

Status: implemented

## Problem

The catch retried 400 and 404 despite the non-retry branch throwing them.

## Decision

Rethrow non-rate-limit 4xx in catch, retaining transport/server/429 retries.

## Alternatives considered

Only handling 401/403 misses malformed requests; removing all retries loses recovery.

## Consequences

Permanent failures surface after one request; existing fatal-auth classification remains available.

## Verification

- Test file: `plugins/ace-search/test/client.test.ts`

- `plugins/ace-search/test/client.test.ts::permanent 400 and 404 responses are not retried`

Proved: The old 400 made three requests and failed; afterward both statuses make one.
