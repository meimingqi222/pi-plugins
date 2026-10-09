# Agent Note: Preserve inline image data URLs in provider requests

Status: implemented

## Problem

`plugins/redact/src/pi-bridge.ts` preserved pi image objects, but the final
provider payload represents those images as Base64 data URLs. The deep walker
treated the URLs as ordinary strings and scanned their binary contents for
credentials. A valid PNG in a pi session accidentally matched the Alibaba
access-key rule; the resulting redaction marker corrupted its Base64, and
StepFun rejected the request with `url invalid`.

## Decision

Preserve complete Base64 image data URLs byte-for-byte at the string branch of
`redactJson`. Match the entire value, including the Base64 alphabet and padding,
so text appended to an image-looking prefix still undergoes redaction. This
covers both Chat Completions image URL shapes and Responses input images while
keeping copy-on-write references intact.

## Alternatives considered

- Skip entire image URL objects: this would also bypass credentials in remote
  URLs and unrelated fields within the object.
- Disable the Alibaba rule: genuine credentials must still be redacted, and
  other rules can accidentally match binary data too.
- Fix the proxy: the corruption happens before the request reaches it; the
  proxy cannot reconstruct image bytes replaced by a marker.

## Consequences

Only complete inline image data URLs bypass credential scanning. Ordinary text,
remote image URLs, and non-image data URLs continue to be redacted. As with the
existing image-object exemption, this protects encoded bytes and does not
attempt to inspect visible secrets inside image pixels.

The tests use the existing split AWS fixture as a credential-shaped Base64
sequence, without committing the user's screenshot or any contiguous token.

## Verification

- `plugins/redact/test/pi-bridge.test.ts::preserves inline image data URLs in provider payloads`
- `plugins/redact/test/pi-bridge.test.ts::still redacts remote image URLs and non-image data URLs`

Proved: before the fix, `bun test plugins/redact/test/pi-bridge.test.ts` failed
all three inline-image cases at the hit-count assertion (expected 1, received
2); output is saved in `.agents/notes-evidence/2026-10-09-redact-inline-image-red.txt`.
After the fix, the same cases pass and the real failing PNG is preserved
byte-for-byte with zero redaction hits.
