# Windows FK v3 candidate

This is an explicit opt-in candidate. It does not activate CURRENT, certify the observed client's patch/realm, or establish China-only content. Missing target keys remain unverified regional/version differences. The only shared-table interpretation is `community-reader-language-fallback/v1`, based on pinned PyPoE `RelationalReader.__getitem__`, exact SC absence evidence and the same observed index. `official_client_semantics_verified` remains false.

## Files and consumer contract

`catalog.zip` contains the exact `catalog.json`, `verification.json`, `request.json` and `manifest.json`. Check `inventory.json`, then every extracted member's exact size and SHA-256. `catalog.json` is the query/compiler-facing projection. `verification.json` is a compile-time evidence sidecar, not a player download or workbench entry field. It contains complete three-sided physical table inputs and shared completed closure witnesses, once per artifact. Complete original wire receipts remain pinned in the source archive; they are not interpreted as FK scalar values.

The formats are `poe2-native-catalog/v3`, `poe2-native-catalog-manifest/v3`, and `poe2-native-catalog-request/v3`. Policy: `stable-key-pinned-fk-structure/v1`.

```js
const lookup = createCatalogLookup(catalog, {
  game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN',
  verification: verificationBytes, // exact Buffer; size/hash checked internally
});
const answer = lookup({ table, field, id, english });
```

The function still has two arguments and returns the same query function. **v3 requires the sidecar**; a version guard alone is insufficient. The library checks sidecar bytes/SHA, independently rebuilds strict-v2 comparisons and every selected FK reachable closure, and compares the result with both full sidecar witnesses and the catalog binding projection. Missing or corrupt evidence rejects before any lookup. v1/v2 callers and strict applicability semantics are unchanged. The module closure now contains six files, including `src/native-catalog-fk-binding.mjs`; exact hashes are in the manifest. This transitive dependency must be included when copying the library, including callers that also load v1/v2 catalogs.

Do not put `verification.json` or the complete source archive into each workbench entry, curated overlay, or runtime locale pack. Load and validate once in the trusted compilation step, then project the actual runtime fields required by that consumer. A thinner runtime format needs its own pinned producer and explicit contract; this artifact does not silently replace full validation with a trusted accepted flag.

## Scope and cycle semantics

Only the declared BaseItemTypes, Mods, Characters, AlternateQualityTypes and three dependency edges are normalized. Key3 is schema-declared ItemVisualIdentity at physical column 65. All other physical scalar/unknown/reference fields stay strict. Ordered arrays retain their order, multiplicity, nulls and original row pointers. Default-to-target closure nodes also compare English display fields; default-to-SC excludes only the fixed 18 display fields. Source/default comparison is equally complete.

Visited pairs only deduplicate expansion within one closure traversal. There is no global success cache or in-progress accepted cache. All reachable node scalar/English/ordered-edge constraints must finish before a root can be accepted. Completed witnesses carry comparison role, exact package/payload pins and row addresses. Shared closure hashes avoid repeating full physical rows per primary record. A deep failure is independently rediscovered for every referencing root.

## Replay

Use the same pinned Windows source candidate and fixed original English targets from the source handoff. Rewrite only local absolute paths in the request and record its new hash. No client/network access is needed.

```text
node --max-old-space-size=12288 src/native-catalog.mjs --config REQUEST --out .cache/fresh-v3
node --max-old-space-size=12288 handoff/windows-fk-20261101/validate.mjs .cache/fresh-v3 REPORT
node --test test/native-catalog-fk.test.mjs test/native-catalog-v2.test.mjs test/native-catalog.test.mjs test/native-names.test.mjs
```

`validation.json` records actual full-query checks, negative pin/namespace/column tests, runtime/memory, and component byte accounting. `replay.json` records byte-identical fresh A/B output. `inventory.json` seals archive members and compressed archive sizes. No package installation is required. The user-owned workbench, CLI, package metadata and README outside this handoff directory were not changed.
