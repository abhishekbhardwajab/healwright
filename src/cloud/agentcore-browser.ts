import { chromium, type Browser, type BrowserContext } from 'playwright';
import { Browser as AgentCoreBrowser } from 'bedrock-agentcore/browser';
import type { BrowserLease, LeaseOptions } from '../recorder/browser.js';

/**
 * Browsers from Amazon Bedrock AgentCore Browser instead of a local Chromium.
 *
 * Every lease is its own AgentCore browser session (a separate, AWS-managed
 * microVM), so recordings and runs never share a browser process, cookies or
 * cache, and nothing runs on the studio host. The session is reached over CDP
 * with SigV4-signed WebSocket headers and is stopped when the lease closes,
 * which also stops AgentCore billing for it.
 *
 * Configuration (environment):
 *   AWS_REGION                      region of the browser (default us-west-2)
 *   AGENTCORE_BROWSER_ID            browser identifier (default aws.browser.v1, the
 *                                   AWS-managed browser; use a custom browser ID for
 *                                   session recording to S3 or VPC networking)
 *   AGENTCORE_BROWSER_TIMEOUT_S     max session length in seconds (default 3600, max 28800)
 * Credentials come from the default AWS provider chain (role, profile, env).
 */
export function agentCoreConfig() {
  const timeout = Number(process.env.AGENTCORE_BROWSER_TIMEOUT_S ?? 3600);
  return {
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-west-2',
    identifier: process.env.AGENTCORE_BROWSER_ID || 'aws.browser.v1',
    timeout: Math.min(Math.max(Number.isFinite(timeout) ? timeout : 3600, 60), 28_800),
  };
}

/** The part of the AgentCore SDK browser client used here (replaceable in tests). */
export type AgentCoreSessionClient = Pick<AgentCoreBrowser, 'startSession' | 'stopSession' | 'generateWebSocketUrl' | 'generateLiveViewUrl'>;
type ClientFactory = (cfg: ReturnType<typeof agentCoreConfig>) => AgentCoreSessionClient;

let clientFactory: ClientFactory = (cfg) => new AgentCoreBrowser({ region: cfg.region, identifier: cfg.identifier });

/** Tests only: swap the AgentCore client (e.g. for a local CDP endpoint). Returns a restore function. */
export function setAgentCoreClientFactory(f: ClientFactory): () => void {
  const prev = clientFactory;
  clientFactory = f;
  return () => { clientFactory = prev; };
}

export async function openAgentCoreContext(opts: LeaseOptions): Promise<BrowserLease> {
  const cfg = agentCoreConfig();
  const client = clientFactory(cfg);
  const session = await client.startSession({
    sessionName: (opts.label ?? 'healwright').replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 48) || 'healwright',
    timeout: cfg.timeout,
    viewport: opts.viewport,
  });

  let browser: Browser | undefined;
  let context: BrowserContext;
  try {
    const ws = await client.generateWebSocketUrl();
    browser = await chromium.connectOverCDP(ws.url, { headers: ws.headers });
    // A fresh context per lease keeps the same isolation model as local runs. If the
    // remote browser does not allow creating contexts, fall back to its default one
    // (still isolated: the whole session belongs to this lease).
    context = await browser.newContext({ viewport: opts.viewport, acceptDownloads: true })
      .catch(() => {
        const existing = browser!.contexts()[0];
        if (!existing) throw new Error('AgentCore browser session has no usable context');
        return existing;
      });
  } catch (e) {
    await browser?.close().catch(() => {});
    await client.stopSession().catch(() => {});
    throw new Error(`Could not connect to AgentCore Browser (${cfg.identifier} in ${cfg.region}): ${(e as Error).message}`);
  }

  let closed = false;
  return {
    context,
    provider: 'agentcore',
    sessionId: session.sessionId,
    liveViewUrl: () => client.generateLiveViewUrl(300),
    async close() {
      if (closed) return;
      closed = true;
      await context.close().catch(() => {});
      await browser?.close().catch(() => {});
      await client.stopSession().catch(() => {});
    },
  };
}
