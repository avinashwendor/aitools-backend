/**
 * Tiny in-process event bus.
 *
 * Lets the data layer announce changes (a tool was created/edited/removed)
 * without importing the caches that care about them — which would otherwise
 * create an import cycle between models and the AI catalog.
 */

import { EventEmitter } from 'events';

export const bus = new EventEmitter();
bus.setMaxListeners(25);

export const EVENTS = {
  TOOL_CHANGED: 'tool:changed',
  /** An admin repointed a role at a different model — routing must reload. */
  MODEL_ROUTING_CHANGED: 'modelRouting:changed',
};

export default bus;
