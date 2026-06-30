# Proof-of-Data Handoff (spec §25)

Part 1 deliberately stops before ZK. Its job is to leave a stable, replayable
data substrate that the next phase can bind proofs to. Every answer carries:

```
contextCapsuleId
sourceRoot
factsRoot
compositeRoot
adapterSetHash
sourceRecordIds
semanticFactIds
```

## How roots are derived (`@sefi/context-capsules`)

```
sourceRoot     = merkle_root(sorted(sourceRecord.responseHash))
factsRoot      = merkle_root(sorted(fact.rawHash))
adapterSetHash = sha256(sorted(distinct adapterHash).join("|"))
compositeRoot  = sha256(sourceRoot | factsRoot | adapterSetHash)
```

Hashes are `0x`-prefixed sha256 over **canonical** JSON (recursively
key-sorted), so equal data always yields equal roots.

## Replay / verification (spec §20.4)

Given a capsule id, load its source records and facts, recompute the three roots
and confirm they match the stored capsule:

```bash
DATABASE_URL=... pnpm replay <capsuleId>
```

`verifyCapsule()` returns `{ sourceRootOk, factsRootOk, compositeRootOk, ok }`.

## Future use

```
public input : compositeRoot
private input: thresholds, hidden policy, hidden strategy
proof        : "the multi-protocol policy evaluated to ALLOWED over this context"
```

Because source records inline the raw response + ledger sequence, the proof
layer can bind to the exact data used — no re-indexing required.

## Security boundary (spec §22)

Part 1 claims only: **source-backed**, **capsule-backed**, **auditable**,
**replayable**. It does not claim ZK-verification. Agents answer / recommend
only; they never execute transactions.
