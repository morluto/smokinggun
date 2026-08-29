# SmokingGun authority architecture

SmokingGun produces evidence about source and imports evidence produced by external benchmark tools. A protocol document describes that evidence; it does not create the authority or proof that the document claims. Every trusted field must therefore be derived by the module that captured, scoped, or verified the corresponding input.

## Core invariants

### 1. Evidence consumes immutable inputs

Source and imported artifacts are captured as exact bytes before derivation. Their identities are content digests over a canonical manifest or the exact retained bytes. Paths and Git revisions are annotations, never content identity.

Text decoders are strict and fail closed: malformed UTF-8 is reported as unavailable evidence rather than replaced with U+FFFD and analyzed as different content. Binary inputs remain bytes until the decoder for their declared format consumes them.

A producer that cannot capture an input within declared bounds returns visible incomplete evidence. It does not continue from a mutable pathname and later attach an unrelated digest.

### 2. The host owns scope and producer identity

The scan plan defines one canonical target set. Built-in scanners consume that plan. The host stamps producer identity, reconciles every result with the target set, and derives coverage from its target ledger.

Imported identity, coverage, policy, and digest fields are untrusted claims until the host binds them to retained bytes. Out-of-scope or unverifiable evidence cannot become complete coverage or policy evidence.

### 3. Imports do not acquire producer authority

Benchmark and measurement documents may declare runtime, input, and behavior metadata. SmokingGun preserves those declarations as producer claims and only promotes comparisons when both artifacts positively bind the shared input set, executable, environment, and behavior evidence.

### 4. Promotion requires positive proof

Missing evidence is distinct from an observed empty set. Comparison and promotion consume positively established bindings for benchmark identity, shared inputs, executable, environment, isolation, behavior, and outputs. If any required binding is absent or incompatible, the result is inconclusive or blocked.

Static candidates, theoretical estimates, measurements, and behavior checks remain separate evidence classes. Finite observations do not acquire an asymptotic model label unless the declared model-selection requirements are satisfied.

### 5. Durable state is immutable and parent-linked

Stored objects are created exclusively under the digest of their exact bytes and verified when that digest path already exists. Investigation updates are immutable commits that name their parent digest. A mutable investigation head advances only when its current value equals the caller's expected parent.

Atomic replacement prevents torn files; it is not compare-and-swap and does not prevent lost updates.

## Ownership map

```text
CLI / protocol boundaries
  parse unknown input and render typed outcomes
             |
             v
source capture -----> immutable source snapshot
             |          exact bytes + visible omissions
             v
scan service ------> host-derived findings and coverage
             |
             v
content store -----> immutable report/evidence objects
             |
             v
investigation store
  parent-linked commits + guarded head updates

external benchmark tool --> immutable measurement artifact --> import/compare
```

`src/protocol` owns external document shapes. Domain and service modules do not treat those DTOs as operational proof. Trusted domain values are constructed only by the module that captures bytes, enforces scope, applies a capability, or commits state.

SmokingGun is the product, executable, protocol namespace, scanner namespace, and finding-ID prefix.

## Feature boundary

New scanners, import formats, measurement models, and investigation states must preserve these invariants end to end. A feature that cannot establish its claimed boundary is removed or reported as unavailable rather than preserved through compatibility logic.

The authoritative scan path ends at content-addressed reports. Structural, TypeScript, and Python scanners consume captured text. SmokingGun owns no workload runner, plugin runtime, or execution backend. Measurements and scaling analyses enter only as external artifacts; unverifiable provenance remains visible and blocks promotion.
