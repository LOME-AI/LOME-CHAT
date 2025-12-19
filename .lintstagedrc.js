export default {
  '*.{ts,tsx,js,jsx,mjs,cjs}': ['eslint --fix', 'prettier --write'],
  '*.{json,md,yaml,yml,css}': ['prettier --write'],
  'package.json': ['prettier --write'],
};
