/** A fetch implementation used for every request owned by the chat hook. */
export type CodingSessionFetch = typeof globalThis.fetch;

/** Header shapes supported by AI SDK 6's HTTP chat transport. */
export type CodingSessionRequestHeaders = Record<string, string> | Headers;

export type CodingSessionResolvable<T> =
  | T
  | PromiseLike<T>
  | (() => T | PromiseLike<T>);

export type CodingSessionRequestHeadersOption = CodingSessionResolvable<
  CodingSessionRequestHeaders
>;

/** Resolve a static or lazily refreshed request option. */
export async function resolveCodingSessionRequestOption<T>(
  option: CodingSessionResolvable<T> | undefined,
): Promise<T | undefined> {
  if (typeof option === "function") {
    return Promise.resolve((option as () => T | PromiseLike<T>)());
  }

  return Promise.resolve(option);
}
