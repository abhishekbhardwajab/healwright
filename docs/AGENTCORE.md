# healwright on Amazon Bedrock AgentCore

This document covers how healwright runs on AWS as a **multi-tenant SaaS**: what is built, how to deploy it, what it costs, and what is still needed before taking paying customers.

## 1. Architecture

```
                    tenants (browser)                         CI pipelines (per-tenant API key)
                          │                                              │
                          ▼                                              ▼
            ┌──────────────────────────────┐            ┌────────────────────────────┐
            │ Studio + control plane       │◀───────────│ healwright API (same app)  │
            │ ECS Fargate behind ALB + WAF │            └────────────────────────────┘
            │ sign-in, tenants, tests,     │
            │ billing, recording UI        │
            └──────┬───────────────┬───────┘
                   │ SigV4          │ SigV4 (InvokeAgentRuntime,
                   │ (recording)    │  session id = <tenant>-run-<uuid>)
                   ▼                ▼
   ┌───────────────────────┐   ┌───────────────────────────────┐
   │ AgentCore Browser     │◀──│ AgentCore Runtime             │
   │ one microVM per       │   │ healwright worker (ARM64)     │
   │ recording / run       │   │ POST /invocations = one run   │
   └───────────────────────┘   │ GET /ping, EMF usage records  │
                               └──────────────┬────────────────┘
                                              │ SigV4 (bedrock-mantle)
                                              ▼
                               ┌───────────────────────────────┐
                               │ Amazon Bedrock: Claude        │
                               │ anthropic.claude-opus-5-5     │
                               └───────────────────────────────┘
```

| Piece | AWS service | Status in this repo |
|---|---|---|
| Browsers for recording and replay | **AgentCore Browser** (`aws.browser.v1` or a custom browser) | Built: `BROWSER_PROVIDER=agentcore` (`src/cloud/agentcore-browser.ts`) |
| Test runs (CI, schedules, "Run" button) | **AgentCore Runtime** | Built: `src/agentcore/runtime.ts`, `Dockerfile.agentcore`, `deploy/agentcore/` |
| AI healing and prompt editing | **Amazon Bedrock** (Claude via the Messages API endpoint) | Built: `AI_PROVIDER=bedrock` (`src/ai/claude.ts`) |
| Per-tenant metering | CloudWatch Embedded Metric Format | Built: one usage record per run, `Healwright` namespace, `TenantId` dimension |
| Studio UI + control plane | ECS Fargate (or App Runner) | **Not yet multi-tenant**, see section 5 |

Why the studio is not on AgentCore Runtime: Runtime only accepts calls signed with AWS credentials (SigV4) or an OAuth bearer token, on `/invocations` and `/ws`, with frames capped at 32 KB. That suits a headless worker, not a web app that people open in a browser. So the studio stays a normal container, and everything heavy (browsers, runs, Claude) moves to managed, per-second services.

### Tenant isolation

- **Browsers:** every recording session and every run gets its **own** AgentCore Browser session (dedicated microVM, terminated and memory-sanitised afterwards). Nothing is shared between tenants, or between two runs of the same tenant.
- **Runs:** the control plane uses a runtime session id that starts with the tenant id and is new for every run (`tenantSessionId()` in `src/agentcore/invoke.ts`), so two tenants never share a worker microVM.
- **Who can invoke:** only the control plane's IAM role gets `bedrock-agentcore:InvokeAgentRuntime` (`deploy/agentcore/control-plane-invoke-policy.json`). Tenants never call the runtime directly, so they cannot pick another tenant's id.
- **Tenant id:** sent by the control plane in the payload (`tenantId`) or the `X-Amzn-Bedrock-AgentCore-Runtime-Custom-Tenant-Id` header (allow-listed by the deploy script). The worker rejects runs without a valid tenant (`REQUIRE_TENANT=true`).
- **Network:** the security hardening from PR #2 still applies inside the worker: only `http(s)` URLs can be opened. With AgentCore Browser the browser also no longer runs on our own network, which removes the "test reaches internal services" risk for the SaaS.
- **Secrets:** a run's secret test values (`TEST_*`) travel in the signed invocation and live only in that run's memory; they are masked in logs and never written to disk. For the SaaS they should come from a per-tenant AWS Secrets Manager path resolved by the control plane (section 5).

