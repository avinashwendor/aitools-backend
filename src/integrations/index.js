/**
 * Integration registry — each provider exports a small adapter.
 */

import * as google from './google.js';

const providers = {
  google,
};

export function getProvider(id) {
  return providers[id] || null;
}

export function listProviders() {
  return Object.values(providers).map(p => ({
    id: p.id,
    label: p.label,
    authType: p.authType,
    configured: p.isConfigured(),
  }));
}

export default { getProvider, listProviders };
