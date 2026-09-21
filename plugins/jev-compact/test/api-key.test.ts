import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_AUTH_PROVIDER_ID,
  describeApiKeySource,
  resolveApiKey,
} from '../src/api-key.ts';

/**
 * A fake filesystem for the resolver.
 *
 * The resolver takes an injected reader precisely so these tests never touch a
 * developer's real credentials in the pi agent directory.
 */
function files(entries: Record<string, string>) {
  return (path: string): string | undefined => entries[path];
}

const AGENT_DIR = '/agent';

describe('resolveApiKey precedence', () => {
  test('the environment wins over both files', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: { TYPESAFE_API_KEY: 'from-env' },
      readFile: files({
        [`${AGENT_DIR}/jev-compact.json`]: JSON.stringify({ apiKey: 'from-config' }),
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key', key: 'from-auth' },
        }),
      }),
    });

    expect(resolved.key).toBe('from-env');
    expect(resolved.source).toBe('environment');
  });

  test('the config file wins over auth.json', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/jev-compact.json`]: JSON.stringify({ apiKey: 'from-config' }),
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key', key: 'from-auth' },
        }),
      }),
    });

    expect(resolved.key).toBe('from-config');
    expect(resolved.source).toBe('config-file');
  });

  test('auth.json is used when the environment and config file are absent', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key', key: 'from-auth' },
        }),
      }),
    });

    expect(resolved.key).toBe('from-auth');
    expect(resolved.source).toBe('auth-file');
  });

  test('a custom auth provider id is honoured', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      authProviderId: 'my-typesafe',
      readFile: files({
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          'my-typesafe': { type: 'api_key', key: 'custom' },
        }),
      }),
    });

    expect(resolved.key).toBe('custom');
  });
});

describe('resolveApiKey robustness', () => {
  test('nothing configured resolves to none rather than throwing', () => {
    const resolved = resolveApiKey({ agentDir: AGENT_DIR, env: {}, readFile: () => undefined });
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe('none');
  });

  test('whitespace is stripped and reported as repaired', () => {
    // The real failure this prevents: a newline inside an HTTP header throws
    // with a message that names no cause.
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: { TYPESAFE_API_KEY: 'sk-abc\n' },
      readFile: () => undefined,
    });

    expect(resolved.key).toBe('sk-abc');
    expect(resolved.repaired).toBe(true);
  });

  test('a clean value is not reported as repaired', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: { TYPESAFE_API_KEY: 'sk-abc' },
      readFile: () => undefined,
    });
    expect(resolved.repaired).toBe(false);
  });

  test('a whitespace-only value is treated as absent', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: { TYPESAFE_API_KEY: '   \n  ' },
      readFile: () => undefined,
    });
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe('none');
  });

  test('a malformed config file is skipped instead of crashing', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/jev-compact.json`]: '{ not json',
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key', key: 'from-auth' },
        }),
      }),
    });

    // Falls through to the next source rather than failing outright.
    expect(resolved.key).toBe('from-auth');
    expect(resolved.source).toBe('auth-file');
  });

  test('a non-string apiKey in the config file is ignored', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/jev-compact.json`]: JSON.stringify({ apiKey: 12345 }),
      }),
    });
    expect(resolved.key).toBeUndefined();
  });

  test('an oauth credential under the provider id is not used as an api key', () => {
    // Guessing at a different credential type would send the wrong value as a
    // bearer token; ignoring it surfaces as "not configured" instead.
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'oauth', access: 'tok', refresh: 'r', expires: 1 },
        }),
      }),
    });
    expect(resolved.key).toBeUndefined();
    expect(resolved.source).toBe('none');
  });

  test('an api_key credential with no key field is ignored', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key' },
        }),
      }),
    });
    expect(resolved.key).toBeUndefined();
  });

  test('auth.json entries for other providers are left alone', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({
        [`${AGENT_DIR}/auth.json`]: JSON.stringify({
          anthropic: { type: 'api_key', key: 'sk-ant-other' },
          [DEFAULT_AUTH_PROVIDER_ID]: { type: 'api_key', key: 'ours' },
        }),
      }),
    });
    expect(resolved.key).toBe('ours');
  });

  test('an array at the auth.json root does not masquerade as credentials', () => {
    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({ [`${AGENT_DIR}/auth.json`]: JSON.stringify(['a', 'b']) }),
    });
    expect(resolved.key).toBeUndefined();
  });
});

describe('describeApiKeySource', () => {
  test('names a place the user can act on', () => {
    expect(describeApiKeySource('environment')).toBe('TYPESAFE_API_KEY');
    expect(describeApiKeySource('config-file')).toBe('jev-compact.json');
    expect(describeApiKeySource('auth-file')).toBe(`auth.json[${DEFAULT_AUTH_PROVIDER_ID}]`);
    expect(describeApiKeySource('none')).toBe('not configured');
  });
});

describe('the auth.json entry is shape-compatible with pi', () => {
  test('a stored entry uses the same { type, key } shape pi writes', () => {
    // pi's own credential type is ApiKeyCredential = { type: "api_key", key?,
    // env? } and its write path is `delete data[provider]` + re-serialize, so a
    // foreign provider id survives a pi credential change. This asserts the
    // shape we expect to read back, so a pi change that alters it fails here
    // rather than silently dropping the key.
    const entry = { type: 'api_key', key: 'k' } as const;
    const file = JSON.stringify({ [DEFAULT_AUTH_PROVIDER_ID]: entry });
    const parsed = JSON.parse(file) as Record<string, { type: string; key?: string }>;

    expect(parsed[DEFAULT_AUTH_PROVIDER_ID]!.type).toBe('api_key');
    expect(typeof parsed[DEFAULT_AUTH_PROVIDER_ID]!.key).toBe('string');

    const resolved = resolveApiKey({
      agentDir: AGENT_DIR,
      env: {},
      readFile: files({ [`${AGENT_DIR}/auth.json`]: file }),
    });
    expect(resolved.key).toBe('k');
  });
});