## 2. Running it

### Locally against real AWS (studio with AgentCore browsers and Bedrock)

```bash
export AWS_REGION=us-west-2           # AWS credentials from your profile / SSO
BROWSER_PROVIDER=agentcore AI_PROVIDER=bedrock npm start
```

Every recording and run then opens an AgentCore Browser session (the run log says `Running in AgentCore Browser session …`). The "Live window" option is off in this mode: the browser runs on AWS. AgentCore's own live view (`liveViewUrl()` on the lease) is the future replacement.

### Deploying the worker to AgentCore Runtime

```bash
REGION=us-west-2 ./deploy/agentcore/deploy.sh
```

The script builds `Dockerfile.agentcore` for `linux/arm64` (Runtime requirement), pushes it to ECR, creates the execution role (`trust-policy.json` + `execution-role-policy.json`: AgentCore Browser sessions, `bedrock-mantle:CreateInference` for the two Claude models, logs) and creates or updates the runtime with `PUBLIC` networking, HTTP protocol, a 5-minute idle timeout and the tenant header allow-listed.

Before the first deploy, enable access to Claude Opus 5.5 (and the fallback model, Claude Opus 4.8) in the Bedrock console for the region.

Run a test exported from the studio:

```bash
AGENTCORE_RUNTIME_ARN=arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/healwright_worker-abc \
  npx tsx src/agentcore/invoke.ts --tenant acme --test ./signin.json
# exit code 0 = passed, 1 = failed: drop it into any CI system
```

### Worker contract

`POST /invocations`

```json
{ "action": "run", "tenantId": "acme", "test": { "...": "TestCase as exported by the studio" },
  "options": { "aiHealing": "suggest", "stepTimeoutMs": 10000 }, "secrets": { "TEST_PASSWORD": "…" } }
```

Returns `{ execution, usage }`. `execution` is the same shape the studio shows (step results, logs, AI heal proposals); failed steps carry their screenshot inline as `screenshotPng` (base64). `usage` is the metering record. Send `"stream": true` or `Accept: text/event-stream` to get `update` events while it runs and a final `result` event. `GET /ping` answers `Healthy`, or `HealthyBusy` while a run is in progress so AgentCore keeps the session alive.

## 3. Cost model

AWS list prices used (AgentCore pricing page, November 2026; Runtime v1 rates):

| Item | Price |
|---|---|
| AgentCore Browser CPU / memory | $0.0895 per vCPU-hour, $0.00945 per GB-hour; per second, CPU billed only when active |
| AgentCore Runtime CPU / memory | $0.0895 per vCPU-hour, $0.00945 per GB-hour (v2 microVMs: $0.1276 and $0.0169) |
| AgentCore Identity | free when used through Runtime |
| Claude on Bedrock | Bedrock's Anthropic pricing for the region (check the Bedrock pricing page; Claude API list price for Opus 5.5 is $4 / $20 per million input / output tokens) |

Estimated cost of one typical run (2 minutes, 1 vCPU browser at ~50% busy, 2 GB; worker mostly waiting on I/O):

| Part | Cost per run |
|---|---|
| Browser | ≈ $0.0015 CPU + $0.0006 memory |
| Worker | ≈ $0.0005 |
| **Infrastructure total** | **≈ $0.003** |
| One AI heal (≈ 6k input, 1.5k output tokens on Opus 5.5) | ≈ $0.05, only when a locator breaks |
| One AI prompt edit | ≈ $0.05 to $0.10 |

So 1,000 runs a day cost about **$3 to $4 a day** in compute. Claude is the main variable cost, and it scales with *breakage*, not with run volume. Healed locators are saved back to the test (accept or `auto` mode), so a heal is paid for once, not on every run. These are estimates from list prices, not measurements: the `Healwright` metrics (`RunSeconds`, `AiInputTokens`, `AiOutputTokens` per tenant) give real numbers after the first week in production.

