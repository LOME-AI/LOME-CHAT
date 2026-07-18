import { Config } from '@remotion/cli/config';

// The ads root is the public dir so `staticFile('<campaign>/...')` resolves the
// generated shots, captures, and voiceover in place — assets live in their
// numbered campaign folders, not a copied public/ tree.
Config.setPublicDir('.');
Config.setVideoImageFormat('jpeg');
Config.setEntryPoint('./src/index.ts');

// The toolkit uses ESM-style `.js` import specifiers that resolve to `.ts`/
// `.tsx` on disk (tsgo handles this natively; Remotion's webpack bundler does
// not). extensionAlias teaches the bundler the same mapping.
Config.overrideWebpackConfig((current) => ({
  ...current,
  resolve: {
    ...current.resolve,
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
      ...current.resolve?.extensionAlias,
    },
  },
}));
