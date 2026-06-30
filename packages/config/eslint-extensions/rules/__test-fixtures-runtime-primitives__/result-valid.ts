// Fixture: every Result below is consumed (assigned, returned, matched,
// chained into a binding, or passed as an argument) — zero must-use-result
// findings expected. Non-Result calls in statement position stay legal.

interface Ok<T, E> {
  readonly value: T;
  isOk(): this is Ok<T, E>;
  match<U>(onOk: (value: T) => U, onErr: (error: E) => U): U;
}

interface Err<T, E> {
  readonly error: E;
  isErr(): this is Err<T, E>;
  match<U>(onOk: (value: T) => U, onErr: (error: E) => U): U;
}

type Result<T, E> = Ok<T, E> | Err<T, E>;

declare function doThing(): Result<number, string>;
declare function consume(result: Result<number, string>): void;
declare function fireAndForget(): void;
declare function startWork(): Promise<void>;

export function validCases(): Result<number, string> {
  const assigned = doThing();
  const matched = doThing().match(
    (value) => value,
    () => 0
  );
  consume(assigned);
  consume(doThing());
  fireAndForget();
  void startWork();
  if (doThing().isOk()) {
    fireAndForget();
  }
  const viaArrow = (): Result<number, string> => doThing();
  consume(viaArrow());
  fireAndForget();
  // A non-void unary consumes the value — only transparent wrappers
  // (await / optional chain / `as` / `void`) climb toward statement position.
  !doThing();
  return matched > 0 ? doThing() : assigned;
}
