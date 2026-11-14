// Context of the AI tool call being executed (client, MCP session, open proposal), visible to every function the
// tool calls — including store.transaction — without passing it through each service.
import { AsyncLocalStorage } from 'node:async_hooks';

export const callCtx = new AsyncLocalStorage();
export const currentCall = () => callCtx.getStore() || null;
