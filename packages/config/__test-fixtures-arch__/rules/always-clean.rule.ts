import type { ArchRule } from '../../arch/types.js';

const rule: ArchRule = {
  name: 'always-clean',
  check() {
    return [];
  },
};

export default rule;
