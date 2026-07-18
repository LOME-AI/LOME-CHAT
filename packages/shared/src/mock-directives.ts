import { z } from 'zod';

/**
 * The deterministic `x-mock-*` inference knobs the smart-model / multi-model
 * specs drive, carried per-request from the chat route through the run-start
 * contract to the dev/E2E mock provider. This is the CANONICAL home of the shape:
 * `@hushbox/shared` owns it so the run-start REQUEST contract (`RunContext` /
 * `FlowStartRequest` here, `RunStartBody` in `@hushbox/realtime`) and the models
 * slice's header parser all reference ONE schema — shared depends on nothing, so
 * this keeps the contract slice-import-free while staying single-source.
 *
 * The field is only ever populated in dev/E2E (the chat route reads `x-mock-*`
 * headers only when `envUtils` says so); production never sets it, and provider
 * selection additionally gates on env mode, so a crafted production body carrying
 * these directives can never reach the mock.
 */
/**
 * The wire/validation schema — the single source for {@link MockDirectives}. The
 * run-start body validates against it at the DO boundary; the models slice's
 * header parser validates its parsed headers against it too. `classifierFailure`
 * admits only `true` — a survivable-failure marker, never a meaningless `false`.
 *
 * Fields: `classifierResolution` — the model id the mock classifier emits as its
 * routing choice; `classifierFailure` — the classifier generation throws (the
 * run falls back to cheapest); `failingModels` — model ids whose generation fails
 * at the port; `classifierDelayMs` — a first-event delay on the classifier stream;
 * `holdPrimaryStream` — hold the primary inference stream open until released.
 */
export const mockDirectivesSchema = z.object({
  classifierResolution: z.string().min(1).optional(),
  classifierFailure: z.literal(true).optional(),
  failingModels: z.array(z.string().min(1)).min(1).optional(),
  classifierDelayMs: z.number().int().positive().optional(),
  holdPrimaryStream: z.boolean().optional(),
});

export type MockDirectives = z.infer<typeof mockDirectivesSchema>;
