import { EventEmitter } from 'node:events';

/**
 * Global event bus. Main events:
 *  - 'project:changed' (project, meta)    - 'project:opened' / 'project:closed'
 *  - 'jobs:update' (job)                  - 'ai:activity' (entry)   - 'ai:sessions' (list)
 *  - 'toast' ({level, message})           - 'player:command' ({cmd, ...})
 */
export const bus = new EventEmitter();
bus.setMaxListeners(100);
