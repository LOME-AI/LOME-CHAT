// Fixture: every statement below discards a Result/ResultAsync and must be
// flagged by must-use-result. Types are declared locally with neverthrow's
// exact shape and names — the rule matches on type symbol names, so these
// stand in for the real package (unresolvable from this package).

interface Ok<T, E> {
  readonly value: T;
  isOk(): this is Ok<T, E>;
  map<U>(fn: (value: T) => U): Result<U, E>;
}

interface Err<T, E> {
  readonly error: E;
  isErr(): this is Err<T, E>;
  map<U>(fn: (value: T) => U): Result<U, E>;
}

type Result<T, E> = Ok<T, E> | Err<T, E>;

declare class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  then<A, B>(
    onfulfilled?: ((value: Result<T, E>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null
  ): PromiseLike<A | B>;
  map<U>(fn: (value: T) => U): ResultAsync<U, E>;
}

declare function doThing(): Result<number, string>;
declare function doAsyncThing(): ResultAsync<number, string>;
// Union with a non-Result member: the rule must still recognize the Ok arm.
declare function maybeThing(): Ok<number, string> | undefined;
declare function fireAndForget(): void;

export async function invalidCases(): Promise<void> {
  doThing();
  await doAsyncThing();
  doAsyncThing();
  doThing().map((n) => n + 1);
  void doThing();
  (doThing(), fireAndForget());
  (fireAndForget(), doThing());
  maybeThing();
}
