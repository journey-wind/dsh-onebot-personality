import { randomUUID } from 'node:crypto';
import type { Volatile } from '@deepseek-ai/cordis';
import { parseConfig } from '../config.js';
import type { PluginConfig } from '../config.js';
import { freezeDeep } from '../llm/routes.js';
import type { ConfigurationReader, CurrentConfiguration } from './configuration.js';
import { RuntimeError } from './configuration.js';

/** Public Volatile.get returns the frozen config itself, not {value,version}. No internal write/subscribe API.
 * Parsing is cached by snapshot identity; revisions contain NO config/credential hashes and are boot-unique. */
export function configurationReader(reference: Pick<Volatile<PluginConfig>, 'get'>): ConfigurationReader {
  const epoch = randomUUID(); let sequence = 0;
  let previous: unknown; let current: CurrentConfiguration | undefined;
  return () => {
    const snapshot = reference.get();
    if (current && snapshot === previous) return current;
    const config = freezeDeep(parseConfig(snapshot));
    if (sequence >= Number.MAX_SAFE_INTEGER) throw new RuntimeError('configuration-revision-overflow');
    const next = { config, revision: `${epoch}:${++sequence}` };
    previous = snapshot; current = next;
    return next;
  };
}
