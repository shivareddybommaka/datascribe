import type { Options } from 'tsup';

/**
 * Bundle for the Node services (api, worker) so `node dist/<entry>.js` runs without tsx (D-116).
 * The workspace packages ship TypeScript source, so they are inlined. Every npm package stays
 * external (CommonJS packages break inside an ESM bundle), including the ones only a workspace
 * package depends on, so the runtime needs a hoisted node_modules (the Dockerfiles install one).
 * The Prisma client is generated CommonJS that finds its engine next to itself, so it stays
 * external too and loads through `@datascribe/db/client`.
 */
export function nodeService(entry: string): Options {
  return {
    entry: [entry],
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    noExternal: [/^@datascribe\//],
    esbuildPlugins: [
      {
        name: 'npm-and-prisma-external',
        setup(build) {
          build.onResolve({ filter: /generated\/client\/index\.js$/ }, () => ({
            path: '@datascribe/db/client',
            external: true,
          }));
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('@datascribe/') ? undefined : { path: args.path, external: true },
          );
        },
      },
    ],
  };
}
