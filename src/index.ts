// Entry point: bun src/index.ts <mode...>
//   api      serve HTTP and MCP on PORT
//   worker   run every context's workers and the outbox dispatcher
//   migrate  run every context's migrations in `needs` order, then exit (unless other modes follow)
// Several modes may be given, e.g. `bun src/index.ts migrate api worker` for local runs.
import { bootKernel } from './kernel/boot';
import { loadKernelConfig } from './kernel/config';
import { ContextError } from './kernel/manifest';
import { generatedContexts } from './generated/contexts';

const MODES = ['api', 'worker', 'migrate'] as const;
type Mode = (typeof MODES)[number];

async function main(modes: Mode[]): Promise<void> {
  const config = loadKernelConfig();
  const kernel = await bootKernel({ config, contexts: generatedContexts });
  const log = kernel.log.child({ context: 'kernel' });
  if (modes.includes('migrate')) {
    const n = await kernel.migrate();
    log.info('migrations done', { applied: n });
    if (modes.length === 1) return kernel.close();
  }
  let server: ReturnType<typeof Bun.serve> | undefined;
  if (modes.includes('api')) {
    server = Bun.serve({ port: config.port, fetch: kernel.fetch });
    log.info('api listening', {
      port: server.port ?? config.port,
      contexts: kernel.contexts.length,
      routes: kernel.routes.length,
      tools: kernel.tools.length,
    });
  }
  if (modes.includes('worker')) {
    kernel.startWorkers();
    log.info('workers started', { workers: kernel.workers.length });
  }
  const stop = async () => {
    await server?.stop();
    await kernel.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

const modes = process.argv.slice(2);
if (modes.length === 0 || !modes.every((m): m is Mode => (MODES as readonly string[]).includes(m))) {
  console.error('usage: bun src/index.ts api|worker|migrate [more modes]');
  process.exit(2);
}
try {
  await main(modes as Mode[]);
} catch (e) {
  if (e instanceof ContextError) {
    console.error(`lazytax: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
