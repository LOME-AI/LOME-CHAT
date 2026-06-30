import type { ArchRule } from '../../arch/types.js';

const rule: ArchRule = {
  name: 'flag-marker-classes',
  check(project) {
    const violations = [];
    for (const sourceFile of project.getSourceFiles()) {
      for (const classDeclaration of sourceFile.getClasses()) {
        if (classDeclaration.getName()?.includes('Marker')) {
          violations.push({
            file: sourceFile.getFilePath().replace(/^\//, ''),
            line: classDeclaration.getStartLineNumber(),
            message: 'class name contains Marker',
          });
        }
      }
    }
    return violations;
  },
};

export default rule;
