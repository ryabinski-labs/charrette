# PRD to verified production

Production delivery is an explicit run profile. Ordinary `charrette run` remains a
review workflow; neither an open PR nor green build checks establish a deployment.

```sh
charrette run --repo /path/to/product \
  --prd /path/to/full-release-prd.md \
  --production --release product-ga-v1 \
  --prod-url https://app.example.com
```

Add `--auto-merge` only to authorize charrette to merge its validated rollup PR.
Otherwise merge it yourself; the run waits up to `delivery.mergeTimeoutMinutes`
and can continue with `charrette resume <runId>`. A timeout is `BLOCKED`, not success.
The target must be a Git repository with an initial commit and an `origin` remote.
Configure GitHub access and model credentials as described in Operations.

## Establish the release before building

The full PRD must describe required capabilities, real integrations, deployment
target and topology, operational obligations and measurable acceptance criteria.
Include relevant security and tenant isolation, durability across restart,
migrations, backup/restore, upgrade/rollback, resource/load limits, monitoring,
and support/documentation requirements. Charrette must ask about missing decisions,
not invent a threshold or label an unfinished requirement optional.

Specification runs even without interactive intake. It derives failing tests,
requirement/scenario IDs, a critical user journey and this release verification
contract:

```json
{
  "release": {
    "environment": "the actual production topology to validate",
    "deploymentChecks": ["deploy-production"],
    "productionCommand": "npm ci && npm run test:production -- --reporter=verbose",
    "productionScenarioIds": ["SC-001", "SC-002"]
  }
}
```

These fields belong to the generated RunSpec, not `charrette.config.json`. The
production command and scenario IDs must match the repository's actual test runner.
Every required requirement needs a behavioral acceptance scenario checked in
production; unresolved required questions and `notCovered` gaps block the contract.
Without an attached operator, questions stay unanswered; an agent cannot answer
on their behalf. Review the full
specification with the plan. A stable `--release` ID freezes the PRD digest and
specification in SQLite across runs. Follow-up runs use the same complete PRD;
an intentional scope change needs a new release ID, not a narrower retry task.

## What completion requires

1. A real working skeleton passes its live critical-path exercise before other
   feature work is released to workers.
2. Required scenarios have owners and pass the acceptance suite. Cancelled work
   is not shipped; one merged scenario does not cover a requirement's other
   required scenarios. Empty/skipped selections and blocked required scenarios
   cannot produce green acceptance.
3. Intent and final live checks pass. Frozen requirements cannot be waived by a
   general “continue” response or automatic criterion amendment.
4. The release PR merges. Automatic merge checks the exact tested head SHA and
   uses GitHub's SHA-bound merge API; branch protection/reviews still apply.
5. All named deployment job checks succeed on the merged SHA. A build alone,
   missing job, skipped deployment, timeout or unavailable check is not success.
6. The target serves `{"revision":"<full merged Git SHA>"}` at
   `/.well-known/charrette-release` (configurable with `delivery.revisionPath`).
   Inject the actual revision during deployment; never hard-code it. Charrette
   checks the response itself and rejects redirects or a different revision.
7. From a clean checkout of that merged commit, the frozen production command
   runs against `CHARRETTE_PROD_URL`, with `CHARRETTE_DEPLOY_SHA` and
   `CHARRETTE_PROD_TEST_SCOPE` provided. It must report an explicit passing result
   for each production scenario ID and exit zero. Use verbose/TAP output when
   your runner otherwise hides individual test names.
8. An independent production agent supplies a concrete live observation for
   each required production scenario. Unknown, inaccessible or unauthorized
   checks prevent success. Charrette rechecks the deployed revision before DONE.

The controller records `run.release_evidence` phases and a manifest under
`.charrette/<runId>/release/<mergedSHA>/evidence.json`. Keep the database and manifest
with the release record. Pit-crew reads persistent latest verdicts and does not
end a production watch at PR review, a blocked gate or unverified deployment.

## Deployment and test authority

Use the operator's established target and deployment credentials, preferably
scoped CI credentials. Production mode can build the deployment workflow but does
not authorize opening accounts, purchasing infrastructure or destroying resources.
Missing access is a blocker. Plan approval and environment approvals remain in place.

Production checks are read-only by default. To test workflows that create data,
explicitly name an isolated account/tenant/namespace:

```sh
charrette run --prd full-release-prd.md --production --release product-ga-v1 \
  --prod-url https://app.example.com --auto-merge \
  --prod-test-scope 'Only the pre-created charrette-e2e test tenant; synthetic records'
```

This does not authorize real payments, real outbound messages, real customer-data
changes, load tests against customer traffic, or infrastructure destruction.
Restart/load/recovery checks need an explicitly approved isolated environment.
Supply test credentials through the established environment, not in PRD text or URLs.
These are orchestration policy checks, not an OS/network sandbox: review generated
commands and enforce least privilege outside the agent too.

## Failures and continuation

Reproducible deployment and production-suite failures become bounded repository
repair tasks (`delivery.fixRounds`, default 2), then pass through QA, PR and another
deployment. Exhausted repairs or unknown evidence leave a named `BLOCKED` reason.
An independent agent's incomplete review also blocks; it cannot be waved through.
Resume rechecks the same release after the operator resolves access, approval or
other prerequisites. Changing the destination of an existing production run is
refused; start a new run with the intended destination.

Relevant `charrette.config.json` settings:

```json
{
  "prodUrl": "https://app.example.com",
  "delivery": {
    "mode": "production",
    "releaseId": "product-ga-v1",
    "merge": "manual",
    "mergeTimeoutMinutes": 60,
    "validationTimeoutMinutes": 30,
    "fixRounds": 2
  },
  "spec": { "requireExecutionEvidence": true }
}
```

No charrette can guarantee that an arbitrary PRD is feasible or that passing tests
prove every possible behavior. This profile makes success conditional on the
agreed, observable release contract. It must report missing evidence and blockers,
not turn budget exhaustion, unknowns or reduced scope into a GA claim.
