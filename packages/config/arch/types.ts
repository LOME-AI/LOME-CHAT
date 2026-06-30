import type { Project } from 'ts-morph';

/** A single structural-rule violation, pointing at the offending location. */
export interface ArchViolation {
  file: string;
  line: number;
  message: string;
}

/**
 * A structural architecture rule the lint layer cannot express. Rules stay
 * syntactic (no `getType()`) so the harness remains fast in CI.
 */
export interface ArchRule {
  name: string;
  check(project: Project): ArchViolation[];
}

/** A violation paired with the rule that produced it. */
export interface ArchRuleResult {
  rule: string;
  violation: ArchViolation;
}