### Pricing it (proposal)

| Plan | Price | Includes | Our cost at full use |
|---|---|---|---|
| Free | $0 | 1 user, 300 run-minutes, 20 AI heals / month | ≈ $1.50 |
| Team | $49 per user / month | 2,000 run-minutes, 200 AI heals / user | ≈ $13 → ~73% gross margin |
| Business | $99 per user / month | 6,000 run-minutes, 600 AI heals, SSO, longer retention | ≈ $39 → ~60% |
| Overage | $0.02 per run-minute, $0.25 per AI heal | | ≈13x and 5x markup |

Compared with self-hosting Playwright grids, the pitch is "no infrastructure, tests repair themselves, and you only pay for minutes you run". The per-second billing and scale-to-zero of AgentCore mean idle tenants cost almost nothing, which is what makes a generous free tier affordable.

## 4. Limits to plan around

- **500 concurrent sessions per browser** (AgentCore Browser). Above that, spread tenants over several custom browsers, or ask AWS for a quota increase. The control plane should also cap concurrent runs per tenant (fairness and abuse).
- **Browser session length:** default 15 minutes, max 8 hours; healwright asks for 1 hour (`AGENTCORE_BROWSER_TIMEOUT_S`).
- **Runtime:** ARM64 only; WebSocket frames 32 KB. Long suites should stream (`"stream": true`) or be split into one invocation per test, which also parallelises them.
- **AgentCore keeps browser session data for 30 days** (its retention policy). Mention it in the SaaS privacy terms.
- **File uploads/downloads in tests:** with a remote browser, Playwright streams uploads over the connection; downloads land on the remote browser. Both work with `connectOverCDP` in principle but are **not yet verified against AgentCore**.
- **Not run against real AWS yet.** The worker contract, the browser provider (through a local CDP endpoint standing in for AgentCore) and Bedrock request signing are covered by `tests/agentcore.spec.ts`; the first deploy is the real test. The IAM `bedrock-mantle:Model` condition uses the model id prefixes; loosen it if Bedrock reports the model differently.

## 5. What the SaaS still needs (roadmap)

In order of what blocks the first paying customer:

1. **Sign-in and tenants.** Amazon Cognito user pools (email + Google/Microsoft SSO), one tenant per organisation; every studio API call scoped to the caller's tenant. AgentCore Identity can later hold per-tenant OAuth tokens for apps under test.
2. **Tenant-aware storage.** Replace the JSON store with the PostgreSQL schema already designed in `docs/schema.sql` (Aurora Serverless v2), with `tenant_id` on every table and row-level security; screenshots and artifacts in S3 under `s3://…/<tenant>/`.
3. **Secrets per tenant** in AWS Secrets Manager (`healwright/<tenant>/…`), resolved by the control plane at run time, never stored with tests.
4. **Studio on ECS Fargate** behind an ALB with WAF and TLS, `HOST=0.0.0.0`, `STUDIO_TOKEN` replaced by Cognito sessions, `ALLOWED_HOSTS` set to the public domain.
5. **Billing.** Stripe (self-serve plans) fed from the `Healwright` CloudWatch metrics, or an AWS Marketplace SaaS listing later for enterprise buyers who want it on their AWS bill.
6. **Quotas and fairness:** per-tenant concurrency and monthly run-minute limits enforced in the control plane before invoking the runtime.
7. **CI integrations:** a GitHub Action and a CLI wrapping `invoke.ts` with per-tenant API keys.
8. **Session recording and live view:** a custom AgentCore browser with S3 recording for "watch the failed run" and live view in the studio.

## Sources

- AgentCore Browser: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html>, <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-resource-session-management.html>
- Runtime HTTP contract: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html>
- Runtime WebSocket: <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html>
- Pricing: <https://aws.amazon.com/bedrock/agentcore/pricing/>
- Bedrock Mantle IAM actions: <https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-mantle.md>
- TypeScript SDK: npm `bedrock-agentcore` (browser + Playwright), `@aws-sdk/client-bedrock-agentcore`, `@anthropic-ai/bedrock-sdk`
