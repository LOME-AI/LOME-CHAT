import type { Widget } from '@fixture/shared';

export interface WidgetPort {
  load(id: string): Widget;
}
