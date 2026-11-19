/**
 * Control-plane side: run a test on the healwright AgentCore Runtime worker.
 *
 *   AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:... \
 *     npx tsx src/agentcore/invoke.ts --tenant acme --test ./my-test.json
 *
 * --test takes a test exported from the studio (GET /api/tests/:id). Secrets for the
 * test are read from TEST_* environment variables and sent with the run.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import type { ExecutionOptions, TestCase } from '../model/actions.js';

export interface InvokeRunInput {
  runtimeArn: string;
  tenantId: string;
  test: TestCase;
  options?: ExecutionOptions;
  secrets?: Record<string, string>;
  region?: string;
  client?: BedrockAgentCoreClient;
}

/**
 * Runtime session ids start with the tenant id, so AgentCore never puts two tenants'
 * runs in the same microVM. Each run gets a fresh session (ids must be >= 33 chars).
 */
export function tenantSessionId(tenantId: string): string {
  return `${tenantId}-run-${randomUUID()}`;
}

export async function invokeRun(input: InvokeRunInput): Promise<unknown> {
  const client = input.client ?? new BedrockAgentCoreClient({ region: input.region ?? process.env.AWS_REGION });
  const out = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: input.runtimeArn,
    runtimeSessionId: tenantSessionId(input.tenantId),
    runtimeUserId: input.tenantId,
    contentType: 'application/json',
    accept: 'application/json',
    payload: new TextEncoder().encode(JSON.stringify({
      action: 'run', tenantId: input.tenantId, test: input.test, options: input.options, secrets: input.secrets,
    })),
  }));
  const text = await out.response?.transformToString();
  return text ? JSON.parse(text) : undefined;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('agentcore', 'invoke.ts'));
if (isMain) {
  const runtimeArn = arg('arn') ?? process.env.AGENTCORE_RUNTIME_ARN;
  const tenantId = arg('tenant') ?? process.env.TENANT_ID;
  const testFile = arg('test');
  if (!runtimeArn || !tenantId || !testFile) {
    console.error('usage: invoke.ts --tenant <id> --test <test.json> [--arn <runtime arn>]');
    process.exit(2);
  }
  const test = JSON.parse(readFileSync(testFile, 'utf8')) as TestCase;
  const secrets = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k.startsWith('TEST_') && v !== undefined)) as Record<string, string>;
  invokeRun({ runtimeArn, tenantId, test, secrets }).then((r) => {
    const res = r as { execution?: { status?: string } };
    console.log(JSON.stringify(r, null, 2));
    process.exit(res?.execution?.status === 'passed' ? 0 : 1);
  }).catch((e) => { console.error(e); process.exit(1); });
}
