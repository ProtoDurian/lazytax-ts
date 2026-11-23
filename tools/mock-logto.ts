// `bun run mock-logto`: a local Logto stand-in for manual runs and Bruno.
//
//   bun tools/mock-logto.ts [--port 9301] [--audience lazytax-api]
//   curl -s -XPOST localhost:9301/token -d '{"sub":"u1","scope":"admin"}'
//
// It serves GET /jwks and POST /token (any sub and scope). Point the app at it with
// AUTH_ISSUER=http://127.0.0.1:9301 (the default). No real Logto, no secrets.
import { startMockLogto } from '../src/kernel/testing/mock-logto';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const logto = await startMockLogto({ port: Number(arg('--port') ?? 9301), audience: arg('--audience') });
console.log(
  JSON.stringify({
    msg: 'mock logto listening',
    issuer: logto.issuer,
    jwksUrl: logto.jwksUrl,
    audience: logto.audience,
  }),
);
const stop = async () => {
  await logto.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
