import type { TokiRequest } from "./request";
import type { TokiResponse } from "./response";
import type { MaybePromise } from "./types";

/** The hook points that fire before the handler. */
export type PreHookName = "onRequest" | "preHandler";

/** Every supported hook point. */
export type HookName = PreHookName | "onResponse";

/** A pre-handler hook or middleware; returning a response short-circuits the pipeline. */
export type PreHook = (request: TokiRequest) => MaybePromise<void | TokiResponse>;

/** An `onResponse` hook; returning a response replaces the one about to be sent. */
export type ResponseHook = (
  request: TokiRequest,
  response: TokiResponse,
) => MaybePromise<void | TokiResponse>;

/** Global or group middleware. Identical in shape to a {@link PreHook}. */
export type Middleware = PreHook;

/** Maps each hook name to its function signature. */
export interface HookSignatures {
  onRequest: PreHook;
  preHandler: PreHook;
  onResponse: ResponseHook;
}

/** The hooks and middleware collected for one scope (app root or a group). */
export interface HookStore {
  onRequest: PreHook[];
  preHandler: PreHook[];
  onResponse: ResponseHook[];
  middleware: Middleware[];
}

/** Create an empty {@link HookStore}. */
export function createHookStore(): HookStore {
  return { onRequest: [], preHandler: [], onResponse: [], middleware: [] };
}

/** The hooks applying to a matched route, flattened across its scopes in execution order. */
export interface RouteHooks {
  onRequest: readonly PreHook[];
  preHandler: readonly PreHook[];
  onResponse: readonly ResponseHook[];
  middleware: readonly Middleware[];
}

/** Flatten an ordered list of scopes (outermost first) into one route's {@link RouteHooks}. */
export function composeRouteHooks(stores: readonly HookStore[]): RouteHooks {
  const onRequest: PreHook[] = [];
  const preHandler: PreHook[] = [];
  const onResponse: ResponseHook[] = [];
  const middleware: Middleware[] = [];
  for (const store of stores) {
    onRequest.push(...store.onRequest);
    middleware.push(...store.middleware);
    preHandler.push(...store.preHandler);
    onResponse.push(...store.onResponse);
  }
  return { onRequest, preHandler, onResponse, middleware };
}
