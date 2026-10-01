---
title: Stability before 1.0
parent: Reference
nav_order: 9
description: What may change before crypto-aio 1.0, surface by surface.
---

# Stability before 1.0

crypto-aio is pre-1.0 (`0.x`). Breaking changes can happen in a minor release, and they are
listed in the changelog. Recent changes are an example: `Transfer` became a union
with an unresolved-asset variant, `TERMINAL_STATES` became an array, and `Scanner` became a
type-only export (get a scanner from `bc.scanner()`).

| Surface | Expectation |
| --- | --- |
| Handle and container API, configuration shape, `Amount` / `Address` / asset model, error codes, event names and payloads, store ports and their contract suites | Intended to stay; changes only for real-adapter findings |
| Driver port (`ChainDriver` and its sub-ports), `Plugin`, `AdapterManifest`, `DriverContext` | **Likely to change** while real families are added. It changed recently (`ProofSource.blockHash`, `createNativeClient` returning `{ client, close? }`) and has open questions, such as how drivers get token decimals |
| Family `ext` APIs and fee override shapes | Defined by each family's adapter |
| `crypto-aio/testing` | Public and documented; the fake chain's wire protocol is not an API |
| `crypto-aio/native` | **Outside semver.** The SDK's API is the SDK's |
