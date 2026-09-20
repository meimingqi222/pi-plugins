/**
 * Credential-shaped fixtures for the redaction tests.
 *
 * Every value here is a **dummy** — none is a real credential. They exist so the
 * built-in rules have something to recognise.
 *
 * Why each value is assembled from two concatenated halves: this repository is a
 * secret-redaction tool, so its fixtures must look like secrets, but a
 * *contiguous* credential-shaped literal has two costs. It trips secret
 * scanners — GitHub push protection refused the first push of this repository on
 * the Slack fixture — and it makes any scan of the repository report false
 * positives, which teaches people to ignore the scanner.
 *
 * The split point is not cosmetic. It is chosen so that **neither half matches a
 * rule on its own**, because a half long enough to match would be flagged
 * exactly like the whole. `test/no-secrets.test.ts` enforces both properties:
 * no contiguous literal in the source, and every assembled value still
 * recognised by the redactor.
 */

/** Recognised by: anthropic-api-key. */
export const ANTHROPIC_KEY = "sk-ant-api03-abcdefghijk" + "lmnopqrstuvwxyz0123456789";

/** Recognised by: aws-access-key-id. */
export const AWS_ACCESS_KEY_ID = "AKIAIOSFOD" + "NN7EXAMPLE";

/** Recognised by: github-pat. */
export const GITHUB_PAT = "ghp_abcdefghijklmnop" + "qrstuvwxyz1234567890";

/** Recognised by: gitlab-pat. */
export const GITLAB_PAT = "glpat-abcdefg" + "hijklmnopqrst";

/** Recognised by: jwt-token. */
export const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI" + "xMjM0NTY3ODkwIn0.Zm9vYmFyYmF6cXV4";

/** Recognised by: sk-secret. */
export const OPENAI_KEY = "sk-abcdefghi" + "jklmnopqrstuvwxyz0123456789";

/** Recognised by: sk-secret. */
export const OPENAI_KEY_2 = "SK-ZYXWVUTSR" + "QPONMLKJIHGFEDCBA";

/** Recognised by: sk-secret. */
export const OPENAI_KEY_3 = "sk-123ad" + "awdzczwq";

/** Recognised by: sk-secret. */
export const OPENAI_KEY_4 = "sk-ONMLKJ" + "IHGFEDCBA";

/** Recognised by: slack-access-token. */
export const SLACK_TOKEN = "xoxb-123456789" + "012-abcdefghijklmnop";

/** A PEM block whose body is also a dummy. */
export const PEM_PRIVATE_KEY = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIEowIBAAKCAQEA1234567890" + "abcdefghijklmnopqrstuvwxyz",
  "-----END RSA PRIVATE KEY-----",
].join("\n");
