/** Example port: the interface domain code depends on instead of infra. */
export interface Clock {
  now(): Date;
}
