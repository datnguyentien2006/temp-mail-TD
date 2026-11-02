/**
 * Provider registry.
 *
 * The app supports two interchangeable mailbox providers:
 *   - `selfhosted`: this app's own SMTP server + in-memory store.
 *   - `guerrilla`:  Guerrilla Mail's public JSON API (opt-out via ENABLE_GUERRILLA).
 *
 * Every provider implements the same surface:
 *   listDomains, createMailbox, listMailboxes, getMailbox, listMessages,
 *   getMessage, deleteMessage, deleteMailbox, extendMailbox, getAttachment,
 *   markSessionActive (optional), start/stop (optional)
 * plus a `capabilities` object the UI uses to decide what to show.
 */
import { normalizeDomain } from '../mailboxes.js';
import { providerError } from './errors.js';
import { createGuerrillaProvider } from './guerrilla.js';
import { createSelfHostedProvider } from './selfhosted.js';

export function createProviders({ store, config, guerrillaClient, logger } = {}) {
  const providers = new Map();

  const selfHosted = createSelfHostedProvider({ store, config });
  providers.set(selfHosted.id, selfHosted);

  if (config.guerrilla?.enabled) {
    const guerrilla = createGuerrillaProvider({
      store,
      config,
      client: guerrillaClient,
      logger,
    });
    providers.set(guerrilla.id, guerrilla);
  }

  function get(id) {
    return providers.get(id) ?? null;
  }

  function requireProvider(id) {
    const provider = get(id);
    if (!provider) {
      throw providerError(400, `Unknown provider "${id}".`, 'UNKNOWN_PROVIDER');
    }
    return provider;
  }

  /** Pick a provider from an explicit id, a domain, or the default. */
  function resolve(providerId, domain) {
    if (providerId !== undefined && providerId !== null && String(providerId).trim() !== '') {
      return requireProvider(String(providerId).trim());
    }

    const wanted = normalizeDomain(domain);
    if (wanted) {
      for (const provider of providers.values()) {
        if (provider.listDomains().includes(wanted)) return provider;
      }
      throw providerError(
        400,
        `Domain "${wanted}" is not offered by any enabled provider.`,
        'INVALID_DOMAIN',
      );
    }

    return providers.get('selfhosted') ?? [...providers.values()][0] ?? requireProvider('selfhosted');
  }

  return {
    get,
    requireProvider,
    resolve,

    list() {
      return [...providers.values()];
    },

    /** Grouped descriptor used by GET /api/domains. */
    descriptor() {
      return [...providers.values()].map((provider) => ({
        id: provider.id,
        label: provider.label,
        description: provider.description,
        capabilities: provider.capabilities,
        domains: provider.listDomains(),
      }));
    },

    /** Flat list, kept for backwards compatibility with older clients. */
    listAllDomains() {
      const out = [];
      for (const provider of providers.values()) {
        for (const domain of provider.listDomains()) {
          if (!out.includes(domain)) out.push(domain);
        }
      }
      return out;
    },

    listForSession(sessionId) {
      return store.listForSession(sessionId);
    },

    forMailbox(mailbox) {
      return providers.get(mailbox?.provider || 'selfhosted') ?? providers.get('selfhosted');
    },

    markSessionActive(sessionId) {
      for (const provider of providers.values()) provider.markSessionActive?.(sessionId);
    },

    start() {
      for (const provider of providers.values()) provider.start?.();
    },

    stop() {
      for (const provider of providers.values()) provider.stop?.();
    },
  };
}