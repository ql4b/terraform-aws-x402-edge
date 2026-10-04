# terraform-aws-x402-edge — maintainer steering

Usage, inputs and consumer-facing constraints live in `README.md`. This file
covers what a change to the module must not break, and how to check it.

## Invariants (each fails silently if broken)

- **Config is read at runtime.** `handler/src/config.ts` loads `config.json`
  with `readFileSync(join(__dirname, 'config.json'))`. Never switch to
  `import`/`require` of the JSON: esbuild would inline it into the bundle and
  re-couple config to the build. The loader must keep throwing on a missing or
  invalid config, never fall through to serving the origin unpaid.
- **The bundle is a committed build output.** `assets/edge/index.js` is what
  consumers deploy. Any change under `handler/` must be rebuilt
  (`cd handler && npm ci && npm run build`) and committed in the same commit.
  The bundle must contain no deployment literals.
- **No caching on paid behaviors.** `cache_policy_id` stays the managed
  `Managed-CachingDisabled` policy. Origin-request only fires on a cache miss,
  so caching a paid path is a payment bypass.
- **`payment-signature` is always forwarded.** The origin request policy's
  header list always starts with it; `forwarded_headers` only adds to it. Keep
  the policy free of the Host header (S3 + OAC origins break with it).
- **Settle only on origin success.** Origin-response settles only when the
  origin status is `< 400`; the pending-settlement header is stripped on every
  incoming request so a client cannot inject it.
- **Lambda@Edge constraints are not preferences.** us-east-1 provider (guarded
  by `terraform_data.region_guard`), `x86_64`, `publish = true` and qualified
  ARNs in outputs, trust for both `lambda` and `edgelambda`, timeout <= 30s,
  no environment variables, no layers, no VPC.
- **Node.js 22 target.** esbuild `--target=node22`; `var.runtime` rejects
  anything older. Raising the floor is a breaking change.
- **EVM `exact` only.** The handler registers `ExactEvmScheme` for `eip155:*`;
  `var.network` validation matches that. Adding a scheme or chain family means
  changing both together.
- **`extensions_json` stays a string.** A `map(object)` cannot hold extension
  objects of different shapes per route; don't "improve" it to `any`.
- **Checkov skips need a reason.** Existing skips cite a Lambda@Edge limitation
  (X-Ray, DLQ, VPC, env vars, regional concurrency) or example scope. Add new
  skips only with the same kind of justification, inline.

## Local check loop

Same gates as `.github/workflows/release.yml`:

```bash
terraform fmt -check -recursive
terraform init -backend=false && terraform validate
tflint --init && tflint
terraform test -filter=tests/unit.tftest.hcl
checkov --directory . --framework terraform --quiet --compact --skip-check CKV_TF_1
cd handler && npm ci && npm run typecheck && npm run build
```

New behavior gets a `run` in `tests/unit.tftest.hcl` (`command = plan`, mocked
providers). Validation and guard changes get an `expect_failures` run.

## Changes and releases

- PRs only; never push to `main`. Branches named by type (`feat/…`, `fix/…`,
  `docs/…`).
- Conventional Commits drive semantic-release: `feat:` minor, `fix:` / `docs:`
  / `perf:` patch, `!` or `BREAKING CHANGE:` major. No manual tags.
- CI pushes a `docs: auto-update terraform-docs` commit after merge, which
  itself cuts a patch release.
- Handler dependencies are pinned exactly in `handler/package.json`; bump them
  deliberately and rebuild the bundle.
