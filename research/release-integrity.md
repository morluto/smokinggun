# Footgun release-integrity report

Audit date: 2026-08-05.

## Package contract

The package manifest is footgun@1.0.0. It exposes one executable, footgun, and
ships only the declared build output, pinned grammars, schema assets, skill
assets, lock metadata, README, and license. There is no lifecycle installer
and no implicit skill mutation during npm installation.

grammar.lock.json records each grammar repository, revision, npm source
version, generated WASM digest, ABI, and language aliases. Release verification
recomputes every digest and checks that the generated CLI entry point is
executable.

## Local evidence

The current verifier reports:

- 130 packed files;
- 2,219,742 compressed bytes;
- 26,042,153 unpacked bytes;
- no implicit installer, source map, test artifact, node_modules path, or
  undeclared package payload; and
- all 14 pinned grammars present.

The packed tarball was published to a temporary local Verdaccio registry and
installed into a consumer directory outside the checkout. npm install twice,
npm exec, offline npm exec, global installation, scanner listing, doctor, and
skill installation all succeeded; doctor loaded all 14 grammars.

## Skill installation

footgun skill install is explicit, validates bundled files and symlink
boundaries, refuses an existing destination unless --force is supplied,
supports dry runs, backs up the exact destination before replacement, writes
through a temporary directory, and verifies the installed digest. Failure
handling restores the backup when replacement cannot complete.

## External release gate

Trusted npm publishing, registry freshness, and hosted Linux/macOS/Windows
validation remain release-environment operations. They are intentionally not
represented as successful local evidence.
