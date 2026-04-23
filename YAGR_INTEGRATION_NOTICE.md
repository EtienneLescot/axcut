# Yagr Integration Notice For Axcut

## Purpose

This notice explains why Yagr is split into many small packages internally while Axcut should usually consume only a small number of higher-level facade packages.

## Short Version

Yagr now has two layers:

1. **Internal granular packages**
2. **Product-facing facade packages**

Axcut should prefer the facades.

## Why The Granularity Exists

The small packages exist for Yagr itself.

They help with:
- dependency boundaries
- testability
- plugin isolation
- long-term refactoring safety
- keeping core runtime concerns separate from product/plugin concerns

Examples of these lower-level packages:
- `@yagr/deepagent-bootstrap`
- `@yagr/provider-runtime`
- `@yagr/session-checkpoint`
- `@yagr/runtime-events`
- `@yagr/stream-adapter`
- `@yagr/conversation-core`
- `@yagr/session-memory`

These are good architectural seams inside Yagr, but they are too granular for most downstream products.

## Why Axcut Should Not Depend On Everything Directly

If Axcut imports many tiny Yagr packages directly:
- integration becomes noisy
- versioning becomes fragile
- Yagr internal refactors leak into Axcut
- Axcut gets coupled to Yagr internals instead of Yagr platform contracts

That is exactly what the facade layer is meant to avoid.

## Recommended Consumption Model For Axcut

Axcut should primarily consume:

- `@yagr/runtime`
- `@yagr/surfaces`
- `@yagr/plugin-runtime` only if Axcut eventually needs plugin registration directly

### `@yagr/runtime`

This is the preferred runtime entrypoint for products.

It aggregates the runtime/platform layer:
- bootstrap
- provider runtime
- session service
- runtime events
- stream adapter
- conversation service

### `@yagr/surfaces`

This is the preferred UI/surface entrypoint.

It aggregates:
- WebUI surface primitives
- TUI surface primitives

## Public vs Internal Mindset

### Public/product-facing

These are the intended stable consumption points:
- `@yagr/runtime`
- `@yagr/surfaces`
- `@yagr/plugin-runtime`
- later: selected plugin packages such as `@yagr/plugin-n8n-manager`

### Internal/workspace-level

These should be treated as Yagr internals unless there is a strong reason otherwise:
- `@yagr/deepagent-bootstrap`
- `@yagr/provider-runtime`
- `@yagr/session-checkpoint`
- `@yagr/session-service`
- `@yagr/runtime-events`
- `@yagr/stream-adapter`
- `@yagr/conversation-core`
- `@yagr/conversation-service`
- `@yagr/gateway-core`
- `@yagr/webui-surface`
- `@yagr/tui-surface`
- `@yagr/webui-session-registry`
- `@yagr/session-memory`

They may be reusable, but Axcut should not depend on their exact shape unless there is a very specific integration need.

## Plugin Direction

Yagr core is moving toward:
- core runtime packages
- plugin packages
- app compositions

That means manager-specific logic should progressively move behind:
- `@yagr/plugin-n8n-manager`

For Axcut, this matters because it clarifies that Axcut should consume Yagr as a platform, not as the current Yagr app.

## Practical Rule For Axcut Integrators

When adding or updating a Yagr dependency in Axcut:

1. ask whether the need is runtime/platform-level or Yagr-internal
2. prefer `@yagr/runtime` first
3. prefer `@yagr/surfaces` second
4. only depend on lower-level packages if the facade is genuinely insufficient
5. avoid depending on manager-specific plugin packages unless Axcut explicitly needs that domain behavior

## Current Recommendation

For Axcut today:
- use Yagr facades as the default integration surface
- avoid spreading raw low-level Yagr imports across the Axcut codebase
- keep Axcut-specific domain logic in Axcut:
  - `.axcut` schema
  - timeline/document semantics
  - media/export pipeline
  - Axcut-specific editing tools

## Summary

The package split is intentionally more granular than what Axcut should consume.

That is not over-engineering for Axcut.
That is internal modularity for Yagr.

The right integration model is:
- **fine-grained internals inside Yagr**
- **coarse-grained facades for products like Axcut**
