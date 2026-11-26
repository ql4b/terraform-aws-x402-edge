## <small>1.5.6 (2026-11-26)</small>

* fix: carry only the receipt declaration to settlement (restores receipt tx hash) (#26) ([0fccd03](https://github.com/ql4b/terraform-aws-x402-edge/commit/0fccd03)), closes [#26](https://github.com/ql4b/terraform-aws-x402-edge/issues/26)

## <small>1.5.5 (2026-11-26)</small>

* fix: do not forward PAYMENT-SIGNATURE to the origin after verification (#25) ([615aa89](https://github.com/ql4b/terraform-aws-x402-edge/commit/615aa89)), closes [#25](https://github.com/ql4b/terraform-aws-x402-edge/issues/25)

## <small>1.5.4 (2026-11-25)</small>

* fix: reject non-canonical request paths before route matching (#24) ([8fd658a](https://github.com/ql4b/terraform-aws-x402-edge/commit/8fd658a)), closes [#24](https://github.com/ql4b/terraform-aws-x402-edge/issues/24)

## <small>1.5.3 (2026-11-16)</small>

* docs: request-flow diagrams (overview + one per phase) (#23) ([1f1fd49](https://github.com/ql4b/terraform-aws-x402-edge/commit/1f1fd49)), closes [#23](https://github.com/ql4b/terraform-aws-x402-edge/issues/23) [#22](https://github.com/ql4b/terraform-aws-x402-edge/issues/22)

## <small>1.5.2 (2026-11-15)</small>

* fix: say so when the PAYMENT-SIGNATURE header cannot be decoded (#21) ([895f7f7](https://github.com/ql4b/terraform-aws-x402-edge/commit/895f7f7)), closes [#21](https://github.com/ql4b/terraform-aws-x402-edge/issues/21) [#20](https://github.com/ql4b/terraform-aws-x402-edge/issues/20)

## <small>1.5.1 (2026-11-15)</small>

* fix: use the same timeout for replica and home secret reads (#19) ([cb7b84f](https://github.com/ql4b/terraform-aws-x402-edge/commit/cb7b84f)), closes [#19](https://github.com/ql4b/terraform-aws-x402-edge/issues/19) [#18](https://github.com/ql4b/terraform-aws-x402-edge/issues/18)

## 1.5.0 (2026-11-15)

* docs: auto-update terraform-docs ([44ac221](https://github.com/ql4b/terraform-aws-x402-edge/commit/44ac221))
* feat: execution-region secret reads (secret_replica_reads) (#17) ([d7a56a8](https://github.com/ql4b/terraform-aws-x402-edge/commit/d7a56a8)), closes [#17](https://github.com/ql4b/terraform-aws-x402-edge/issues/17) [#15](https://github.com/ql4b/terraform-aws-x402-edge/issues/15)

## 1.4.0 (2026-11-15)

* docs: auto-update terraform-docs ([d396f08](https://github.com/ql4b/terraform-aws-x402-edge/commit/d396f08))
* feat: operator-supplied facilitator /supported (supported_json) (#16) ([97c2f8f](https://github.com/ql4b/terraform-aws-x402-edge/commit/97c2f8f)), closes [#16](https://github.com/ql4b/terraform-aws-x402-edge/issues/16) [#11](https://github.com/ql4b/terraform-aws-x402-edge/issues/11)

## 1.3.0 (2026-11-11)

* docs: auto-update terraform-docs ([34f4715](https://github.com/ql4b/terraform-aws-x402-edge/commit/34f4715))
* feat: optional Signed Offers & Receipts (offer-receipt extension), default off — v1.3.0 (#14) ([936318d](https://github.com/ql4b/terraform-aws-x402-edge/commit/936318d)), closes [#14](https://github.com/ql4b/terraform-aws-x402-edge/issues/14) [ql4b/terraform-aws-x402-edge#13](https://github.com/ql4b/terraform-aws-x402-edge/issues/13) [x402.cloudless.sh#key-1](https://github.com/x402.cloudless.sh/issues/key-1)

## <small>1.2.4 (2026-11-10)</small>

* docs: state the module's scope — retrofit, not a payment server (#12) ([0c300c2](https://github.com/ql4b/terraform-aws-x402-edge/commit/0c300c2)), closes [#12](https://github.com/ql4b/terraform-aws-x402-edge/issues/12)

## <small>1.2.3 (2026-10-20)</small>

* docs: roadmap cleanup and untrack roadmap file (#8) ([205cb7e](https://github.com/ql4b/terraform-aws-x402-edge/commit/205cb7e)), closes [#8](https://github.com/ql4b/terraform-aws-x402-edge/issues/8)

## <small>1.2.2 (2026-10-14)</small>

* docs(roadmap): mark CDP facilitator auth shipped (v1.2.0) (#7) ([c1d7e4d](https://github.com/ql4b/terraform-aws-x402-edge/commit/c1d7e4d)), closes [#7](https://github.com/ql4b/terraform-aws-x402-edge/issues/7)

## <small>1.2.1 (2026-10-12)</small>

* docs: add CDP facilitator example with Secrets Manager key (#6) ([f8de0ed](https://github.com/ql4b/terraform-aws-x402-edge/commit/f8de0ed)), closes [#6](https://github.com/ql4b/terraform-aws-x402-edge/issues/6)

## 1.2.0 (2026-10-12)

* docs: auto-update terraform-docs ([6d79de2](https://github.com/ql4b/terraform-aws-x402-edge/commit/6d79de2))
* feat: CDP facilitator auth via Secrets Manager (#5) ([33311a8](https://github.com/ql4b/terraform-aws-x402-edge/commit/33311a8)), closes [#5](https://github.com/ql4b/terraform-aws-x402-edge/issues/5) [#2](https://github.com/ql4b/terraform-aws-x402-edge/issues/2)

## <small>1.1.2 (2026-10-08)</small>

* docs(roadmap): record relationship to AWS WAF Monetize ([63284c9](https://github.com/ql4b/terraform-aws-x402-edge/commit/63284c9))

## <small>1.1.1 (2026-10-07)</small>

* docs(roadmap): mark bake_supported shipped (v1.1.0), park static-challenge, CDP auth next ([ac70f95](https://github.com/ql4b/terraform-aws-x402-edge/commit/ac70f95))

## 1.1.0 (2026-10-07)

* docs: auto-update terraform-docs ([a33e5e6](https://github.com/ql4b/terraform-aws-x402-edge/commit/a33e5e6))
* feat(cold-start): optional bake_supported to skip GET /supported at the edge (#4) ([f90b12e](https://github.com/ql4b/terraform-aws-x402-edge/commit/f90b12e)), closes [#4](https://github.com/ql4b/terraform-aws-x402-edge/issues/4)
* chore: add ROADMAP and link it from README ([578dc22](https://github.com/ql4b/terraform-aws-x402-edge/commit/578dc22))

## <small>1.0.1 (2026-10-05)</small>

* docs: auto-update terraform-docs ([9c26860](https://github.com/ql4b/terraform-aws-x402-edge/commit/9c26860))
* docs: note facilitators requiring auth are unsupported (#3) ([a3ee865](https://github.com/ql4b/terraform-aws-x402-edge/commit/a3ee865)), closes [#3](https://github.com/ql4b/terraform-aws-x402-edge/issues/3)

## 1.0.0 (2026-10-04)

* docs: auto-update terraform-docs ([2aa40f1](https://github.com/ql4b/terraform-aws-x402-edge/commit/2aa40f1))
* feat: x402 payment gate for existing CloudFront distributions (#1) ([fa492a6](https://github.com/ql4b/terraform-aws-x402-edge/commit/fa492a6)), closes [#1](https://github.com/ql4b/terraform-aws-x402-edge/issues/1)
* Initial commit ([a73bf9f](https://github.com/ql4b/terraform-aws-x402-edge/commit/a73bf9f))
